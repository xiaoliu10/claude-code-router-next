//! Bounded retry for webview/window creation during setup.
//!
//! On Windows the app can start without an interactive desktop session, for
//! example an Interactive scheduled task launched from an SSH session. In that
//! context WebView2 window creation fails with ERROR_INVALID_WINDOW_HANDLE
//! (HRESULT 0x80070578); the window handle becomes valid once a desktop
//! session is attached. Propagating that failure out of the setup hook makes
//! Tauri panic, which becomes a hard abort under `panic = "abort"`. Instead,
//! each webview/window creation is retried on a bounded schedule and, if no
//! desktop becomes available, the process exits cleanly with a non-zero code
//! so a watchdog can relaunch it later.
use std::time::Duration;
use tauri::{AppHandle, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const MAIN_WINDOW_LABEL: &str = "main";

/// Retry waits between attempts: the first attempt runs immediately, then
/// the six attempts are separated by these five waits, landing at roughly
/// 0s, 2s, 7s, 17s, 37s and 67s (the final attempt starts after ~67s).
const RETRY_DELAYS_SECS: [u64; 5] = [2, 5, 10, 20, 30];

/// Total creation attempts: one immediate attempt plus one per retry delay.
const MAX_ATTEMPTS: usize = RETRY_DELAYS_SECS.len() + 1;

/// Delay before retry `attempt` (zero-based), or `None` once the attempt
/// budget is exhausted and the app should give up.
fn retry_delay(attempt: usize) -> Option<Duration> {
    RETRY_DELAYS_SECS
        .get(attempt)
        .map(|secs| Duration::from_secs(*secs))
}

/// Build the main control-center window. The same local quota.html as the
/// popup, no remote Web UI navigation; navigation and new-window rules mirror
/// the popup so no remote page can load.
pub(crate) fn build_main_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, WebviewUrl::App("quota.html".into()))
        .title("Claude Code Router")
        .inner_size(1200.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .visible(false)
        .on_navigation(crate::popup::trusted_url)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build()
}

/// Run a single webview/window creation step, retrying only that step. The
/// `what` label identifies the window in the logs. On exhaustion the process
/// exits cleanly with a non-zero code rather than returning an error that
/// Tauri would turn into a setup-hook panic/abort.
///
/// Any builder error is treated as potentially transient here. This is safe
/// because a failed build never registers the window label (Tauri inserts it
/// only on the success path), so label-collision and similar permanent
/// errors cannot reach this loop; the realistic inputs are desktop-session
/// and WebView2 environment failures.
pub(crate) fn retry_webview_creation<T>(what: &str, create: impl Fn() -> tauri::Result<T>) -> T {
    // Pre-flight on Windows: a missing WebView2 Runtime makes tauri-runtime-wry
    // show a modal MessageBox before returning an error. In a non-interactive
    // scheduled-task session nobody can dismiss it, which would stall the
    // retry loop. Fail fast with the same clean exit instead. tauri re-exports
    // wry's webview_version(); on Windows it is Err when the runtime is absent.
    #[cfg(windows)]
    if tauri::webview_version().is_err() {
        eprintln!(
            "CCR Desktop cannot start: the WebView2 Runtime is not installed, so \
             the {what} cannot be created. Install the Evergreen WebView2 Runtime \
             and relaunch. Exiting now."
        );
        std::process::exit(1);
    }
    let mut attempt = 0usize;
    loop {
        match create() {
            Ok(value) => return value,
            Err(e) => {
                let Some(delay) = retry_delay(attempt) else {
                    eprintln!(
                        "CCR Desktop could not create the {what} after {MAX_ATTEMPTS} attempts: \
                         {e}. This usually means no interactive desktop session is available \
                         (for example WebView2 ERROR_INVALID_WINDOW_HANDLE, HRESULT 0x80070578). \
                         Exiting now so the launcher or watchdog can retry once an interactive \
                         desktop session is attached."
                    );
                    // Nothing is managed yet at this point in setup, so a
                    // direct process exit has no state to unwind and avoids the
                    // setup-hook panic path entirely.
                    std::process::exit(1);
                };
                eprintln!(
                    "CCR Desktop {what} creation failed on attempt {} of {MAX_ATTEMPTS}: {e}. \
                     Retrying in {}s; webview/window creation failures are often caused by a \
                     missing interactive desktop session.",
                    attempt + 1,
                    delay.as_secs()
                );
                std::thread::sleep(delay);
                attempt += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedule_matches_agreed_retry_timing() {
        assert_eq!(MAX_ATTEMPTS, 6);
        assert_eq!(retry_delay(0), Some(Duration::from_secs(2)));
        assert_eq!(retry_delay(1), Some(Duration::from_secs(5)));
        assert_eq!(retry_delay(2), Some(Duration::from_secs(10)));
        assert_eq!(retry_delay(3), Some(Duration::from_secs(20)));
        assert_eq!(retry_delay(4), Some(Duration::from_secs(30)));
    }

    #[test]
    fn gives_up_after_the_last_retry() {
        // The delay before the final (6th) attempt is index 4; attempt index 5
        // is past the budget and must signal give-up.
        assert_eq!(retry_delay(MAX_ATTEMPTS - 1), None);
        assert_eq!(retry_delay(usize::MAX), None);
    }

    #[test]
    fn total_retry_window_is_about_one_minute() {
        let total: Duration = (0..MAX_ATTEMPTS - 1)
            .map(|attempt| retry_delay(attempt).expect("every retry has a delay"))
            .sum();
        assert_eq!(total, Duration::from_secs(67));
    }
}
