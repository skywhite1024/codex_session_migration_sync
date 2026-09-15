# codex_session_migration_sync

跨设备迁移 / 同步 OpenAI Codex CLI 会话的桌面工具：在机器 A 上勾选对话导出 zip，用网盘、QQ、微信或邮件传到机器 B，导入后 `codex resume <session_id>` 直接续聊。

面向"两台电脑来回切换项目"的场景，重点解决原版工具在真实多设备使用中的几个痛点：**项目路径不一致、导入的对话不出现在列表、担心覆盖本机已有对话**。

> 本项目基于 [Red-noblue/CodexRelay](https://github.com/Red-noblue/CodexRelay) 二次开发，在其导出/导入框架之上增加了跨设备路径重绑、会话索引登记和更安全的导入策略。原项目与 OpenAI 无官方关系，本项目同样如此。

## 核心特性

- **导出 / 导入 zip**：勾选任意会话打包（单会话一个 zip，或合并成一个 batch zip），微信 / 网盘 / 邮件 / AirDrop 均可传输
- **跨设备路径重绑（本项目新增）**：两台机器项目绝对路径不一致时，导入时把 A 机旧路径前缀自动替换为 B 机新路径，`resume` 后 agent 在正确目录工作；前端支持图形化配置多条映射、"选文件夹"按钮
- **会话索引登记（本项目新增）**：导入后自动追加到 `session_index.jsonl`，重启 Codex 后导入的对话直接出现在列表里，不必每次手敲 `resume <id>`
- **纯追加，绝不删本机对话**：导入是追加式写入；同 ID 内容分叉时自动换新 ID，两条都能 resume，不会为了"完全一致"而删掉 B 机独有的对话
- **本地 vault**：每次导入 / 导出 / 恢复都留档，支持历史版本回滚，不怕手滑
- **安全护栏**：sha256 + size + session_id 三重校验、zip 大小上限防炸弹、覆盖前自动备份、不打包 auth.json / config.toml、shell 快照只存档不写回

## 工作流

```
机器 A                                    机器 B
─────────                                ─────────
勾选对话 → 导出 zip
                ── 网盘 / QQ / 微信 ──►
                                         导入 zip（预览 → 配路径映射 → 写入）
                                         codex resume <session_id>
```

路径映射示例（A 机 `C:\Users\alex\proj` → B 机 `D:\work\proj`）在导入页"路径重绑"区块填写，留空则不改动。

## 技术栈

Tauri v2 + React + TypeScript + Rust（后端）+ SQLite。支持 macOS / Windows / Linux。

## 开发

```powershell
pnpm install
pnpm tauri dev        # 开发模式
pnpm tauri build      # 构建安装包
```

核心改动见 [`PATH_REBIND.md`](./PATH_REBIND.md)。

## License

MIT。Copyright 归原项目作者（见 [LICENSE](./LICENSE)），二次开发部分同样以 MIT 发布。
