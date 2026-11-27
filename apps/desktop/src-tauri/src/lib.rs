// The Windows lib-test executable needs the same Common Controls v6 manifest as
// the app for muda's TaskDialogIndirect import to resolve before tests start.
#[cfg(all(test, windows, target_env = "msvc"))]
#[link(name = "resource", kind = "static", modifiers = "-bundle")]
extern "C" {}

mod api;
mod autostart;
mod control;
mod credentials;
mod general;
mod lifecycle;
mod plugins;
mod popup;
mod projects;
mod providers;
mod quota;
mod settings;
mod tray;
mod update;
mod webview_retry;

use std::sync::Arc;
use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        // Must be first so a second launch never starts another desktop/gateway.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || tray::open_window(&handle));
        }));
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    let app = builder
        .manage(update::UpdateService::default())
        .invoke_handler(tauri::generate_handler![
            autostart::login_start_status,
            autostart::login_start_set,
            popup::quota_snapshot,
            popup::quota_hide,
            popup::quota_open_ui,
            popup::quota_quit,
            quota::codex_service_tier::codex_service_tier_get,
            quota::codex_service_tier::codex_service_tier_set,
            general::general_settings_snapshot,
            general::general_settings_save,
            control::routing_snapshot,
            control::routing_save,
            control::routing_save_groups,
            control::config_reload,
            control::routing_flags,
            control::usage_snapshot,
            control::usage_records,
            control::clients_snapshot,
            control::clients_update,
            projects::projects_snapshot,
            projects::projects_add,
            projects::projects_save,
            projects::projects_takeover,
            projects::projects_delete,
            providers::provider_add,
            providers::provider_get,
            providers::provider_update,
            providers::provider_transformers,
            plugins::plugin_inventory,
            plugins::plugin_catalog,
            plugins::plugin_install,
            plugins::plugin_action,
            credentials::quota_credentials_status,
            credentials::quota_credentials_save,
            lifecycle::service_snapshot,
            lifecycle::service_action,
            update::desktop_update_status,
            update::desktop_update_check,
            update::desktop_update_install
        ])
        .setup(|app| {
            // Both webview/window creations are retried for the
            // no-interactive-desktop case and exit cleanly if retries are
            // exhausted; other setup errors below still propagate and fail
            // fast. The popup must exist first so the main window never sees a
            // missing quota label.
            webview_retry::retry_webview_creation("quota popup window", || {
                popup::install(app.handle())
            });
            webview_retry::retry_webview_creation("main control-center window", || {
                webview_retry::build_main_window(app.handle())
            });
            match settings::ConnectionSettings::from_environment().and_then(|settings| {
                api::AdminClient::new(settings.clone()).map(|client| (settings, client))
            }) {
                Ok((settings, client)) => {
                    app.manage(quota::QuotaService::new(Some(client.clone())));
                    app.manage(control::ControlService::new(Some(client.clone())));
                    app.manage(general::GeneralService::new(Some(client.clone())));
                    app.manage(projects::ProjectsService::new(Some(client.clone())));
                    app.manage(providers::ProvidersService::new(Some(client.clone())));
                    app.manage(plugins::PluginsService::new(Some(client.clone())));
                    app.manage(credentials::CredentialsService::new(Some(client.clone())));
                    let resources = app.path().resource_dir().ok();
                    let bundle = lifecycle::RuntimeBundle::detect(resources.as_deref());
                    let controller =
                        tray::Controller::install(app.handle(), settings, client, bundle)?;
                    app.manage(Arc::clone(&controller));
                    controller.start();
                    // The local control center is valid regardless of gateway
                    // state (it shows the live service status), so show it once.
                    let handle = app.handle().clone();
                    let _ = app.run_on_main_thread(move || tray::open_window(&handle));
                }
                Err(e) => {
                    app.manage(quota::QuotaService::new(None));
                    app.manage(control::ControlService::new(None));
                    app.manage(general::GeneralService::new(None));
                    app.manage(projects::ProjectsService::new(None));
                    app.manage(providers::ProvidersService::new(None));
                    app.manage(plugins::PluginsService::new(None));
                    app.manage(credentials::CredentialsService::new(None));
                    eprintln!("Invalid CCR connection settings: {e}");
                    tray::install_offline(app.handle(), e.clone())?;
                    if let Some(window) = app.get_webview_window("main") {
                        let _ =
                            window.set_title(&format!("CCR Desktop — configuration error: {e}"));
                        let _ = window.show();
                    }
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == popup::LABEL {
                match event {
                    tauri::WindowEvent::Focused(false) => {
                        let _ = window.hide();
                    }
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        let _ = window.hide();
                        api.prevent_close();
                    }
                    _ => {}
                }
                return;
            }
            // Closing the main control-center window ends the desktop. The exit
            // hook below stops a desktop-owned gateway; an external gateway is
            // never stopped.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                window.app_handle().exit(0);
            }
        })
        .build(tauri::generate_context!());
    match app {
        Ok(app) => app.run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(controller) = app.try_state::<Arc<tray::Controller>>() {
                    controller.stop();
                }
            }
        }),
        Err(e) => {
            eprintln!("Could not start CCR Desktop: {e}");
            // Surface fatal startup errors to launchers/automation.
            std::process::exit(1);
        }
    }
}
