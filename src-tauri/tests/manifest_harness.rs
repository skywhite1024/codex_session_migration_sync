//! 集成测试入口（冒烟）。
//!
//! 本仓库的测试以各模块内联单元测试（`#[cfg(test)] mod tests`）为主。这里保留一个
//! 最小的集成测试 target，用来验证：
//! 1. 集成测试可执行文件同样被 build.rs 嵌入了 Common-Controls v6 应用清单
//!    （见 ../build.rs 与 ../app-manifest.rc）——在 Windows 上若缺少清单，测试进程
//!    会在执行任何 Rust 代码前直接报 0xC0000139 (STATUS_ENTRYPOINT_NOT_FOUND)，
//!    连这个最简单的测试都无法运行；
//! 2. 跨 crate 的测试 harness 本身可以正常启动。

#[test]
fn integration_harness_smoke() {
    assert!(true);
}
