# Ubuntu 修复验证记录

日期：2026-09-22。基于提交 `6adbf45` 的五项迁移风险修复。

## 环境与数据边界

- Ubuntu 22.04.5 LTS，x86_64；原生窗口使用 Xvfb 虚拟显示器。
- Node 22.22.2，pnpm 11.25.0，Rust 1.98.1，WebKitGTK 2.50.4。
- 前端按 `pnpm-lock.yaml` 安装，Rust 按 `Cargo.lock` 构建，未更新项目依赖版本。
- 经用户确认安装 Rust 和 Ubuntu 开发库；没有修改 shell 启动文件。
- Rust 测试使用合成 JSONL 和临时 `CODEX_HOME` / `CODEXRELAY_APP_DATA_DIR`；未操作真实会话、索引或信任配置。
- 测试数据固定；UUID 仅用于隔离临时路径。并发测试由系统调度线程，检查记录保留而不依赖写入顺序。

## 修复与回归覆盖

| 问题 | 修复 | 关键断言 |
|---|---|---|
| Windows 子目录迁移到 Linux | 解析 JSON 字符串，转换匹配路径尾部的分隔符 | 子目录、空格、引号内路径正确；不修改其他文本的反斜杠；保留反向迁移能力 |
| 特殊目标路径破坏 JSON | 使用 `serde_json` 解析与序列化，不手工拼接转义文本 | 双引号、反斜杠、制表符可往返；无改 ID 的路径重绑也拒绝非法 JSON；导入失败不覆盖本机文件 |
| 标题更新截断索引 | 更新标题追加完整记录，读取最新记录进行比较 | 原字节前缀不变；重复标题不追加；外部追加者的记录全部保留 |
| 相同包补填映射无效 | 存在映射时不走相同内容跳过分支，修改前备份 | Recommended/Overwrite 两策略均生效；工作目录信任登记、备份、有效版本哈希/大小、历史恢复一致 |
| Linux 大小写目录混淆 | 按路径语法区分 Windows 与 POSIX | POSIX 区分大小写和字面反斜杠；Windows 保留混合分隔符和大小写兼容；UNC 不混入 POSIX 根目录筛选 |

`verify_rewrite.cjs` 和 `verify_index.cjs` 现在直接运行 Rust 测试，不再验证一份独立的 JavaScript 复刻实现。

## 执行结果

| 检查 | 结果 |
|---|---|
| `pnpm check`（类型检查、前端构建、Rust 测试） | 通过：28 个 Rust 模块测试及 1 个测试入口冒烟，共 29 个 |
| `cargo test --locked` | 同上，全部通过 |
| 路径专项脚本 | 12 个测试通过 |
| 索引专项脚本 | 4 个测试通过 |
| 并发追加专项重复执行 | 30/30 次通过，每次检查 201 条记录 |
| Playwright | 5 个测试通过：4 个目录筛选测试和 1 个六页页面冒烟 |
| `cargo fmt --check`、`git diff --check` | 通过 |
| Tauri Linux debug 构建与 `.deb` 打包 | 通过，未安装该包 |
| 包内原生程序启动 | 从 `.deb` 解包到临时目录，在 Xvfb + 隔离数据目录中启动，WebKitGTK 显示正常，截图确认非演示模式 |

Playwright 指定版本的 Chromium 下载较慢，本轮取消下载，改用本机 Chrome 148.0.7778.167 的独立测试上下文。临时配置继承仓库配置，仅调整配置文件位置相关路径和 `use.channel = "chrome"`，没有修改项目默认浏览器配置。

本轮命令（在仓库根目录执行，PATH 调整仅对相应命令生效）：

```bash
env PATH="$HOME/.cargo/bin:$PATH" CARGO_BUILD_JOBS=4 pnpm check
"$HOME/.cargo/bin/cargo" test --locked --manifest-path "src-tauri/Cargo.toml" --jobs 4
env CARGO="$HOME/.cargo/bin/cargo" node "verify_rewrite.cjs"
env CARGO="$HOME/.cargo/bin/cargo" node "verify_index.cjs"
pnpm exec playwright test --config "/tmp/codex-migration-playwright-PuHOmp/playwright.config.ts"
"$HOME/.cargo/bin/cargo" fmt --manifest-path "src-tauri/Cargo.toml" --all -- --check
git diff --check
env PATH="$HOME/.cargo/bin:$PATH" CARGO_BUILD_JOBS=4 pnpm tauri build --debug --bundles deb --ci
```

临时 Playwright 配置不属于仓库；其他机器具备标准 Playwright Chromium 后可直接执行 `pnpm test:e2e`。原生启动以包内程序为准：普通 `cargo test` 可能重新生成同路径的开发模式二进制，不能把它当作已打包的独立程序。

本轮产物（均为本地生成，不纳入 Git）：

- `src-tauri/target/debug/bundle/deb/codex_session_migration_sync_0.1.7_amd64.deb`
- `test-results/native-smoke.png`
- `test-results/screenshots/`：六页浏览器截图。

## 未通过项与验证边界

严格 `cargo clippy --all-targets --all-features -- -D warnings` 未通过。对照原提交确认有 6 处既有告警，未在本次扩展修改范围：

- `codex.rs`：`unnecessary_sort_by`，1 处。
- `ops.rs`：`useless_borrows_in_formatting`，3 处。
- `session_index.rs` 原有读取函数：`lines_filter_map_ok`，1 处。
- `tests/manifest_harness.rs`：`assertions_on_constants`，1 处。

仅在检查命令中放行上述四类既有 lint 后，其余严格 Clippy 检查通过；仓库中未添加 lint 豁免。

原生截图只证明该 Ubuntu 环境可启动并渲染隔离的空会话列表，不代表真实跨设备迁移验收。尚未进行真实 Windows 导出包 → Ubuntu 导入 → Codex Desktop 重启可见 → 实际续聊的端到端验证，也未在 Windows/macOS 上执行本次修改后的测试。

索引测试验证本地普通文件上的完整记录并发追加；没有宣称可协调外部程序的截断、轮转、部分写入或所有网络文件系统。历史消息中的路径改写不等于跨平台 shell 命令转换。
