//! The local main window confirms a version. All release metadata stays in Rust.
use crate::{popup, tray};
use serde::Serialize;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, EventTarget, Manager, WebviewWindow};
use tauri_plugin_updater::{Error, Update, UpdaterExt};
use tokio::sync::{Mutex, MutexGuard};

const TARGET: &str = "windows-x86_64-nsis";
const FEED: &str = "https://github.com/xiaoliu10/claude-code-router-next/releases/latest/download/desktop-update.json";
const DOWNLOAD_BASE: &str =
    "https://github.com/xiaoliu10/claude-code-router-next/releases/download/";
const CHECK_FAILED: &str = "UPDATE_CHECK_FAILED";
const SIGNATURE_INVALID: &str = "UPDATE_SIGNATURE_INVALID";
const VERSION_CHANGED: &str = "UPDATE_VERSION_CHANGED";
const PROGRESS_EVENT: &str = "desktop-update-progress";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    current_version: String,
    supported: bool,
}
#[derive(Default, Serialize)]
pub struct Offer {
    version: Option<String>,
    notes: Option<String>,
}
#[derive(Clone, Copy, Serialize)]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
    phase: &'static str,
}

/// The lock spans each operation. Failed re-checks clear previous offers and installation
/// consumes its offer before the first await, including on cancellation or verification failure.
#[derive(Default)]
pub struct UpdateService(Mutex<Option<Update>>);
impl UpdateService {
    fn exclusive(&self) -> Result<MutexGuard<'_, Option<Update>>, &'static str> {
        self.0.try_lock().map_err(|_| "UPDATE_BUSY")
    }
}

fn supported(app: &AppHandle) -> bool {
    cfg!(all(windows, target_arch = "x86_64"))
        && tauri::utils::platform::bundle_type() == Some(tauri::utils::config::BundleType::Nsis)
        && app
            .config()
            .plugins
            .0
            .get("updater")
            .and_then(|u| u["pubkey"].as_str())
            .is_some_and(|s| !s.trim().is_empty())
}

#[tauri::command]
pub fn desktop_update_status(window: WebviewWindow) -> Result<Status, String> {
    popup::guard_main(&window)?;
    let app = window.app_handle();
    Ok(Status {
        current_version: app.package_info().version.to_string(),
        supported: supported(app),
    })
}

fn guard_update(window: &WebviewWindow) -> Result<(), String> {
    popup::guard_main(window)?;
    if supported(window.app_handle()) {
        Ok(())
    } else {
        Err("UPDATE_UNSUPPORTED".into())
    }
}

// The official check() collapses every unsuccessful HTTP status into ReleaseNotFound.
// Read the fixed asset once to distinguish a missing feed, then let the plugin apply its
// native version, target and signed-version checks to exactly those bytes via restore_update.
async fn read_feed(client: &reqwest::Client, url: &str) -> Result<serde_json::Value, &'static str> {
    let mut response = client.get(url).send().await.map_err(|_| CHECK_FAILED)?;
    match response.status() {
        reqwest::StatusCode::NOT_FOUND => return Err("UPDATE_FEED_UNAVAILABLE"),
        reqwest::StatusCode::OK => (),
        _ => return Err(CHECK_FAILED),
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| CHECK_FAILED)? {
        if bytes.len() + chunk.len() > 256 * 1024 {
            return Err(CHECK_FAILED);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| CHECK_FAILED)
}

fn checked_update(
    updater: &tauri_plugin_updater::Updater,
    manifest: serde_json::Value,
) -> Result<Option<Update>, &'static str> {
    let platform = &manifest["platforms"][TARGET];
    let version = manifest["version"].as_str().ok_or(CHECK_FAILED)?;
    semver::Version::parse(version).map_err(|_| CHECK_FAILED)?;
    let url = platform["url"].as_str().ok_or(CHECK_FAILED)?;
    let (tag, asset) = url
        .strip_prefix(DOWNLOAD_BASE)
        .and_then(|path| path.split_once('/'))
        .ok_or(CHECK_FAILED)?;
    if !tag
        .strip_prefix('v')
        .is_some_and(|v| semver::Version::parse(v).is_ok())
        || asset != format!("CCR-Desktop_{version}_x64-setup.exe")
    {
        return Err(CHECK_FAILED);
    }
    if platform["signature"]
        .as_str()
        .is_none_or(|s| s.trim().is_empty())
    {
        return Err(SIGNATURE_INVALID);
    }
    updater.restore_update(manifest).map_err(|_| CHECK_FAILED)
}

