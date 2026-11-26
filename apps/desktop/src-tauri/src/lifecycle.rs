//! Desktop-owned gateway lifecycle.
//!
//! Ownership contract (docs/design/desktop-control-center.md):
//! - A gateway this desktop spawned (owned `Child`) is stopped on quit/main-window
//!   close: graceful SIGTERM first, then a bounded kill. Never a PID-file kill, a
//!   process-name kill, or a global `ccr stop`.
//! - A gateway that was already running (external attach, e.g. a launchd service or
//!   a terminal `ccr start`) is never stopped by this process under any path.
//! - The child handle becomes visible in shared state immediately after spawn (no
//!   await in between), so an exit racing a startup can always find and clean it.
//! - Startup success requires the child to still be alive AND the health endpoint
//!   to answer; a child that died while another process took over the port is
//!   reported as external, never as owned.
use crate::settings::ConnectionSettings;
use serde::{Deserialize, Serialize};
use std::{
    ffi::{OsStr, OsString},
    net::{IpAddr, SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

/// Marker injected into every gateway spawned by the desktop. The CLI/server uses
/// it to reject self-restarting or self-updating routes (`/api/restart` and
/// `/api/update/perform` answer 409) so the desktop-owned `Child` cannot be
/// silently replaced by an unowned process. Older installed CLIs ignore the
/// variable; freshly built bundles always include the guard.
pub const MANAGED_ENV: &str = "CCR_DESKTOP_MANAGED";

/// How long a SIGTERM'd owned gateway has to exit before the bounded SIGKILL.
/// `ccr start` runs the server in the foreground and closes it on SIGTERM, so
/// this bounds quit latency without waiting on long in-flight LLM streams.
pub const TERM_GRACE: Duration = Duration::from_secs(5);

#[derive(Debug, PartialEq)]
pub enum PortState {
    Refused,
    Occupied,
    Unknown,
}

/// Mode reported by `service_snapshot` / `service_action` (exact design DTO).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ServiceMode {
    /// The gateway was spawned by this desktop instance and the child is alive.
    Owned,
    /// A gateway is reachable but this desktop did not start it.
    External,
    /// No gateway is reachable and this desktop holds no live child.
    Stopped,
    /// An owned child is running but has not answered health yet.
    Starting,
    /// The last explicit start attempt failed with a persistent local error.
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceState {
    pub mode: ServiceMode,
    pub running: bool,
    pub message: String,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ServiceAction {
    Start,
    Stop,
}

/// Liveness of the desktop-owned child, derived from the shared launcher slot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OwnedGateway {
    /// Child alive and ready (health answered at least once since spawn).
    Live,
    /// Child alive, still waiting for first successful health answer.
    Starting,
    /// A previously spawned child has exited (restart or crash); the port, if
    /// served at all, now belongs to a process this desktop does not own.
    Exited,
    /// No child is recorded.
    None,
}

pub fn endpoint(base: &str) -> Result<SocketAddr, String> {
    let url = reqwest::Url::parse(base).map_err(|e| e.to_string())?;
    let host = url
        .host_str()
        .ok_or("Missing local host")?
        .trim_matches(['[', ']']);
    let ip: IpAddr = host
        .parse()
        .map_err(|_| "Use a numeric loopback address".to_string())?;
    if url.scheme() != "http" || !ip.is_loopback() {
        return Err("Only local HTTP loopback endpoints are allowed".into());
    }
    Ok(SocketAddr::new(
        ip,
        url.port_or_known_default().ok_or("Missing port")?,
    ))
}

// On Windows, a refused loopback connection can take about two seconds to
// report WSAECONNREFUSED. Keep the two startup probes below the shutdown wait.
#[cfg(windows)]
const PORT_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
#[cfg(not(windows))]
const PORT_PROBE_TIMEOUT: Duration = Duration::from_millis(500);

pub fn probe_port(addr: SocketAddr) -> PortState {
    match TcpStream::connect_timeout(&addr, PORT_PROBE_TIMEOUT) {
        Ok(_) => PortState::Occupied,
        Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => PortState::Refused,
        Err(_) => PortState::Unknown,
    }
}

fn executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn prepend_dirs(
    dirs: impl IntoIterator<Item = PathBuf>,
    inherited: &OsStr,
) -> Result<OsString, String> {
    let mut dirs: Vec<PathBuf> = dirs.into_iter().collect();
    dirs.extend(std::env::split_paths(inherited));
    dirs.extend([PathBuf::from("/usr/bin"), PathBuf::from("/bin")]);
    std::env::join_paths(dirs).map_err(|e| e.to_string())
}

/// A validated on-disk runtime bundle staged by `apps/desktop/scripts/prepare-runtime.mjs`
/// under the app resources (`<resources>/runtime/`).
#[derive(Clone, Debug)]
pub struct RuntimeBundle {
    root: PathBuf,
}

impl RuntimeBundle {
    /// Detects a complete bundle in the resource directory. The desktop has no
    /// installed-CCR fallback: a missing bundle is an explicit setup error.
    pub fn detect(resource_dir: Option<&Path>) -> Option<Self> {
        let root = resource_dir?.join("runtime");
        let bundle = Self { root };
        if executable(&bundle.node()) && bundle.entry().is_file() {
            Some(bundle)
        } else {
            None
        }
    }
    /// Fixed resource launch path: `<resources>/runtime/node` (portable node;
    /// `node.exe` on Windows, where an extension is required to execute).
    pub fn node(&self) -> PathBuf {
        self.root
            .join(if cfg!(windows) { "node.exe" } else { "node" })
    }
    /// Fixed resource entry: `<resources>/runtime/service/entry.cjs` (the
    /// bundled desktop service entry reusing the core runtime directly).
    pub fn entry(&self) -> PathBuf {
        self.root.join("service/entry.cjs")
    }
    // Tauri returns a verbatim resource path on Windows. Node's CommonJS main
    // loader rejects that form in argv. Use the equivalent regular path when
    // it is safe to do so, preserving the parent's cwd and OS path semantics.
    fn launch_command(&self) -> Command {
        let mut command = Command::new(self.node());
        command.arg(dunce::simplified(&self.entry()));
        command
    }
    /// PATH precedence for child processes: bundled `node`/`npm`/`npx` win so
    /// plugin installs use the bundled npm instead of a global one.
    pub fn path_dirs(&self) -> Vec<PathBuf> {
        vec![self.root.join("bin"), self.root.clone()]
    }
}

/// Child PATH for bundled launches: bundle bin/root first, then the inherited
/// environment (preserving the user's HOME-driven tooling), then system dirs.
fn bundled_path(bundle: &RuntimeBundle, inherited: &OsStr) -> Result<OsString, String> {
    prepend_dirs(bundle.path_dirs(), inherited)
}

// Launch only when the installed CLI's own config proves it uses this endpoint.
// A desktop-only URL override is not proof of the CLI's listen port.
fn config_matches(addr: SocketAddr) -> bool {
    let dir = std::env::var_os("CCR_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .map(|h| PathBuf::from(h).join(".claude-code-router"))
        });
    let Some(file) = dir.map(|d| d.join("config.json")) else {
        return false;
    };
    let Ok(raw) = std::fs::read_to_string(file) else {
        return false;
    };
    config_text_matches(&raw, addr, &|name| std::env::var(name).ok())
}

fn config_text_matches<F: Fn(&str) -> Option<String>>(
    raw: &str,
    addr: SocketAddr,
    env: &F,
) -> bool {
    let Ok(config) = json5::from_str::<serde_json::Value>(raw) else {
        return false;
    };
    if !config.is_object() {
        return false;
    }
    // Only PORT/HOST/SERVICE_PORT prove the endpoint. Unresolvable APIKEY or provider
    // placeholders (common for GUI apps launched from Finder) must not block auto-start
    // proof, so they are deliberately ignored here.
    let resolver = |name: &str| {
        if name.starts_with("CCR_DESKTOP_") {
            None
        } else {
            env(name)
        }
    };
    let config_port = match config.get("PORT") {
        None | Some(serde_json::Value::Null) => "3456".to_string(),
        Some(serde_json::Value::String(text)) => {
            match crate::settings::interpolate(text, &resolver) {
                Ok(port) => port,
                Err(_) => return false,
            }
        }
        Some(serde_json::Value::Number(number)) => number.to_string(),
        _ => return false,
    };
    let Ok(mut port) = config_port.parse::<u16>() else {
        return false;
    };
    if port == 0 {
        return false;
    }
    // SERVICE_PORT is a CLI/runtime override, unlike the desktop-only port.
    if let Some(value) = env("SERVICE_PORT") {
        match value.parse::<u16>() {
            Ok(override_port) if override_port != 0 => port = override_port,
            _ => return false,
        }
    }
    let host = match config.get("HOST") {
        None => "127.0.0.1".to_string(),
        Some(serde_json::Value::String(host)) => {
            match crate::settings::interpolate(host, &resolver) {
                Ok(host) => host,
                Err(_) => return false,
            }
        }
        _ => return false,
    };
    let host_matches = host
        .parse::<IpAddr>()
        .map(|ip| ip == addr.ip() || ip.is_unspecified())
        .unwrap_or(false);
    port == addr.port() && host_matches
}

/// Spawns the bundled runtime: portable `<resources>/runtime/node` running the
/// fixed `<resources>/runtime/service/entry.cjs` service entry (core started
/// directly; the `ccr` CLI is never invoked). The spawned child is stored into
/// `slot` synchronously before returning — callers must treat the slot as the
/// single owner of record so an exit racing startup can still clean it up.
/// The launch injects `CCR_DESKTOP_MANAGED=1` and preserves the user's HOME,
/// CCR_CONFIG_DIR, and inherited environment; no config is packaged or written.
/// Spawns the bundled gateway and publishes-or-disposes the child atomically
/// under the slot mutex: the cancel check happens while holding the lock, so a
/// concurrent `stop()` observation is ordered against the spawn. Returns
/// whether the child was published. A spawn that observes cancel stops its own
/// child and publishes nothing — the shutdown path can never miss it.
fn spawn_gateway(
    addr: SocketAddr,
    bundle: &RuntimeBundle,
    slot: &Mutex<Option<Child>>,
    cancel: &AtomicBool,
) -> Result<bool, String> {
    if !config_matches(addr) {
        return Err("Cannot safely auto-start: endpoint does not match a known local CCR config. Configure CCR first.".into());
    }
    // Recheck immediately before launching; never reclaim an occupied port.
    if probe_port(addr) != PortState::Refused {
        return Err("Port became occupied; not starting another gateway".into());
    }
    let path = bundled_path(bundle, &std::env::var_os("PATH").unwrap_or_default())?;
    let mut guard = lock(slot);
    if cancel.load(Ordering::SeqCst) {
        return Ok(false);
    }
    if guard.is_some() {
        return Err("Gateway already owns the launch slot".into());
    }
    let mut child = bundle
        .launch_command()
        .env("PATH", path)
        .env(MANAGED_ENV, "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Could not launch bundled gateway: {e}"))?;
    if cancel.load(Ordering::SeqCst) {
        // Quit won the race; stop the just-spawned child now (graceful, then
        // bounded kill) and publish nothing.
        drop(guard);
        stop_owned_gateway(&mut child);
        return Ok(false);
    }
    if guard.is_none() {
        // Publish the owned child while still holding the lock: any concurrent
        // stop() observation is ordered against this publish.
        *guard = Some(child);
        Ok(true)
    } else {
        // A previous live child owns the slot; never drop it silently.
        drop(guard);
        let _ = child.kill();
        let _ = child.wait();
        Err("Gateway already owns the launch slot".into())
    }
}

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Stops a desktop-owned child: graceful SIGTERM (checked against `try_wait`
/// first, so an exited child is never re-signalled — no PID-reuse kill), a
/// bounded wait, then SIGKILL as the last resort. Returns once the process is
/// gone. Never touches any other process on the system.
pub fn stop_owned_gateway(child: &mut Child) -> bool {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return true;
    }
    #[cfg(unix)]
    {
        let pid = child.id();
        // The immediately preceding try_wait showed the process alive, so the
        // PID is still ours with overwhelming probability; this is the standard
        // handle-based pattern (no stored PID files, no process-name scan).
        let _ = unsafe { libc::kill(pid as libc::c_int, libc::SIGTERM) };
    }
    #[cfg(not(unix))]
    {
        // Windows has no portable graceful-terminate signal; fall through to the
        // bounded kill below.
    }
    let deadline = std::time::Instant::now() + TERM_GRACE;
    while std::time::Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let _ = child.kill();
    child.wait().is_ok()
}

