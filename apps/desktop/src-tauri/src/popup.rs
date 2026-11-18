//! Native commands are restricted to the two trusted local control-center views.
use crate::{
    quota::{QuotaService, QuotaSnapshot},
    tray,
};
use tauri::{
    Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

pub const LABEL: &str = "quota";
const WIDTH: f64 = 440.0;
const HEIGHT: f64 = 620.0;

pub fn trusted_url(url: &reqwest::Url) -> bool {
    let origin = if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    url.as_str() == format!("{origin}/quota.html")
}
fn allowed(label: &str, url: &reqwest::Url) -> bool {
    matches!(label, "quota" | "main") && trusted_url(url)
}
pub(crate) fn guard(window: &WebviewWindow) -> Result<(), String> {
    if window.url().is_ok_and(|url| allowed(window.label(), &url)) {
        Ok(())
    } else {
        Err("This command is restricted to local desktop views".into())
    }
}
pub fn install(app: &tauri::AppHandle) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("quota.html".into()))
        .title("CCR 控制中心")
        .inner_size(WIDTH, HEIGHT)
        .visible(false)
        .decorations(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .on_navigation(trusted_url)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build()?;
    Ok(())
}
/// Clamp physical popup geometry to the work area; small monitors shrink the
/// popup, and negative monitor origins remain valid. Prefer below the tray.
fn placement(
    anchor: (f64, f64, f64, f64),
    work: (f64, f64, f64, f64),
    scale: f64,
) -> (i32, i32, u32, u32) {
    let (left, top, work_width, work_height) = work;
    let width = (WIDTH * scale).min(work_width).max(1.0);
    let height = (HEIGHT * scale).min(work_height).max(1.0);
    let x = (anchor.0 + anchor.2 / 2.0 - width / 2.0).clamp(left, left + work_width - width);
    let y = (anchor.1 + anchor.3).clamp(top, top + work_height - height);
    (
        x.round() as i32,
        y.round() as i32,
        width.floor() as u32,
        height.floor() as u32,
    )
}
pub fn show(app: &tauri::AppHandle, rect: tauri::Rect) {
    let Some(window) = app.get_webview_window(LABEL) else {
        return;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let position = rect.position.to_physical::<f64>(scale);
    let size = rect.size.to_physical::<f64>(scale);
    if let Ok(Some(monitor)) = window.monitor_from_point(position.x, position.y) {
        let work = monitor.work_area();
        let (x, y, width, height) = placement(
            (position.x, position.y, size.width, size.height),
            (
                work.position.x as f64,
                work.position.y as f64,
                work.size.width as f64,
                work.size.height as f64,
            ),
            monitor.scale_factor(),
        );
        let _ = window.set_size(PhysicalSize::new(width, height));
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
    let _ = window.show();
    let _ = window.set_focus();
    spawn_dismiss_watch(app.clone());
}

/// Blur-based dismissal relies on `WindowEvent::Focused(false)`, which macOS
/// only fires if the panel actually became key. Activation can be silently
/// declined (set_focus is best-effort), leaving a permanently stuck panel —
/// so a watchdog polls focus while visible: once focus has been observed,
/// losing it hides the panel; if focus never lands, one re-focus is attempted
/// and a still-unfocused panel is dismissed on its own (it cannot receive Esc
/// or clicks-outside anyway). Idempotent with the Focused(false) handler.
fn spawn_dismiss_watch(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let shown = std::time::Instant::now();
        let mut focused_seen = false;
        let mut refocused = false;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(300));
            let Some(window) = app.get_webview_window(LABEL) else {
                return;
            };
            if !window.is_visible().unwrap_or(false) {
                return;
            }
            if window.is_focused().unwrap_or(false) {
                focused_seen = true;
                continue;
            }
            if focused_seen {
                // Grace for transient focus flickers (native select popups on
                // macOS briefly defocus the webview); hide only once the loss
                // has held across a recheck (~1.5 ticks).
                std::thread::sleep(std::time::Duration::from_millis(450));
                let still = window.is_focused().unwrap_or(false);
                if !still {
                    let _ = window.hide();
                }
                return;
            }
            // One re-focus attempt after 4s without any observed focus; if it
            // lands, the poll keeps watching (poll-based dismissal stays live
            // even when the Focused event path is dead) — the panel hides on
            // the first real focus loss below.
            if !refocused && shown.elapsed() >= std::time::Duration::from_millis(4000) {
                refocused = true;
                let _ = window.set_focus();
                std::thread::sleep(std::time::Duration::from_millis(800));
                if window.is_focused().unwrap_or(false) {
                    focused_seen = true;
                } else {
                    let _ = window.hide();
                    return;
                }
            }
        }
    });
}
#[tauri::command]
pub async fn quota_snapshot(
    window: WebviewWindow,
    service: tauri::State<'_, QuotaService>,
    provider: Option<String>,
) -> Result<QuotaSnapshot, String> {
    guard(&window)?;
    service.snapshot(provider).await
}
#[tauri::command]
pub fn quota_hide(window: WebviewWindow) -> Result<(), String> {
    guard(&window)?;
    if window.label() != LABEL {
        return Ok(());
    }
    window
        .hide()
        .map_err(|_| "Could not hide quota panel".into())
}
#[tauri::command]
pub fn quota_open_ui(window: WebviewWindow) -> Result<(), String> {
    guard(&window)?;
    if window.label() == LABEL {
        let _ = window.hide();
    }
    tray::open_window(window.app_handle());
    Ok(())
}
#[tauri::command]
pub fn quota_quit(window: WebviewWindow) -> Result<(), String> {
    guard(&window)?;
    // The exit hook shuts down only a gateway owned by this desktop.
    window.app_handle().exit(0);
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn both_label_and_exact_local_url_required() {
        let local = if cfg!(windows) {
            "http://tauri.localhost/quota.html"
        } else {
            "tauri://localhost/quota.html"
        };
        assert!(allowed("quota", &local.parse().unwrap()));
        assert!(allowed("main", &local.parse().unwrap()));
        assert!(!allowed("other", &local.parse().unwrap()));
        for url in [
            "http://127.0.0.1:3456/ui/",
            "https://tauri.localhost/quota.html",
            "tauri://evil/quota.html",
            "tauri://localhost/index.html",
            "tauri://localhost/quota.html?remote=1",
            "tauri://localhost/quota.html#x",
        ] {
            assert!(!allowed("quota", &url.parse().unwrap()), "{url}");
            assert!(!allowed("main", &url.parse().unwrap()), "{url}");
        }
    }
    #[test]
    fn geometry_stays_in_work_area_at_all_edges_and_scales() {
        for work in [
            (0.0, 25.0, 1440.0, 875.0),
            (-1920.0, -1080.0, 1920.0, 1080.0),
            (0.0, 0.0, 320.0, 240.0),
        ] {
            for scale in [1.0, 1.5, 2.0] {
                for anchor in [
                    (work.0, work.1, 20.0, 20.0),
                    (work.0 + work.2 - 20.0, work.1 + work.3 - 20.0, 20.0, 20.0),
                ] {
                    let (x, y, w, h) = placement(anchor, work, scale);
                    assert!(x as f64 >= work.0 && y as f64 >= work.1);
                    assert!(
                        x as f64 + w as f64 <= work.0 + work.2
                            && y as f64 + h as f64 <= work.1 + work.3
                    );
                }
            }
        }
        assert_eq!(
            placement((700.0, 0.0, 20.0, 25.0), (0.0, 25.0, 1440.0, 875.0), 1.0),
            (490, 25, 440, 620)
        );
    }
}
