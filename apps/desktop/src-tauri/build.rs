fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "quota_snapshot",
            "quota_hide",
            "quota_open_ui",
            "quota_quit",
            "routing_snapshot",
            "routing_save",
            "routing_flags",
            "usage_snapshot",
            "clients_snapshot",
            "clients_update",
            "service_snapshot",
            "service_action",
        ]),
    ))
    .expect("desktop build failed");
}