pub struct Startup {
    pub ready: bool,
    pub message: String,
}

/// Connects to the gateway, attaching externally when it already runs, or
/// auto-starting it when the port refuses and the local CCR config proves the
/// endpoint. `cancel` aborts the readiness wait so a quit racing a startup
/// returns promptly; the spawned child stays visible in `launcher_slot` the
/// whole time so the exit path can stop it (no orphaned child).
pub async fn connect_or_launch(
    client: &crate::api::AdminClient,
    settings: &ConnectionSettings,
    cancel: Arc<AtomicBool>,
    launcher_slot: Arc<Mutex<Option<Child>>>,
    bundle: Option<RuntimeBundle>,
) -> Startup {
    if client.health().await {
        return Startup {
            ready: true,
            message: "Connected".into(),
        };
    }
    // Allow an already-starting server a short chance to become ready. This is
    // attach-only: such a gateway was not started here and is never stopped.
    for _ in 0..2 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if cancel.load(Ordering::SeqCst) {
            return Startup {
                ready: false,
                message: "Desktop is shutting down".into(),
            };
        }
        if client.health().await {
            return Startup {
                ready: true,
                message: "Connected".into(),
            };
        }
    }
    let addr = match endpoint(&settings.base_url) {
        Ok(addr) => addr,
        Err(message) => {
            return Startup {
                ready: false,
                message,
            }
        }
    };
    let Some(bundle) = bundle else {
        // Attach-only paths above already ran; reaching here means a spawn is
        // required, and the desktop has no installed-CCR fallback.
        return Startup {
            ready: false,
            message: "Desktop runtime bundle is missing. Run: node apps/desktop/scripts/prepare-runtime.mjs".into(),
        };
    };
    let slot = Arc::clone(&launcher_slot);
    let spawn_cancel = Arc::clone(&cancel);
    let result = tauri::async_runtime::spawn_blocking(move || match probe_port(addr) {
        PortState::Refused => spawn_gateway(addr, &bundle, &slot, &spawn_cancel),
        PortState::Occupied => {
            Err("API unavailable on an occupied port. No process was stopped or replaced.".into())
        }
        PortState::Unknown => Err("Port status unknown; not starting a gateway.".into()),
    })
    .await;
    // Ok(false) = spawn observed a cancel and stopped its own child atomically
    // under the slot lock; treat it like an early shutdown.
    let spawned = match result {
        Ok(Ok(published)) => published,
        Ok(Err(message)) => {
            return Startup {
                ready: false,
                message,
            }
        }
        Err(e) => {
            return Startup {
                ready: false,
                message: e.to_string(),
            }
        }
    };
    let mut exited = false;
    for _ in 0..20 {
        if cancel.load(Ordering::SeqCst) {
            return Startup {
                ready: false,
                message: "Desktop is shutting down".into(),
            };
        }
        if spawned {
            // Success requires the owned child to still be alive AND health to
            // answer. A child that died while another service took the port is
            // external, not owned.
            exited |= poll_exited(&launcher_slot);
        }
        if client.health().await {
            return if exited {
                Startup {
                    ready: true,
                    message: "Connected to an external gateway (the desktop-started process exited; the port is served by another process)".into(),
                }
            } else {
                Startup {
                    ready: true,
                    message: "Connected (gateway was started by this desktop)".into(),
                }
            };
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let slot = Arc::clone(&launcher_slot);
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let mut guard = lock(&slot);
        if let Some(child) = guard.as_mut() {
            stop_owned_gateway(child);
        }
        guard.take();
    })
    .await;
    Startup {
        ready: false,
        message: "Gateway did not become ready. Check the desktop service status and retry Start."
            .into(),
    }
}

