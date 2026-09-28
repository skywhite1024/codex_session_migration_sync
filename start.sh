#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

if ! command -v cargo >/dev/null 2>&1 && [[ -x "$HOME/.cargo/bin/cargo" ]]; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi

pnpm_dir="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback"
if ! command -v pnpm >/dev/null 2>&1 && [[ -x "$pnpm_dir/pnpm" ]]; then
  export PATH="$pnpm_dir:$PATH"
fi

for tool in cargo pnpm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf '无法找到 %s，请先按 README 安装运行依赖。\n' "$tool" >&2
    exit 1
  fi
done

exec pnpm tauri dev "$@"
