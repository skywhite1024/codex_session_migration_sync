# Windows EXE

## 直接使用

- `CodexRelay-0.1.8-windows-x64.exe`：直接双击运行，不需要启动终端或安装 Node、pnpm、Rust。
- `CodexRelay-0.1.8-windows-x64-setup.exe`：安装到当前用户，提供开始菜单入口和卸载入口。
- 两个版本功能相同。直接运行版是免安装程序，数据仍保存在用户目录，不是“所有数据跟随 EXE”的便携版。
- 需要 Windows x64 和系统 WebView2 Runtime。直接运行版要求已经安装 WebView2；安装版在缺少时联网下载。已安装时复用，不重复捆绑浏览器内核。
- 导入后登记到 Codex Desktop 仍需要当前设备的 Codex 可执行程序；安装包不附带 Codex、账号或对话。

## 数据和资源占用

沿用原来的应用标识和数据目录 `%APPDATA%\com.codexsessionmigrationsync.desktop`，现有存档库和设置继续可用。Codex 会话仍按设置中的 CODEX_HOME 定位。

发布版嵌入前端静态资源，没有 Vite 开发服务器、Rust 文件监听或终端常驻。窗口关闭后程序退出；未增加开机自启、托盘或后台服务。

Rust 发布构建使用体积优化、Thin LTO 和符号剥离；安装包使用 LZMA 压缩。保留错误清理机制和现有迁移功能。内存包括 WebView2 子进程，会随预览内容、会话数量和大文件操作变化，EXE 大小不代表内存占用。

存档库会保存迁移包和覆盖前备份，属于用户数据，不属于安装程序体积；可在应用设置查看占用并按需清理。

## 在源码目录打包

构建电脑需要 README 中的 Windows 开发依赖，使用者不需要安装这些工具。

```powershell
pnpm install --frozen-lockfile
pnpm build:windows
```

输出：`artifacts/windows/0.1.8/`，包含两个 EXE、此说明和 SHA256 校验文件。编译中间文件留在 `src-tauri/target/`（或指定的 CARGO_TARGET_DIR），无需分发。

当前构建未配置代码签名；是否信任程序请核对来源和 SHA256，不要关闭系统安全防护。没有发布 GitHub Release 时，应用的更新检查可能提示未找到发行版。

## 0.1.8 本机验证

- 直接运行版 12.59 MiB，NSIS 安装包 5.14 MiB；安装包完整性校验通过。
- 将单个 EXE 复制到源码目录外，在独立 CODEX_HOME 和应用数据目录中启动，确认图形界面、版本号、原生会话列表读取和数据库完整性正常。运行目录只有 EXE。
- 42 个 Rust 单元测试通过（另有 1 个需要隔离 Codex 环境的测试默认忽略）。未在本轮完整安装/卸载安装包，也未重新操作真实会话进行迁移。
- 单个小测试会话、前台窗口的 10 秒采样：包括全部 WebView2 子进程，私有内存约 226 MiB，工作集加总约 437 MiB（包含共享页，不能等同于独占物理内存）；CPU 约 0.39 个逻辑核心。此为本机现场观测，受 WebView2、驱动及桌面环境影响，不代表所有设备或大文件操作。
- 关闭 GPU 的对照试验未明显改善 CPU，未将试验参数加入发布配置。体积优化与内存优化是不同指标，不以 EXE 体积推断运行内存。

技术参考：[Tauri 体积优化](https://v2.tauri.app/concept/size/)、[Windows 安装包与 WebView2](https://v2.tauri.app/distribute/windows-installer/)。
