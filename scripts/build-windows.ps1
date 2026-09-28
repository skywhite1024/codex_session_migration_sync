[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Build this package on Windows.' }
$repoDir = Split-Path -Parent $PSScriptRoot
$previousTarget = $env:CARGO_TARGET_DIR
Push-Location $repoDir
try {
    foreach ($tool in @('pnpm', 'cargo', 'rustc')) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Missing build tool: $tool" }
    }
    $hostLine = (& rustc -vV | Select-String '^host: ').ToString()
    if ($LASTEXITCODE -ne 0 -or $hostLine -notmatch 'x86_64-pc-windows-msvc') {
        throw 'This script produces Windows x64 packages and requires x86_64-pc-windows-msvc.'
    }
    if ($env:CARGO_BUILD_TARGET) { throw 'Unset CARGO_BUILD_TARGET before running this native Windows x64 build.' }
    $targetDir = if ($previousTarget) { [IO.Path]::GetFullPath($previousTarget) } else { Join-Path $repoDir 'src-tauri\target' }
    $env:CARGO_TARGET_DIR = $targetDir
    & pnpm tauri build --bundles nsis
    if ($LASTEXITCODE -ne 0) { throw "Tauri build failed ($LASTEXITCODE)." }

    $version = (Get-Content -LiteralPath (Join-Path $repoDir 'package.json') -Raw | ConvertFrom-Json).version
    $outputDir = Join-Path $repoDir "artifacts\windows\$version"
    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
    $exe = Join-Path $targetDir 'release\codexrelay.exe'
    $installer = Join-Path $targetDir "release\bundle\nsis\codex_session_migration_sync_${version}_x64-setup.exe"
    foreach ($file in @($exe, $installer)) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Build artifact missing: $file" }
    }
    $portable = Join-Path $outputDir "CodexRelay-${version}-windows-x64.exe"
    $setup = Join-Path $outputDir "CodexRelay-${version}-windows-x64-setup.exe"
    Copy-Item -LiteralPath $exe -Destination $portable -Force
    Copy-Item -LiteralPath $installer -Destination $setup -Force
    $sums = foreach ($file in @($portable, $setup)) {
        $stream = [IO.File]::OpenRead($file)
        $sha256 = [Security.Cryptography.SHA256]::Create()
        try {
            $hash = [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
        } finally {
            $sha256.Dispose()
            $stream.Dispose()
        }
        "$hash  $([IO.Path]::GetFileName($file))"
    }
    $sums | Set-Content -LiteralPath (Join-Path $outputDir 'SHA256SUMS.txt') -Encoding ascii
    Copy-Item -LiteralPath (Join-Path $repoDir 'docs\WINDOWS_EXE.md') -Destination (Join-Path $outputDir 'README.md') -Force
    Get-Item -LiteralPath $portable, $setup | Select-Object Name, @{Name='MiB';Expression={[math]::Round($_.Length / 1MB, 2)}}, FullName
} finally {
    $env:CARGO_TARGET_DIR = $previousTarget
    Pop-Location
}
