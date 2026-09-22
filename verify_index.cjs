// 直接运行 Rust 回归测试，避免 JavaScript 复刻逻辑与生产实现漂移。
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const result = spawnSync(process.env.CARGO || "cargo", [
  "test", "--locked", "--manifest-path", path.join(__dirname, "src-tauri/Cargo.toml"),
  "session_index::tests",
], { cwd: __dirname, stdio: "inherit" });
if (result.error) {
  console.error(result.error.message);
  console.error("请安装 Rust，并将 cargo 加入 PATH，或通过 CARGO 指定其完整路径。");
}
process.exit(result.status ?? 1);
