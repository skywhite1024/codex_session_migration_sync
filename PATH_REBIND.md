# 本地改造说明：导入时路径重绑（Path Rebind）

本 fork 在原版 Codex_Relay（导出/导入 zip + vault）基础上，增加了**导入时把 A 机旧项目路径前缀替换为 B 机新路径**的能力，解决两台设备绝对路径不一致时 `codex resume` 后 cwd 指向错误目录的问题。

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `src-tauri/src/path_rewrite.rs` | 新增。路径重绑核心模块（规范化、边界保护、JSON 转义双形式匹配、流式改写 rollout，内含 5 个 Rust 单元测试） |
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
- Windows 路径直接写原样（`\`），模块内部自动同时处理 JSON 转义形式（`\\`）。
- `from` 必须是绝对路径；相对路径 / 空值会被拒绝。

### 边界保护（为什么不会误伤）

- `from = C:\proj` 不会把 `C:\proj-other` 改成新路径——命中后要求下一个字符是 `/`、`\`、`"`、空格、行尾或 `.`，避免"前缀撞名"。
- `from` 结尾的斜杠会被自动归一化。

### 与"导入为新会话"的配合

如果本机已有同 session_id 的分叉对话，原策略会换新 ID 导入。改造后，换 ID 和路径重绑在同一次流式遍历里完成，不会二次读写大文件。

## 测试

- Rust 侧：`path_rewrite.rs` 内置 5 个单元测试（空 from 拒绝、cwd 重写、撞名不误伤、POSIX 路径、端到端改 ID+cwd），在有 Rust 工具链的机器上跑：
  ```
  cargo test --manifest-path src-tauri/Cargo.toml path_rewrite
  ```
- 无 Rust 环境时的等价逻辑验证（本仓库根目录）：
  ```
  node verify_rewrite.cjs   # 9 个行为用例，全过
  ```
- 前端类型检查：`pnpm install && pnpm exec tsc --noEmit`（已通过）。

## 未做的事（边界）

- ~~前端 GUI 面板没加~~ **已完成**：导入页"导入选项"里新增「路径重绑（跨设备可选）」区块，可动态增删多条映射，新路径支持"选文件夹"按钮（调系统目录选择器）。留空即不重绑。
- ~~Codex 会话索引不处理~~ **已完成**：实测本机 Codex 的会话列表索引是 `CODEX_HOME/session_index.jsonl`（每行 `{id, thread_name, updated_at}`）。导入/恢复成功后会往这个文件**追加一行**，按 id 去重、绝不删旧行，导入的会话重启 Codex 后直接出现在列表里。
- ~~shell_snapshot.sh 不导入~~ **已完成（保持安全默认）**：bundle 里带的 shell_snapshot.sh 仍只存档到 vault、不写回 CODEX_HOME（避免把 A 机环境变量/密钥带到 B 机）；导入结果现在会明确提示"随包携带、已存档未写回"。
