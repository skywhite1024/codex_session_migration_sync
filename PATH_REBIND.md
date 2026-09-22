# 本地改造说明：导入时路径重绑（Path Rebind）

本 fork 在原版 Codex_Relay（导出/导入 zip + vault）基础上，增加了**导入时把 A 机旧项目路径前缀替换为 B 机新路径**的能力，解决两台设备绝对路径不一致时 `codex resume` 后 cwd 指向错误目录的问题。

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `src-tauri/src/path_rewrite.rs` | 路径重绑核心模块（结构化 JSON 改写、跨系统分隔符转换、边界保护、逐行处理 rollout，含 Rust 回归测试） |
| `src-tauri/src/ops.rs` | `ImportParams` / `ImportBundlesParams` 增加可选字段 `path_rewrites`；Overwrite 与 ImportAsNew 两个写入分支都接入重写；`import_bundles` 透传 |
| `src-tauri/src/lib.rs` | 注册 `mod path_rewrite;` |
| `src/lib/types.ts` | 新增 `PathRewrite` 类型，两个导入参数类型同步加字段 |

## 用法

导入时在原参数里多传一个可选字段 `path_rewrites`：

```jsonc
{
  "bundle_path": "C:/Users/you/Downloads/CodexRelay-import-....zip",
  "name": "从 A 机同步",
  "strategy": "recommended",
  "path_rewrites": [
    { "from": "C:\\Users\\alex\\proj", "to": "D:\\work\\proj" }
  ]
}
```

- 不传 / 传 `null`：行为与原版完全一致（向后兼容）。
- 每条规则是"前缀替换"：rollout 第一行 `session_meta.payload.cwd` 和整份对话里出现的旧路径都会被重写。
- Windows 路径直接写原样（`\`），模块先解析 JSON，替换字符串值，再用 `serde_json` 完整转义；目标目录中的双引号、反斜杠等不会破坏 JSON。
- Windows → Linux 会将命中路径的子目录分隔符转换为 `/`；POSIX 路径匹配保留大小写，Windows 源路径支持大小写与 `/`、`\` 混用。
- `cwd`、`path`、`workdir`、`file_path` 按完整路径处理，正文按路径片段处理（支持引号内的空格），不全局替换其他文本的反斜杠。历史命令的 shell 语法不会自动转换。
- `from` 必须是绝对路径；相对路径 / 空值会被拒绝。

### 边界保护（为什么不会误伤）

- `from = C:\proj` 不会把 `C:\proj-other` 改成新路径——命中后要求下一个字符是 `/`、`\`、`"`、空格、行尾或 `.`，避免"前缀撞名"。
- `from` 结尾的斜杠会被自动归一化。

### 与"导入为新会话"的配合

如果本机已有同 session_id 的分叉对话，原策略会换新 ID 导入。改造后，换 ID 和路径重绑在同一次流式遍历里完成，不会二次读写大文件。

## 测试

- Rust 侧覆盖 Windows/POSIX 子目录、特殊字符、边界、正文、非法 JSON 及端到端改 ID+cwd：
  ```
  cargo test --locked --manifest-path "src-tauri/Cargo.toml" path_rewrite
  ```
- 兼容入口直接调用上述 Rust 测试，不再使用可能与生产代码漂移的 JavaScript 复刻算法（需要 `cargo` 在 PATH 中，或设置 `CARGO` 为其完整路径）：
  ```
  node "verify_rewrite.cjs"
  node "verify_index.cjs"
  ```
- 完整检查：`pnpm check`；目录筛选回归与页面冒烟：`pnpm test:e2e`。
- 重复导入相同原始包时，补填路径映射仍会执行重绑；修改前备份，历史记录保存重绑后的内容、大小与哈希，恢复时使用该版本。

## 未做的事（边界）

- ~~前端 GUI 面板没加~~ **已完成**：导入页"导入选项"里新增「路径重绑（跨设备可选）」区块，可动态增删多条映射，新路径支持"选文件夹"按钮（调系统目录选择器）。留空即不重绑。
- ~~Codex 会话索引不处理~~ **已完成**：`CODEX_HOME/session_index.jsonl` 每行包含 `{id, thread_name, updated_at}`。新会话按 id 去重；标题变更追加新记录，读取时以最后一条为准，绝不截断重写旧索引。Desktop 登记仍由 app-server 完成，需要单独检查登记结果。
- ~~shell_snapshot.sh 不导入~~ **已完成（保持安全默认）**：bundle 里带的 shell_snapshot.sh 仍只存档到 vault、不写回 CODEX_HOME（避免把 A 机环境变量/密钥带到 B 机）；导入结果现在会明确提示"随包携带、已存档未写回"。