#[tauri::command]
pub async fn desktop_update_check(
    window: WebviewWindow,
    service: tauri::State<'_, UpdateService>,
) -> Result<Offer, String> {
    guard_update(&window)?;
    let mut slot = service.exclusive()?;
    *slot = None;
    let client = reqwest::Client::builder()
        .https_only(true)
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| CHECK_FAILED)?;
    let manifest = read_feed(&client, FEED).await?;
    let app = window.app_handle().clone();
    let updater = app
        .updater_builder()
        .target(TARGET)
        .version_comparator(|current, release| release.version.cmp_precedence(&current).is_gt())
        .configure_client(|c| {
            c.https_only(true)
                .connect_timeout(Duration::from_secs(30))
                .read_timeout(Duration::from_secs(60))
        })
        // ShellExecute can still fail. Keep the window and tray available to report that
        // failure and restore service. Windows reclaims resources on the plugin's exit(0).
        .on_before_exit(|| {})
        .build()
        .map_err(|_| CHECK_FAILED)?;
    *slot = checked_update(&updater, manifest)?;
    Ok(slot
        .as_ref()
        .map(|u| Offer {
            version: Some(u.version.clone()),
            notes: u.body.clone(),
        })
        .unwrap_or_default())
}

fn update_error(error: Error, fallback: &'static str) -> &'static str {
    match error {
        Error::Minisign(_)
        | Error::Base64(_)
        | Error::SignatureUtf8(_)
        | Error::SignedVersionMismatch { .. }
        | Error::MissingSignedVersion => SIGNATURE_INVALID,
        _ => fallback,
    }
}

fn take_confirmed(slot: &mut Option<Update>, version: &str) -> Result<Update, &'static str> {
    if slot.as_ref().is_some_and(|u| u.version == version) {
        Ok(slot.take().unwrap())
    } else {
        Err(VERSION_CHANGED)
    }
}

async fn download_verified(
    update: &Update,
    mut emit: impl FnMut(Progress),
) -> Result<Vec<u8>, &'static str> {
    let mut downloaded = 0;
    let mut last = None;
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                if last.is_none_or(|t: Instant| t.elapsed() >= Duration::from_millis(150))
                    || total == Some(downloaded)
                {
                    emit(Progress {
                        downloaded,
                        total,
                        phase: "downloading",
                    });
                    last = Some(Instant::now());
                }
            },
            || {},
        )
        .await
        .map_err(|e| update_error(e, "UPDATE_DOWNLOAD_FAILED"))?;
    emit(Progress {
        downloaded,
        total: Some(downloaded),
        phase: "installing",
    });
    Ok(bytes)
}

#[tauri::command]
pub async fn desktop_update_install(
    window: WebviewWindow,
    service: tauri::State<'_, UpdateService>,
    version: String,
) -> Result<(), String> {
    guard_update(&window)?;
    let mut slot = service.exclusive()?;
    let update = take_confirmed(&mut slot, &version)?;
    let emit = |progress| {
        let _ = window.emit_to(
            EventTarget::webview_window("main"),
            PROGRESS_EVENT,
            progress,
        );
    };
    let bytes = download_verified(&update, emit).await?;
    let install = move || {
        update
            .install(bytes)
            .map_err(|e| update_error(e, "UPDATE_INSTALL_FAILED").to_string())
    };
    match window.app_handle().try_state::<Arc<tray::Controller>>() {
        Some(controller) => controller.install_verified_update(install).await,
        None => tauri::async_runtime::spawn_blocking(install)
            .await
            .map_err(|_| "UPDATE_INSTALL_FAILED")?,
    }
}

#[cfg(test)]
mod tests;
