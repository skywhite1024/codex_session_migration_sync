fn main() {
    // 关键：让 tauri-build 生成的 winres 资源只包含图标与版本信息，不包含应用清单。
    // 默认情况下 tauri-build 会把 Common-Controls v6 清单放进 winres 资源，而该资源
    // 只链接进主 bin（embed-resource 的 -bins 目标），cargo test 生成的测试可执行文件
    // 拿不到，于是加载 comctl32 v5，缺少 tauri/tao 需要的 v6 入口点
    //（TaskDialogIndirect、SetWindowSubclass 等），测试进程在执行任何 Rust 代码前即报
    // 0xC0000139 (STATUS_ENTRYPOINT_NOT_FOUND)。
    //
    // 下面改用 new_without_app_manifest()，再由 embed-resource::compile_for_everything
    // 把同一份清单（app-manifest.rc）链接进所有可链接产物：主 bin、cdylib，以及内联
    // 单元测试 / 集成测试 / bench / example 的可执行文件。这样主 bin 行为与原版一致，
    // 测试 harness 也具备相同的激活上下文。
    #[cfg(windows)]
    let attributes = tauri_build::Attributes::new()
        .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());

    #[cfg(not(windows))]
    let attributes = tauri_build::Attributes::new();

    tauri_build::try_build(attributes).expect("failed to run tauri-build");

    #[cfg(windows)]
    {
        embed_resource::compile_for_everything("app-manifest.rc", embed_resource::NONE)
            .manifest_required()
            .expect("failed to embed the Windows application manifest");
        println!("cargo:rerun-if-changed=app-manifest.rc");
    }
}