/// Marks an exited child and removes it from the slot (reap), preserving the
/// Exited observation for the caller.
fn poll_exited(slot: &Mutex<Option<Child>>) -> bool {
    let mut slot = lock(slot);
    match slot.as_mut() {
        Some(child) => match child.try_wait() {
            Ok(Some(_)) => {
                *slot = None;
                true
            }
            _ => false,
        },
        None => false,
    }
}

/// Pure classifier for the service DTO. `error` is the persisted message of the
/// last failed explicit start attempt; it yields mode `error` only while the
/// gateway stays unreachable and no child is held.
pub fn service_state(owned: OwnedGateway, reachable: bool, error: Option<&str>) -> ServiceState {
    let mode_running_message = |mode: ServiceMode, message: String| ServiceState {
        mode,
        running: matches!(
            mode,
            ServiceMode::Owned | ServiceMode::External | ServiceMode::Starting
        ),
        message,
    };
    match owned {
        OwnedGateway::Live => {
            mode_running_message(ServiceMode::Owned, "Gateway started by this desktop".into())
        }
        OwnedGateway::Starting => mode_running_message(
            ServiceMode::Starting,
            "Waiting for the desktop-started gateway to become ready".into(),
        ),
        OwnedGateway::Exited => {
            if reachable {
                mode_running_message(
                    ServiceMode::External,
                    "A gateway is running, but not the process this desktop started".into(),
                )
            } else {
                ServiceState {
                    mode: ServiceMode::Stopped,
                    running: false,
                    message: "The gateway started by this desktop has exited".into(),
                }
            }
        }
        OwnedGateway::None => {
            if reachable {
                mode_running_message(
                    ServiceMode::External,
                    "Connected to a gateway this desktop did not start".into(),
                )
            } else if let Some(error) = error {
                ServiceState {
                    mode: ServiceMode::Error,
                    running: false,
                    message: error.to_string(),
                }
            } else {
                ServiceState {
                    mode: ServiceMode::Stopped,
                    running: false,
                    message: "Gateway is not running".into(),
                }
            }
        }
    }
}

