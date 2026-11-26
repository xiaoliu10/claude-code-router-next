//! Native commands are restricted to the two trusted local control-center views.
use crate::{
    quota::{QuotaService, QuotaSnapshot},
    tray,
};
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[cfg(not(target_os = "macos"))]
use tauri::{PhysicalPosition, PhysicalSize};

#[cfg(target_os = "macos")]
tauri_nspanel::tauri_panel! {
    panel!(QuotaPanel {
        config: {
            can_become_key_window: true,
            can_become_main_window: false,
            is_floating_panel: true
        }
    })
}

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
    let _window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("quota.html".into()))
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
    #[cfg(target_os = "macos")]
    configure_macos_spaces(&_window)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn configure_macos_spaces(window: &WebviewWindow) -> tauri::Result<()> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{
        NSStatusWindowLevel, NSWindowCollectionBehavior as Behavior, NSWindowStyleMask,
    };
    use tauri_nspanel::WebviewWindowExt;

    let Some(_main_thread) = MainThreadMarker::new() else {
        return Err(tauri::Error::FailedToReceiveMessage);
    };
    let panel = window.to_panel::<QuotaPanel>()?;
    panel
        .set_style_mask(NSWindowStyleMask::NonactivatingPanel)
        .map_err(std::io::Error::other)?;
    panel.set_hides_on_deactivate(false);

    // Keep the popup with the menu bar across Spaces, including another app's
    // native full-screen Space. The ordinary control-center window is unaffected.
    panel.set_collection_behavior(
        Behavior::CanJoinAllSpaces | Behavior::IgnoresCycle | Behavior::FullScreenAuxiliary,
    );
    panel.as_panel().setLevel(NSStatusWindowLevel);
    Ok(())
}
/// Clamp physical popup geometry to the work area; small monitors shrink the
/// popup, and negative monitor origins remain valid. Prefer below the tray.
#[cfg(any(test, not(target_os = "macos")))]
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
pub fn show(app: &tauri::AppHandle, _rect: tauri::Rect) {
    let Some(window) = app.get_webview_window(LABEL) else {
        return;
    };
    #[cfg(target_os = "macos")]
    show_macos_popup(&window);
    #[cfg(not(target_os = "macos"))]
    {
        position_popup(&window, _rect);
        let _ = window.show();
        let _ = window.set_focus();
    }
    spawn_dismiss_watch(app.clone());
}

#[cfg(not(target_os = "macos"))]
fn position_popup(window: &WebviewWindow, rect: tauri::Rect) {
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
}

#[cfg(target_os = "macos")]
fn show_macos_popup(window: &WebviewWindow) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSEvent, NSScreen};
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    use tauri_nspanel::ManagerExt;

    let Some(main_thread) = MainThreadMarker::new() else {
        return;
    };
    let Ok(panel) = window.app_handle().get_webview_panel(LABEL) else {
        return;
    };
    // AppKit mouse and screen coordinates are both in global points. The tray
    // event rectangle uses pixels and may use a different display's scale.
    let cursor = NSEvent::mouseLocation();
    let screens = NSScreen::screens(main_thread);
    let screen = screens.iter().find(|screen| {
        let frame = screen.frame();
        cursor.x >= frame.origin.x
            && cursor.x < frame.origin.x + frame.size.width
            && cursor.y >= frame.origin.y
            && cursor.y < frame.origin.y + frame.size.height
    });
    if let Some(screen) = screen {
        let work = screen.visibleFrame();
        let width = WIDTH.min(work.size.width);
        let height = HEIGHT.min(work.size.height);
        let x =
            (cursor.x - width / 2.0).clamp(work.origin.x, work.origin.x + work.size.width - width);
        let y = (cursor.y - 12.0 - height)
            .clamp(work.origin.y, work.origin.y + work.size.height - height);
        panel.as_panel().setFrame_display(
            NSRect::new(NSPoint::new(x, y), NSSize::new(width, height)),
            false,
        );
    }
    // Tauri's set_focus activates the application, which can switch Spaces.
    panel.show_and_make_key();
}

/// Blur-based dismissal relies on `WindowEvent::Focused(false)`, which macOS
/// only fires if the panel actually became key. Activation can be silently
/// declined, leaving a stuck panel. The watchdog hides the panel after it
/// loses focus or fails to acquire focus within the grace period. On macOS
/// a focus retry would activate the app and can move it out of the current
/// Space. Idempotent with the Focused(false) handler.
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
            // Give the OS one final chance to grant focus before hiding an
            // unfocused panel. Only retry explicitly on non-macOS targets.
            if !refocused && shown.elapsed() >= std::time::Duration::from_millis(4000) {
                refocused = true;
                #[cfg(not(target_os = "macos"))]
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
