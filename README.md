# codex_session_migration_sync

<div align="center">

**跨设备迁移 / 同步 OpenAI Codex CLI 会话的桌面工具**

在机器 A 勾选对话导出 zip → 网盘 / QQ / 微信 / 邮件传到机器 B → 导入时自动重绑项目路径、登记会话索引，`codex resume` 直接续聊。

![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![tauri](https://img.shields.io/badge/Tauri-v2-24C8DB)
![react](https://img.shields.io/badge/React-18-61DAFB)
![rust](https://img.shields.io/badge/Rust-stable-DEA584)
![license](https://img.shields.io/badge/license-MIT-green)

</div>

> 本项目基于 [Red-noblue/CodexRelay](https://github.com/Red-noblue/CodexRelay) 二次开发，在其导出 / 导入框架之上增加了**跨设备路径重绑、会话索引登记、按项目文件夹批量筛选、真实会话标题展示**。与 OpenAI 无官方关系。

---

## 目录

- [为什么需要它](#为什么需要它)
- [核心特性](#核心特性)
- [工作流](#工作流)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [使用指南](#使用指南)
- [常见问题（启动报错先看这里）](#常见问题启动报错先看这里)
- [国内网络加速（可选）](#国内网络加速可选)
- [项目结构](#项目结构)
- [安全设计](#安全设计)
- [技术栈](#技术栈)
- [致谢与 License](#致谢与-license)

---

## 为什么需要它

在两台电脑之间来回切换同一个 Codex 项目时，原版工具存在三个真实痛点：

1. **项目绝对路径不一致** —— 会话文件里固化了 A 机的启动目录，直接拷到 B 机后 resume，agent 会对着一个不存在的目录执行命令；
2. **导入的对话不出现在 Codex 列表** —— 只拷 rollout 文件而不登记索引，UI 里看不到，只能手敲 `codex resume <id>`；
3. **担心同步把本机已有对话删掉** —— 用户要的是"缺什么补什么"，而不是"镜像成和 A 完全一致"。

本工具逐一解决这三点。

## 核心特性

- **导出 / 导入 zip**：勾选任意会话打包（单会话一个 zip，或多个会话合并成一个 batch zip），微信 / 网盘 / 邮件 / AirDrop 均可传输。
- **跨设备路径重绑**：导入时把 rollout 内 A 机旧路径前缀自动替换为 B 机新路径，resume 后 agent 在正确目录工作；支持多条映射、图形化"选文件夹"、边界保护（`C:\proj` 不会误伤 `C:\proj-other`）。
- **会话索引登记**：导入后自动追加到 `session_index.jsonl`（按 id 去重、纯追加），重启 Codex 后对话直接出现在列表。
- **按项目文件夹批量筛选**：会话列表可按工作目录下拉筛选，或选任意父文件夹一次性筛出其下（含子目录）全部对话，表头全选即可批量导出整个项目。
- **真实标题展示**：直接读取 Codex 的 `thread_name`，列表显示对话标题而不是裸 UUID。
- **纯追加，绝不删本机对话**：导入只增不删；同 ID 内容分叉时自动换新 ID，两条都能 resume，B 机独有会话原样保留。
- **本地 vault 留档**：每次导入 / 导出 / 恢复都存档，支持历史版本回滚。
- **安全护栏**：sha256 + size + session_id 三重校验、zip 大小上限防炸弹、覆盖前自动备份、不打包 `auth.json` / `config.toml`、shell 快照只存档不写回（防止 A 机环境变量泄漏到 B 机）。

## 工作流

```
机器 A                                        机器 B
─────────                                    ─────────
勾选对话（可按文件夹批量筛选）→ 导出 zip
                  ── 网盘 / QQ / 微信 ──►
                                               导入 zip（预览 → 路径重绑 → 写入 + 登记索引）
                                               重启 Codex 看到对话 / codex resume <session_id>
```

路径映射示例：A 机 `C:\Users\alex\proj` → B 机 `D:\work\proj`，在导入页"路径重绑"区块填写；两台机器路径一致则留空。

---

## 环境要求

本项目是 **Tauri v2 桌面应用**，需要同时具备前端（Node/pnpm）和后端（Rust）两套工具链。

| 依赖 | 版本要求 | 说明 |
|---|---|---|
| **Node.js** | ≥ 20.19（推荐 22 LTS） | Vite 7 的最低要求 |
| **pnpm** | ≥ 9（开发使用 11.x） | 包管理器，见下方安装 |
| **Rust** | stable（通过 rustup 安装） | 编译 Tauri 后端 |
| **系统 WebView** | WebView2（Windows）/ WebKitGTK（Linux） | macOS 自带 WKWebView |

### Windows

1. 安装 [Node.js LTS](https://nodejs.org/)（勾选 Add to PATH）。
2. 安装 pnpm（任选其一）：
   ```powershell
   # 方式一：corepack（Node 自带，推荐）
   corepack enable
   corepack prepare pnpm@latest --activate

   # 方式二：npm 全局安装
   npm install -g pnpm
   ```
3. 安装 Rust：下载 [rustup-init.exe](https://rustup.rs/) 运行，默认 `stable-x86_64-pc-windows-msvc`。
4. 安装 **Visual Studio C++ Build Tools**（Rust MSVC 链接器依赖，体积较大但必装）：
   - 下载 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)；
   - 安装时勾选 **"使用 C++ 的桌面开发"（Desktop development with C++）** 工作负载。
5. WebView2 Runtime：Windows 11 / 较新 Win10 自带；若没有，从[这里](https://developer.microsoft.com/microsoft-edge/webview2/)安装 Evergreen Standalone Installer。

### macOS

```bash
# Node 建议用 Homebrew
brew install node
corepack enable

# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Xcode 命令行工具（提供编译器 / 链接器）
xcode-select --install
```

### Linux（以 Ubuntu / Debian 为例）

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo corepack enable

curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Tauri v2 系统依赖
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

> 其他发行版的系统依赖见 Tauri 官方文档：<https://v2.tauri.app/start/prerequisites/>

---

## 快速开始

```powershell
# 1. 克隆后进入目录
git clone <your-fork-url> codex_session_migration_sync
cd codex_session_migration_sync

# 2. 安装前端依赖
pnpm install

# 3. 开发模式运行（会编译 Rust 后端并弹出桌面窗口）
pnpm tauri dev

# 4. 打包成安装包（产物在 src-tauri/target/release/bundle/）
pnpm tauri build
```

可用脚本：

| 命令 | 作用 |
|---|---|
| `pnpm tauri dev` | **日常使用这个**：启动前端 + Rust 后端，弹出桌面窗口，支持热更新 |
| `pnpm dev` | 只起前端网页（http://localhost:5273），**显示的是演示数据，读不到真实会话**，仅用于调界面 |
| `pnpm build` | 类型检查 + 构建前端到 `dist/` |
| `pnpm tauri build` | 构建各平台安装包（Windows: `.msi`/`.exe`，macOS: `.dmg`） |
| `pnpm check` | 前端构建 + `cargo test` |

> 第一次 `pnpm tauri dev` 需要编译几百个 Rust crate，耗时数分钟到十几分钟；之后增量编译只需十几秒。

## 使用指南

### 机器 A：导出

1. `pnpm tauri dev` 打开桌面应用，进入 **会话** 标签；
2. （可选）用顶部"文件夹下拉 / 选文件夹"筛出某个项目的全部对话；
3. 勾选要带走的对话（表头复选框可全选当前筛选结果）；
4. 进入 **导出** 标签，填名称后导出 zip（默认存到下载目录）。

### 传输

用网盘、QQ、微信、邮件、U 盘等任意方式把 zip 发到机器 B。

### 机器 B：导入

1. `pnpm tauri dev` 打开应用，进入 **导入** 标签，选择 zip（可多选）；
2. 填导入名称（会作为 Codex 列表里的标题）；
3. **路径重绑（关键）**：在"路径重绑"区块填一条映射 —— 旧路径填 A 机项目路径，新路径点"选文件夹"选 B 机对应目录；路径一致则留空；
4. 冲突策略选 **推荐（Recommended）**：同 ID 且内容不同会自动改新 ID 导入，不覆盖本机对话；
5. 点导入。完成后**重启 Codex CLI**，对话直接出现在列表；也可复制结果页的 `codex resume <id>` 立即续聊。

---

## 常见问题（启动报错先看这里）

### `pnpm : 无法将"pnpm"项识别为 cmdlet…`

机器没装 pnpm，或装完没重开终端。执行 `corepack enable`（或 `npm i -g pnpm`），然后**关闭并重新打开 PowerShell**。验证：

```powershell
pnpm --version
```

### `failed to run 'cargo metadata' … program not found` / `cargo : 无法将"cargo"项识别…`

没装 Rust，或当前终端是**安装 Rust 之前打开的**（PATH 未刷新）。先装 [rustup](https://rustup.rs/)，然后**重开一个终端**；不想重开就在当前窗口临时执行：

```powershell
$env:PATH="$env:USERPROFILE\.cargo\bin;$env:PATH"
cargo --version   # 能打印版本即正常
pnpm tauri dev
```

### `error: linker 'link.exe' not found`（Windows）

没装 MSVC C++ Build Tools，按 [Windows 环境要求](#windows) 第 4 步安装"使用 C++ 的桌面开发"工作负载。

### `cargo test` 一运行就退出，报 `0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND`（Windows）

这**不是**重启系统或更新 VC 运行库能解决的问题，而是测试可执行文件缺少应用清单（manifest）：tauri/tao 依赖 Common-Controls v6 才导出的 `TaskDialogIndirect`、`SetWindowSubclass` 等入口点，而 tauri-build 默认只把清单嵌进主程序，`cargo test` 生成的测试 harness 拿不到，于是加载到 comctl32 v5，在执行任何 Rust 代码前就崩溃。

本仓库已在构建层根治：`src-tauri/build.rs` 改用 `new_without_app_manifest()` 让 tauri 资源只含图标/版本，再通过 `embed-resource` 的 `compile_for_everything()` 把 `src-tauri/app-manifest.rc`（Common-Controls v6 清单）统一链接进主程序与所有测试可执行文件。因此正常情况下你**不需要任何额外操作**，直接：

```powershell
pnpm check        # = 前端构建 + cargo test
```

若你在自行改造后仍遇到该错误，确认 `src-tauri/app-manifest.rc` 存在、`Cargo.toml` 的 `[build-dependencies]` 里有 `embed-resource`，且 `build.rs` 中调用了 `embed_resource::compile_for_everything(..)`；必要时 `cargo clean` 后重试。

### `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: esbuild`

pnpm 安全策略拦截了 esbuild 的构建脚本。仓库 `pnpm-workspace.yaml` 已声明 `allowBuilds: esbuild: true`；若仍出现，执行：

```powershell
pnpm approve-builds   # 选择 esbuild 允许
```

### `Port 5273 is already in use`

上次的 dev server 没退干净。先清理再启动：

```powershell
# Windows PowerShell
Get-Process codexrelay -ErrorAction SilentlyContinue | Stop-Process -Force
Get-NetTCPConnection -LocalPort 5273 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
pnpm tauri dev
```

### 浏览器打开 http://localhost:5273 只看到 3 条 demo 假数据

这是设计如此：浏览器网页没有权限读取本地 `~/.codex`，只用于调界面。**真实会话必须通过 `pnpm tauri dev` 弹出的桌面窗口查看**。

### 桌面窗口启动后最小化 / 没弹到前台

进程在运行但窗口被最小化时，在任务栏点应用图标即可；开发模式下不要关闭运行 `pnpm tauri dev` 的终端，关了应用会退出。

### 导入后 Codex 列表里还是看不到对话

先确认导入结果页 `indexed=true`，然后**完全退出并重启 Codex CLI**（它只在启动时扫描一次索引）。仍看不到时用 `codex resume <session_id>` 续聊，会话文件本身一定已经写入。

---

## 国内网络加速（可选）

Rust crate 与 rustup 工具链默认走境外源，国内可配置镜像加速。

**cargo crates 镜像**——编辑 `%USERPROFILE%\.cargo\config.toml`（Windows）或 `~/.cargo/config.toml`：

```toml
[source.crates-io]
replace-with = "ustc"

[source.ustc]
registry = "sparse+https://mirrors.ustc.edu.cn/crates.io-index/"
```

**安装 rustup 时指定镜像**（PowerShell）：

```powershell
$env:RUSTUP_DIST_SERVER="https://mirrors.ustc.edu.cn/rust-static"
$env:RUSTUP_UPDATE_ROOT="https://mirrors.ustc.edu.cn/rust-static/rustup"
.\rustup-init.exe -y
```

npm / pnpm 依赖慢时可切换 npmmirror：

```powershell
pnpm config set registry https://registry.npmmirror.com
```

---

## 项目结构

```
codex_session_migration_sync/
├── src/                        # React + TypeScript 前端
│   ├── App.tsx                 # 主界面（会话/导出/导入/历史等标签）
│   └── lib/
│       ├── types.ts            # 前后端共享类型
│       ├── ipc.ts              # Tauri IPC 封装
│       └── webDemo.ts          # 浏览器预览模式的演示数据
├── src-tauri/                  # Rust 后端
│   ├── src/
│   │   ├── codex.rs            # 扫描 ~/.codex/sessions、读取会话元信息与标题
│   │   ├── ops.rs              # 导出 / 导入 / 恢复主流程
│   │   ├── path_rewrite.rs     # 跨设备路径重绑（含边界保护、跨 OS 绝对路径校验）
│   │   ├── session_index.rs    # session_index.jsonl 读取标题 / 追加登记
│   │   ├── bundle.rs           # zip 打包 / 解包与校验
│   │   └── vault.rs            # 本地留档与回滚
│   ├── tests/manifest_harness.rs  # 集成测试冒烟（同时验证测试 exe 的 manifest 注入）
│   ├── app-manifest.rc         # Common-Controls v6 清单资源（build.rs 注入主程序与测试）
│   ├── build.rs                # tauri-build + embed-resource 清单统一注入
│   └── tauri.conf.json
├── pnpm-workspace.yaml         # 已声明允许 esbuild 构建脚本
└── PATH_REBIND.md              # 路径重绑设计说明
```

## 安全设计

- **只读扫描**：列出会话不修改 `CODEX_HOME` 下任何原始文件；
- **导入纯追加**：不删除、不覆盖 B 机独有会话；冲突默认改新 ID 分叉保留；
- **不迁移敏感信息**：打包时排除 `auth.json`、`config.toml`；shell 环境快照只写入 zip 存档，绝不写回 B 机的 `CODEX_HOME`；
- **防 zip-slip**：解包只接受固定白名单文件名，拒绝绝对路径与 `..`；
- **防压缩炸弹**：压缩包与解压后大小均有上限；
- **覆盖前备份**：任何覆盖动作前先把原文件存入本地 vault，可回滚。

## 技术栈

[Tauri v2](https://v2.tauri.app/) · React 18 · TypeScript · Vite · Rust · SQLite（本地留档元数据）。

## 致谢与 License

- 感谢原项目 [Red-noblue/CodexRelay](https://github.com/Red-noblue/CodexRelay) 提供的导出 / 导入框架。
- 本项目以 **MIT** 协议发布，原项目版权归原作者所有（见 [LICENSE](./LICENSE)），二次开发部分同样以 MIT 发布。