/// Shared-state snapshot used by the service command. Probes health without
/// holding any lock during the HTTP wait so stop/shutdown can never be blocked
/// by a snapshot in flight.
pub async fn service_state_probe(
    client: &crate::api::AdminClient,
    owned: OwnedGateway,
    error: Option<String>,
) -> ServiceState {
    // An owned live child is running by definition; probing would only delay the
    // answer (and the health wait must never hold a lock that stop needs).
    let reachable = if owned == OwnedGateway::Live {
        true
    } else {
        client.health().await
    };
    service_state(owned, reachable, error.as_deref())
}

// ---------------------------------------------------------------------------
// IPC commands. Self-guarded with the same rules as the popup commands (exact
// window label + exact local URL); the parent wiring adds capability entries.
// ---------------------------------------------------------------------------

fn service_window_guard(window: &tauri::WebviewWindow) -> Result<(), String> {
    crate::popup::guard(window)
}

#[tauri::command]
pub async fn service_snapshot(
    window: tauri::WebviewWindow,
    controller: tauri::State<'_, Arc<crate::tray::Controller>>,
) -> Result<ServiceState, String> {
    service_window_guard(&window)?;
    Ok(controller.service_snapshot().await)
}

#[tauri::command]
pub async fn service_action(
    window: tauri::WebviewWindow,
    controller: tauri::State<'_, Arc<crate::tray::Controller>>,
    action: ServiceAction,
) -> Result<ServiceState, String> {
    service_window_guard(&window)?;
    controller.service_action(action).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_remote_and_accepts_loopback() {
        assert!(endpoint("http://192.168.1.2:3456").is_err());
        assert!(endpoint("https://127.0.0.1:3456").is_err());
        assert!(endpoint("http://[::1]:3456").unwrap().ip().is_loopback());
    }
    #[test]
    fn occupied_non_ccr_port_is_not_refused() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        assert_eq!(
            probe_port(listener.local_addr().unwrap()),
            PortState::Occupied
        );
        let addr = listener.local_addr().unwrap();
        drop(listener);
        assert_eq!(probe_port(addr), PortState::Refused);
    }
    async fn startup_against_mock(
        status: u16,
        count: usize,
    ) -> (Startup, Arc<Mutex<Option<Child>>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        // Keep a duplicate listener alive through the occupied-port safety probe.
        let held_listener = listener.try_clone().unwrap();
        let worker = std::thread::spawn(move || {
            for _ in 0..count {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut request = [0; 4096];
                let _ = socket.read(&mut request).unwrap();
                let body = "{\"status\":\"ok\"}";
                write!(socket, "HTTP/1.1 {status} Mock\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        let settings = ConnectionSettings {
            base_url,
            api_key: None,
        };
        let client = crate::api::AdminClient::new(settings.clone()).unwrap();
        let slot: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
        let startup = connect_or_launch(
            &client,
            &settings,
            Arc::new(AtomicBool::new(false)),
            Arc::clone(&slot),
            Some(fake_bundle()),
        )
        .await;
        worker.join().unwrap();
        drop(held_listener);
        (startup, slot)
    }
    #[tokio::test]
    async fn healthy_mock_never_launches() {
        let (startup, slot) = startup_against_mock(200, 1).await;
        assert!(startup.ready);
        assert!(lock(&slot).is_none());
    }
    #[tokio::test]
    async fn occupied_unhealthy_mock_stays_offline_without_launching() {
        let (startup, slot) = startup_against_mock(503, 3).await;
        assert!(!startup.ready);
        assert!(lock(&slot).is_none());
        assert!(startup.message.contains("occupied port"));
    }
    fn store_child(slot: &Mutex<Option<Child>>, child: Child) {
        let mut slot = lock(slot);
        // Replace only if empty; a previous live child must never be silently dropped.
        if slot.is_none() {
            *slot = Some(child);
        }
    }
    /// A bundle layout fixture for paths that never reach the spawn itself.
    fn fake_bundle() -> RuntimeBundle {
        let dir = std::env::temp_dir().join(format!("ccr-lifecycle-fake-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("service")).unwrap();
        // These paths exercise attach/cancel only; no executable is launched.
        let node = RuntimeBundle { root: dir.clone() }.node();
        std::fs::write(node, "fixture").unwrap();
        std::fs::write(dir.join("service/entry.cjs"), "// fixture\n").unwrap();
        RuntimeBundle { root: dir }
    }
    #[tokio::test]
    async fn cancelled_startup_returns_before_readiness_and_keeps_slot_clean() {
        use std::io::{Read, Write};
        // Unhealthy mock so the flow reaches the (never-spawned) launch path;
        // non-blocking accepts with a deadline so the worker can never hang.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(15);
            while std::time::Instant::now() < deadline {
                let (mut socket, _) = match listener.accept() {
                    Ok(pair) => pair,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(_) => break,
                };
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut request = [0; 4096];
                let _ = socket.read(&mut request).unwrap();
                let body = "{}";
                write!(
                    socket,
                    "HTTP/1.1 503 Mock\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            }
        });
        let settings = ConnectionSettings {
            base_url,
            api_key: None,
        };
        let client = crate::api::AdminClient::new(settings.clone()).unwrap();
        let slot: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
        let cancel = Arc::new(AtomicBool::new(true));
        let startup = connect_or_launch(
            &client,
            &settings,
            cancel,
            Arc::clone(&slot),
            Some(fake_bundle()),
        )
        .await;
        worker.join().unwrap();
        assert!(!startup.ready);
        assert!(lock(&slot).is_none());
    }
    #[tokio::test]
    async fn missing_bundle_errors_only_when_spawn_is_required() {
        // Refused port: attach fails, so the missing bundle must surface the
        // explicit prepare error — never an installed-CLI fallback.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let settings = ConnectionSettings {
            base_url: format!("http://{addr}"),
            api_key: None,
        };
        let client = crate::api::AdminClient::new(settings.clone()).unwrap();
        let slot: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
        let startup = connect_or_launch(
            &client,
            &settings,
            Arc::new(AtomicBool::new(false)),
            Arc::clone(&slot),
            None,
        )
        .await;
        assert!(!startup.ready);
        assert!(
            startup.message.contains("runtime bundle is missing"),
            "{}",
            startup.message
        );
        assert!(lock(&slot).is_none());
    }
    #[test]
    fn config_proof_rejects_conflicts_and_bad_ports() {
        let addr = endpoint("http://127.0.0.1:4000").unwrap();
        assert!(config_text_matches("{PORT:4000}", addr, &|_| None));
        assert!(!config_text_matches("{PORT:3456}", addr, &|_| None));
        assert!(!config_text_matches("{PORT:'bad'}", addr, &|_| None));
        assert!(!config_text_matches("[]", addr, &|_| None));
        assert!(!config_text_matches(
            "{PORT:4000, HOST:'192.168.1.2'}",
            addr,
            &|_| None
        ));
        let env = |name: &str| match name {
            "SERVICE_PORT" => Some("4001".into()),
            "CCR_DESKTOP_PORT" => Some("4000".into()),
            _ => None,
        };
        assert!(!config_text_matches("{PORT:4000}", addr, &env));
    }
    #[cfg(unix)]
    #[test]
    fn bundled_path_prepends_bundle_dirs_before_inherited() {
        let bundle = fake_bundle();
        let joined = bundled_path(&bundle, OsStr::new("/usr/bin:/bin")).unwrap();
        let dirs: Vec<_> = std::env::split_paths(&joined).take(4).collect();
        assert_eq!(
            dirs,
            vec![
                bundle.root.join("bin"),
                bundle.root.clone(),
                PathBuf::from("/usr/bin"),
                PathBuf::from("/bin"),
            ]
        );
    }
    // -- fake child fixtures -------------------------------------------------
    /// Fake "gateway": a shell that ignores its arguments and sleeps until
    /// signalled. Never touches network or config.
    fn fake_child_script(dir: &Path, name: &str, trap_term: bool) -> PathBuf {
        #[cfg(unix)]
        {
            let path = dir.join(name);
            let body = if trap_term {
                "#!/bin/sh\ntrap 'exit 0' TERM\nwhile :; do sleep 0.2; done\n"
            } else {
                "#!/bin/sh\nwhile :; do sleep 0.5; done\n"
            };
            std::fs::write(&path, body).unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        }
        #[cfg(not(unix))]
        {
            let _ = (dir, name, trap_term);
            unreachable!("fake child fixtures are unix-only in this suite")
        }
    }
    fn spawn_fake(script: &Path) -> Child {
        Command::new(script)
            .arg("ignored-start")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }
    #[cfg(unix)]
    #[test]
    fn stop_owned_gateway_terminates_a_live_fake_child() {
        let dir = std::env::temp_dir().join(format!("ccr-lifecycle-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = fake_child_script(&dir, "sleepy.sh", false);
        let mut child = spawn_fake(&script);
        assert!(stop_owned_gateway(&mut child));
        assert!(matches!(child.try_wait(), Ok(Some(_))));
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[cfg(unix)]
    #[test]
    fn stop_owned_gateway_on_exited_child_never_signals_again() {
        let dir = std::env::temp_dir().join(format!("ccr-lifecycle-exit-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = fake_child_script(&dir, "quick.sh", false);
        let mut child = spawn_fake(&script);
        child.kill().unwrap();
        child.wait().unwrap();
        // Already exited: must return immediately without touching any PID.
        assert!(stop_owned_gateway(&mut child));
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[cfg(unix)]
    #[test]
    fn graceful_sigterm_runs_before_bounded_kill() {
        let dir = std::env::temp_dir().join(format!("ccr-lifecycle-grace-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // The trap is installed before the ready marker is written, so the test
        // only signals after the handler exists. The marker written inside the
        // trap proves the graceful signal ran (SIGKILL would skip it).
        let ready = dir.join("ready-marker");
        let term_marker = dir.join("term-marker");
        let script_path = dir.join("trapd.sh");
        std::fs::write(
            &script_path,
            format!(
                "#!/bin/sh\ntrap 'touch \"{}\"; exit 0' TERM\ntouch \"{}\"\nwhile :; do sleep 0.5; done\n",
                term_marker.display(),
                ready.display()
            ),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut child = spawn_fake(&script_path);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !ready.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(ready.exists(), "fake gateway should report trap readiness");
        assert!(stop_owned_gateway(&mut child));
        assert!(
            term_marker.exists(),
            "SIGTERM trap should have run before kill"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[cfg(windows)]
    #[test]
    fn node_main_uses_a_regular_absolute_windows_path() {
        let bundle = RuntimeBundle {
            root: PathBuf::from(r"\\?\E:\CCR Desktop\runtime"),
        };
        let cmd = bundle.launch_command();
        assert_eq!(cmd.get_program(), bundle.node());
        assert_eq!(cmd.get_current_dir(), None);
        let args: Vec<_> = cmd.get_args().map(Path::new).collect();
        assert_eq!(
            args,
            [Path::new(r"E:\CCR Desktop\runtime\service\entry.cjs")]
        );
    }

    #[cfg(unix)]
    #[test]
    fn spawn_bundled_publishes_child_into_shared_slot() {
        // detect() expects the bundle under <resource_dir>/runtime — mirror the
        // real resource layout in the fixture.
        let dir = std::env::temp_dir().join(format!("ccr-lifecycle-bundle-{}", std::process::id()));
        let runtime = dir.join("runtime");
        std::fs::create_dir_all(runtime.join("service")).unwrap();
        fake_child_script(&runtime, "node", false);
        std::fs::write(runtime.join("service/entry.cjs"), "// fake entry\n").unwrap();
        let bundle = RuntimeBundle {
            root: runtime.clone(),
        };
        assert!(RuntimeBundle::detect(Some(&dir)).is_some());
        assert!(RuntimeBundle::detect(Some(&dir.join("missing"))).is_none());
        let slot: Mutex<Option<Child>> = Mutex::new(None);
        let child = bundle
            .launch_command()
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        store_child(&slot, child);
        let mut child = lock(&slot).take().expect("child must be in shared slot");
        assert!(matches!(child.try_wait(), Ok(None)), "child must be alive");
        assert!(stop_owned_gateway(&mut child));
        assert_eq!(
            std::env::split_paths(&bundled_path(&bundle, OsStr::new("/usr/bin:/bin")).unwrap())
                .take(2)
                .collect::<Vec<_>>(),
            vec![runtime.join("bin"), runtime.clone()]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn service_state_covers_all_modes() {
        let owned = |o, r, e| service_state(o, r, e);
        let state = owned(OwnedGateway::Live, false, None);
        assert_eq!(state.mode, ServiceMode::Owned);
        assert!(state.running);
        let state = owned(OwnedGateway::Starting, false, None);
        assert_eq!(state.mode, ServiceMode::Starting);
        assert!(state.running);
        let state = owned(OwnedGateway::Exited, true, None);
        assert_eq!(state.mode, ServiceMode::External);
        assert!(state.running);
        let state = owned(OwnedGateway::Exited, false, None);
        assert_eq!(state.mode, ServiceMode::Stopped);
        assert!(!state.running);
        let state = owned(OwnedGateway::None, true, None);
        assert_eq!(state.mode, ServiceMode::External);
        let state = owned(OwnedGateway::None, false, Some("Cannot safely auto-start"));
        assert_eq!(state.mode, ServiceMode::Error);
        assert!(!state.running);
        assert_eq!(state.message, "Cannot safely auto-start");
        let state = owned(OwnedGateway::None, false, None);
        assert_eq!(state.mode, ServiceMode::Stopped);
        // Exact DTO surface: mode/running/message only.
        let encoded = serde_json::to_value(&state).unwrap();
        assert_eq!(
            encoded,
            serde_json::json!({"mode": "stopped", "running": false, "message": "Gateway is not running"})
        );
    }
}
