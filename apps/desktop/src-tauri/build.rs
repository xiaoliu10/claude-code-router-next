fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "quota_snapshot",
            "quota_hide",
            "quota_open_ui",
            "quota_quit",
        ]),
    ))
    .expect("desktop build failed");
}
