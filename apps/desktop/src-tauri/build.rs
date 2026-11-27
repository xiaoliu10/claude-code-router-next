fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "login_start_status",
            "login_start_set",
            "quota_snapshot",
            "quota_hide",
            "quota_open_ui",
            "quota_quit",
            "codex_service_tier_get",
            "codex_service_tier_set",
            "general_settings_snapshot",
            "general_settings_save",
            "routing_snapshot",
            "routing_save",
            "routing_save_groups",
            "routing_flags",
            "usage_snapshot",
            "usage_records",
            "clients_snapshot",
            "clients_update",
            "projects_snapshot",
            "projects_add",
            "projects_save",
            "projects_takeover",
            "projects_delete",
            "provider_add",
            "provider_get",
            "provider_update",
            "provider_transformers",
            "plugin_inventory",
            "plugin_catalog",
            "plugin_install",
            "plugin_action",
            "quota_credentials_status",
            "quota_credentials_save",
            "service_snapshot",
            "service_action",
            "config_reload",
            "desktop_update_status",
            "desktop_update_check",
            "desktop_update_install",
        ]),
    ))
    .expect("desktop build failed");

    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        // tauri-winres writes resource.lib here but only links it to Cargo bin targets.
        println!(
            "cargo:rustc-link-search=native={}",
            std::env::var("OUT_DIR").unwrap()
        );
    }
}
