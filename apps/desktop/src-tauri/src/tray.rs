use crate::{
    api::{AdminClient, TraySnapshot},
    lifecycle::{self, OwnedGateway, RuntimeBundle, ServiceAction, ServiceState},
    settings::ConnectionSettings,
};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::process::Child;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};
use tokio::sync::{Mutex as AsyncMutex, Notify};

const TRAY_ID: &str = "ccr-tray";
const MAX_PROVIDERS: usize = 15;
const MAX_MODELS: usize = 12;
/// Upper bound for waiting out a startup race during shutdown. The child is
/// published to shared state synchronously right after spawn, so this only
/// covers the spawn itself, not the readiness wait.
const SHUTDOWN_RACE_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

#[derive(Clone)]
struct View {
    snapshot: Option<TraySnapshot>,
    status: String,
    online: bool,
    switching: bool,
    owned: bool,
    revision: u64,
}

pub struct Controller {
    app: tauri::AppHandle,
    client: AdminClient,
    settings: ConnectionSettings,
    /// Staged embedded runtime; the desktop never launches an installed `ccr`.
    bundle: Option<RuntimeBundle>,
    operation: AsyncMutex<()>,
    view: Mutex<View>,
    epoch: AtomicU64,
    switching: AtomicBool,
    /// Quit/exit signal; also cancels the startup readiness wait promptly.
    stopped: Arc<AtomicBool>,
    /// True while a start attempt is between spawn and readiness answer.
    starting: AtomicBool,
    /// Set once the owned gateway answered health at least once this run.
    reached_ready: AtomicBool,
    /// Set when the start attempt finished (spawn published or failed).
    startup_settled: AtomicBool,
    /// Message of the last failed explicit start attempt; drives mode `error`.
    service_error: Mutex<Option<String>>,
    loaded: AtomicBool,
    wake: Notify,
    /// Single owner of record for the desktop-owned gateway child. The child is
    /// published here synchronously right after spawn so quit racing startup
    /// can always find and clean it.
    launcher: Arc<Mutex<Option<Child>>>,
    // Signature of the last tray menu actually applied, to avoid rebuilding
    // an identical NSMenu every 30s poll.
    applied: Mutex<Option<u64>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn stop_slot(slot: &Mutex<Option<Child>>) -> Option<bool> {
    let mut guard = lock(slot);
    let result = lifecycle::stop_owned_gateway(guard.as_mut()?);
    guard.take();
    Some(result)
}

/// Quit wording reflects ownership: only an owned gateway is stopped on exit.
fn quit_label(owned: bool) -> &'static str {
    if owned {
        "Quit Desktop (stops the gateway it started)"
    } else {
        "Quit Desktop (gateway stays running)"
    }
}

pub fn open_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

// IDs carry immutable payload, not indices into a list that can change while
// a native menu is open. The backend revalidates against fresh configuration.
fn action_id(provider: &str, model: &str) -> String {
    let payload = serde_json::to_vec(&(provider, model)).unwrap_or_default();
    let encoded: String = payload.iter().map(|b| format!("{b:02x}")).collect();
    format!("model:{encoded}")
}

fn action_target(id: &str) -> Option<(String, String)> {
    let hex = id.strip_prefix("model:")?;
    if hex.len() % 2 != 0 {
        return None;
    }
    let bytes: Option<Vec<u8>> = hex
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| {
            std::str::from_utf8(pair)
                .ok()
                .and_then(|s| u8::from_str_radix(s, 16).ok())
        })
        .collect();
    serde_json::from_slice(&bytes?).ok()
}

fn bounded_indices(len: usize, limit: usize, current: Option<usize>) -> Vec<usize> {
    let mut indices: Vec<_> = (0..len.min(limit)).collect();
    if let Some(index) = current.filter(|i| *i < len && *i >= limit) {
        indices.push(index);
    }
    indices
}

// Content signature so unchanged views skip tray menu rebuilds. Revision alone is
// not enough: periodic refreshes bump it even when nothing changed.
fn view_hash(view: &View) -> u64 {
    let mut hasher = DefaultHasher::new();
    view.status.hash(&mut hasher);
    view.online.hash(&mut hasher);
    view.switching.hash(&mut hasher);
    view.owned.hash(&mut hasher);
    match &view.snapshot {
        Some(snapshot) => {
            1u8.hash(&mut hasher);
            snapshot.current_default.hash(&mut hasher);
            snapshot.family_routing.hash(&mut hasher);
            snapshot.providers.hash(&mut hasher);
            snapshot.quota_lines.hash(&mut hasher);
            snapshot.quota_warning.hash(&mut hasher);
        }
        None => 0u8.hash(&mut hasher),
    }
    hasher.finish()
}

fn concise(text: &str) -> String {
    let clean: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(180)
        .collect();
    if text.chars().count() > 180 {
        format!("{clean}…")
    } else {
        clean
    }
}

fn menu(app: &tauri::AppHandle, view: &View) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(
        app,
        "status",
        concise(&view.status),
        false,
        None::<&str>,
    )?)?;
    let current = view
        .snapshot
        .as_ref()
        .and_then(|s| s.current_default.as_deref());
    menu.append(&MenuItem::with_id(
        app,
        "current",
        format!(
            "Global default: {}",
            concise(current.unwrap_or("(unknown)"))
        ),
        false,
        None::<&str>,
    )?)?;
    if let Some(snapshot) = &view.snapshot {
        if snapshot.family_routing {
            menu.append(&MenuItem::with_id(
                app,
                "families",
                "Global default only — family routing overrides",
                false,
                None::<&str>,
            )?)?;
        }
        for (i, line) in snapshot.quota_lines.iter().take(5).enumerate() {
            menu.append(&MenuItem::with_id(
                app,
                format!("quota-{i}"),
                concise(line),
                false,
                None::<&str>,
            )?)?;
        }
        if snapshot.quota_lines.len() > 5 {
            menu.append(&MenuItem::with_id(
                app,
                "quota-more",
                "More quota details in Control Center",
                false,
                None::<&str>,
            )?)?;
        }
        if let Some(warning) = &snapshot.quota_warning {
            menu.append(&MenuItem::with_id(
                app,
                "quota-warning",
                concise(warning),
                false,
                None::<&str>,
            )?)?;
        }
        if !view.online {
            menu.append(&MenuItem::with_id(
                app,
                "quota-stale",
                "Last known data — quota may be stale",
                false,
                None::<&str>,
            )?)?;
        }
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        let active_provider = snapshot.providers.iter().position(|p| {
            p.models
                .iter()
                .any(|m| current == Some(format!("{},{}", p.name, m).as_str()))
        });
        let indices = bounded_indices(snapshot.providers.len(), MAX_PROVIDERS, active_provider);
        let mut omitted = indices.len() < snapshot.providers.len();
        for index in indices {
            let provider = &snapshot.providers[index];
            let submenu = Submenu::with_id(app, format!("provider-{index}"), &provider.name, true)?;
            let active_model = provider
                .models
                .iter()
                .position(|m| current == Some(format!("{},{}", provider.name, m).as_str()));
            let models = bounded_indices(provider.models.len(), MAX_MODELS, active_model);
            omitted |= models.len() < provider.models.len();
            for index in &models {
                let model = &provider.models[*index];
                let checked = current == Some(format!("{},{}", provider.name, model).as_str());
                submenu.append(&CheckMenuItem::with_id(
                    app,
                    action_id(&provider.name, model),
                    model,
                    view.online && !view.switching,
                    checked,
                    None::<&str>,
                )?)?;
            }
            if models.len() < provider.models.len() {
                submenu.append(&MenuItem::with_id(
                    app,
                    format!("more-{index}"),
                    "More in Control Center…",
                    true,
                    None::<&str>,
                )?)?;
            }
            menu.append(&submenu)?;
        }
        if omitted {
            menu.append(&MenuItem::with_id(
                app,
                "more-all",
                "More in Control Center…",
                true,
                None::<&str>,
            )?)?;
        }
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "refresh",
        "Refresh",
        !view.switching,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        "open-ui",
        "Open Control Center",
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        "quit",
        quit_label(view.owned),
        true,
        None::<&str>,
    )?)?;
    Ok(menu)
}

pub fn install_offline(app: &tauri::AppHandle, error: String) -> Result<(), String> {
    let view = View {
        snapshot: None,
        status: format!("Configuration error: {error}"),
        online: false,
        switching: false,
        owned: false,
        revision: 0,
    };
    let initial = menu(app, &view).map_err(|e| e.to_string())?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&initial)
        .tooltip("CCR — configuration error; relaunch after fixing settings")
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                crate::popup::show(tray.app_handle(), rect);
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "open-ui" | "refresh" => open_window(app),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app).map_err(|e| e.to_string())?;
    Ok(())
}

impl Controller {
    pub fn install(
        app: &tauri::AppHandle,
        settings: ConnectionSettings,
        client: AdminClient,
        bundle: Option<RuntimeBundle>,
    ) -> Result<Arc<Self>, String> {
        let controller = Arc::new(Self {
            app: app.clone(),
            settings,
            client,
            bundle,
            operation: AsyncMutex::new(()),
            view: Mutex::new(View {
                snapshot: None,
                status: "Connecting to CCR…".into(),
                online: false,
                switching: false,
                owned: false,
                revision: 0,
            }),
            epoch: AtomicU64::new(0),
            switching: AtomicBool::new(false),
            stopped: Arc::new(AtomicBool::new(false)),
            starting: AtomicBool::new(false),
            reached_ready: AtomicBool::new(false),
            startup_settled: AtomicBool::new(true),
            service_error: Mutex::new(None),
            loaded: AtomicBool::new(false),
            wake: Notify::new(),
            launcher: Arc::new(Mutex::new(None)),
            applied: Mutex::new(None),
        });
        let initial = menu(app, &lock(&controller.view)).map_err(|e| e.to_string())?;
        let events = Arc::clone(&controller);
        let mut builder = TrayIconBuilder::with_id(TRAY_ID)
            .menu(&initial)
            .tooltip("CCR — connecting")
            .show_menu_on_left_click(false)
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    rect,
                    ..
                } = event
                {
                    crate::popup::show(tray.app_handle(), rect);
                }
            })
            .on_menu_event(move |app, event| {
                let id = event.id.as_ref();
                match id {
                    "quit" => {
                        events.stop();
                        app.exit(0);
                    }
                    "open-ui" => open_window(app),
                    "refresh" => {
                        let controller = Arc::clone(&events);
                        tauri::async_runtime::spawn(async move {
                            controller.refresh().await;
                        });
                    }
                    _ if id.starts_with("more-") => open_window(app),
                    _ => {
                        if let Some((provider, model)) = action_target(id) {
                            events.switch(provider, model);
                        }
                    }
                }
            });
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }
        builder.build(app).map_err(|e| e.to_string())?;
        Ok(controller)
    }

    fn update(self: &Arc<Self>, change: impl FnOnce(&mut View)) {
        if self.stopped.load(Ordering::SeqCst) {
            return;
        }
        // Ownership is part of the view (quit wording); derived outside the view
        // lock so no second mutex is held while rendering.
        let owned = matches!(
            self.owned_gateway_state(),
            OwnedGateway::Live | OwnedGateway::Starting
        );
        let view = {
            let mut view = lock(&self.view);
            change(&mut view);
            view.owned = owned;
            view.revision += 1;
            view.clone()
        };
        let controller = Arc::clone(self);
        let app = self.app.clone();
        let _ = self.app.run_on_main_thread(move || {
            if controller.stopped.load(Ordering::SeqCst)
                || lock(&controller.view).revision != view.revision
            {
                return;
            }
            if let Some(tray) = app.tray_by_id(TRAY_ID) {
                let signature = view_hash(&view);
                if lock(&controller.applied).as_ref() == Some(&signature) {
                    return;
                }
                *lock(&controller.applied) = Some(signature);
                match menu(&app, &view) {
                    Ok(menu) => {
                        let _ = tray.set_menu(Some(menu));
                    }
                    Err(e) => {
                        eprintln!("Could not render tray: {e}");
                    }
                }
                let current = view
                    .snapshot
                    .as_ref()
                    .and_then(|s| s.current_default.as_deref())
                    .unwrap_or("unknown");
                let quota = view
                    .snapshot
                    .as_ref()
                    .map(|s| {
                        s.quota_warning
                            .as_deref()
                            .map(str::to_owned)
                            .unwrap_or_else(|| s.quota_lines.join(" | "))
                    })
                    .unwrap_or_default();
                let _ = tray.set_tooltip(Some(format!(
                    "CCR — {}\nDefault: {}\n{}",
                    concise(&view.status),
                    concise(current),
                    concise(&quota)
                )));
            }
        });
    }

    /// The main window is the local control center (quota.html); showing it is
    /// purely local — the desktop never navigates to a remote Web UI.
    fn show_ready(self: &Arc<Self>) {
        if self.loaded.swap(true, Ordering::SeqCst) {
            return;
        }
        let app = self.app.clone();
        let _ = self.app.run_on_main_thread(move || open_window(&app));
    }

    /// Liveness of the desktop-owned child, derived from the shared launcher
    /// slot. A reaped exited child keeps the Exited observation for the caller.
    fn owned_gateway_state(&self) -> OwnedGateway {
        let mut slot = lock(&self.launcher);
        match slot.as_mut() {
            None => OwnedGateway::None,
            Some(child) => match child.try_wait() {
                Ok(Some(_)) => {
                    *slot = None;
                    OwnedGateway::Exited
                }
                Ok(None) => {
                    if self.reached_ready.load(Ordering::SeqCst) {
                        OwnedGateway::Live
                    } else {
                        OwnedGateway::Starting
                    }
                }
                Err(_) => OwnedGateway::None,
            },
        }
    }

    pub fn start(self: &Arc<Self>) {
        let controller = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let startup = controller.startup_once().await;
            controller.update(|v| {
                v.status = startup.message.clone();
            });
            if startup.ready {
                controller.show_ready();
            } else {
                let app = controller.app.clone();
                let _ = controller.app.run_on_main_thread(move || open_window(&app));
            }
            controller.refresh().await;
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_secs(30)) => {},
                    _ = controller.wake.notified() => break,
                }
                if controller.stopped.load(Ordering::SeqCst) {
                    break;
                }
                controller.reap();
                controller.refresh().await;
            }
        });
    }

    /// One start attempt. Holds the operation lock so a start and a routing
    /// switch never interleave; stop/shutdown deliberately does not take this
    /// lock so quitting can never be blocked by a startup in flight.
    async fn startup_once(self: &Arc<Self>) -> lifecycle::Startup {
        let _operation = self.operation.lock().await;
        self.starting.store(true, Ordering::SeqCst);
        self.startup_settled.store(false, Ordering::SeqCst);
        // connect_or_launch attaches to a reachable gateway first; only an
        // actual spawn requires the bundle (explicit prepare error, never an
        // installed-CCR fallback).
        let startup = lifecycle::connect_or_launch(
            &self.client,
            &self.settings,
            Arc::clone(&self.stopped),
            Arc::clone(&self.launcher),
            self.bundle.clone(),
        )
        .await;
        self.starting.store(false, Ordering::SeqCst);
        self.startup_settled.store(true, Ordering::SeqCst);
        if startup.ready {
            self.reached_ready.store(true, Ordering::SeqCst);
            *lock(&self.service_error) = None;
        } else if !self.stopped.load(Ordering::SeqCst) {
            eprintln!("Desktop gateway startup: {}", startup.message);
            *lock(&self.service_error) = Some(startup.message.clone());
        }
        startup
    }

    fn reap(&self) {
        let mut child = lock(&self.launcher);
        if let Some(launcher) = child.as_mut() {
            if matches!(launcher.try_wait(), Ok(Some(_))) {
                *child = None;
            }
        }
    }

    /// Quit/exit path. Stops only the desktop-owned gateway: SIGTERM, bounded
    /// wait, then kill (lifecycle::stop_owned_gateway). An external gateway —
    /// including an attach to a launchd service — is never touched. Safe to
    /// call multiple times; synchronous so RunEvent::Exit can rely on it.
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.wake.notify_one();
        let deadline = std::time::Instant::now() + SHUTDOWN_RACE_WAIT;
        loop {
            // The installer handoff and the regular exit hook can race. Keep the slot
            // locked through termination so both paths observe a reaped child.
            if stop_slot(&self.launcher).is_some() {
                return;
            }
            // A startup in flight publishes the child synchronously at spawn;
            // wait until the attempt settles so the race cannot orphan it.
            if self.startup_settled.load(Ordering::SeqCst) {
                return;
            }
            if std::time::Instant::now() >= deadline {
                eprintln!("Gateway startup did not settle during shutdown; giving up stop");
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }

    /// Hold off new starts until NSIS takes over. If Windows declines the launch,
    /// restore service only when we stopped this desktop's own child.
    pub async fn install_verified_update(
        self: &Arc<Self>,
        install: impl FnOnce() -> Result<(), String> + Send + 'static,
    ) -> Result<(), String> {
        let operation = self.operation.lock().await;
        let slot = Arc::clone(&self.launcher);
        let stopped = tauri::async_runtime::spawn_blocking(move || stop_slot(&slot))
            .await
            .map_err(|_| "UPDATE_INSTALL_FAILED")?;
        if stopped == Some(false) {
            return Err("UPDATE_INSTALL_FAILED".into());
        }
        let result = tauri::async_runtime::spawn_blocking(install)
            .await
            .unwrap_or_else(|_| Err("UPDATE_INSTALL_FAILED".into()));
        drop(operation);
        if result.is_err() && stopped == Some(true) && !self.stopped.load(Ordering::SeqCst) {
            let _ = self.action_start().await;
        }
        result
    }

    /// Service state for the control center header. No lock is held across the
    /// health probe, so stop/shutdown can never be blocked by a snapshot.
    pub async fn service_snapshot(self: &Arc<Self>) -> ServiceState {
        let owned = self.owned_gateway_state();
        let error = lock(&self.service_error).clone();
        lifecycle::service_state_probe(&self.client, owned, error).await
    }

    /// Explicit start/stop from the control center. Stop only ever touches the
    /// owned child; external gateways are rejected with a fixed safe message.
    pub async fn service_action(
        self: &Arc<Self>,
        action: ServiceAction,
    ) -> Result<ServiceState, String> {
        match action {
            ServiceAction::Stop => self.action_stop().await,
            ServiceAction::Start => self.action_start().await,
        }
    }

    async fn action_stop(self: &Arc<Self>) -> Result<ServiceState, String> {
        let slot = Arc::clone(&self.launcher);
        let stopped_cleanly = tauri::async_runtime::spawn_blocking(move || {
            // Keep the child in its shared ownership slot until termination
            // completes. Quit waits on this same mutex, including during kill.
            stop_slot(&slot)
        })
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Only a gateway started by this desktop can be stopped here. External services must be stopped by their own owner.".to_string())?;
        self.update(|v| {
            v.status = if stopped_cleanly {
                "Gateway stopped".into()
            } else {
                "Gateway stop did not complete cleanly".into()
            };
        });
        *lock(&self.service_error) = None;
        self.refresh().await;
        Ok(self.service_snapshot().await)
    }

    async fn action_start(self: &Arc<Self>) -> Result<ServiceState, String> {
        match self.owned_gateway_state() {
            OwnedGateway::Live | OwnedGateway::Starting => {
                return Ok(self.service_snapshot().await)
            }
            _ => {}
        }
        // Explicit start never claims a gateway that is already running without
        // this desktop; spawning a second one would only lose the port race.
        if self.client.health().await {
            return Err("A gateway is already running but was not started by this desktop. Stop it with its own tooling first.".into());
        }
        *lock(&self.service_error) = None;
        let startup = self.startup_once().await;
        self.update(|v| {
            v.status = startup.message.clone();
        });
        if startup.ready {
            self.show_ready();
        }
        Ok(self.service_snapshot().await)
    }

    async fn refresh(self: &Arc<Self>) {
        let epoch = self.epoch.load(Ordering::SeqCst);
        let _operation = self.operation.lock().await;
        if self.stopped.load(Ordering::SeqCst)
            || self.switching.load(Ordering::SeqCst)
            || self.epoch.load(Ordering::SeqCst) != epoch
        {
            return;
        }
        if !self.loaded.load(Ordering::SeqCst) && !self.client.health().await {
            self.update(|v| {
                if self.epoch.load(Ordering::SeqCst) != epoch {
                    return;
                }
                v.online = false;
                v.status = "API unavailable: health check failed; gateway was not replaced".into();
            });
            return;
        }
        let snapshot = self.client.snapshot().await;
        if self.epoch.load(Ordering::SeqCst) != epoch {
            return;
        }
        match snapshot {
            Ok(snapshot) => {
                self.reached_ready.store(true, Ordering::SeqCst);
                *lock(&self.service_error) = None;
                self.update(|v| {
                    if self.epoch.load(Ordering::SeqCst) != epoch {
                        return;
                    }
                    v.snapshot = Some(snapshot);
                    v.online = true;
                    v.status = "Connected".into();
                });
                self.show_ready();
            }
            Err(e) => self.update(|v| {
                if self.epoch.load(Ordering::SeqCst) != epoch {
                    return;
                }
                v.online = false;
                if crate::api::admin_auth_failed(&e) {
                    v.snapshot = None;
                }
                v.status = format!("API unavailable: {e}");
            }),
        }
    }

    fn switch(self: &Arc<Self>, provider: String, model: String) {
        if self.stopped.load(Ordering::SeqCst) || !lock(&self.view).online {
            return;
        }
        if self
            .switching
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }
        self.epoch.fetch_add(1, Ordering::SeqCst);
        self.update(|v| {
            v.switching = true;
            v.status = format!("Switching global default to {provider},{model}…");
        });
        let controller = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let _operation = controller.operation.lock().await;
            if controller.stopped.load(Ordering::SeqCst) {
                controller.switching.store(false, Ordering::SeqCst);
                return;
            }
            let result = controller.client.switch_default(&provider, &model).await;
            controller.switching.store(false, Ordering::SeqCst);
            match result {
                Ok(snapshot) => controller.update(|v| {
                    v.snapshot = Some(snapshot);
                    v.online = true;
                    v.switching = false;
                    v.status = "Global default updated".into();
                }),
                Err(e) => controller.update(|v| {
                    v.switching = false;
                    v.online = false;
                    if crate::api::admin_auth_failed(&e) {
                        v.snapshot = None;
                    }
                    v.status = format!("Switch failed: {e} — Refresh to retry");
                }),
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lifecycle::MANAGED_ENV;

    /// Fake "gateway" child for ownership tests; no network, no config access.
    #[cfg(unix)]
    fn fake_child(dir: &std::path::Path) -> Child {
        let script = dir.join("sleepy.sh");
        std::fs::write(&script, "#!/bin/sh\nwhile :; do sleep 0.5; done\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::process::Command::new(&script)
            .arg("ignored-start")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap()
    }
    #[cfg(unix)]
    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ccr-tray-test-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
    #[test]
    fn payload_stays_bound_to_original_target() {
        let id = action_id("provider-汉字", "model,colon:!");
        assert_eq!(
            action_target(&id),
            Some(("provider-汉字".into(), "model,colon:!".into()))
        );
        assert!(action_target("model:xyz").is_none());
        assert!(action_target("model-0-0").is_none());
    }
    #[test]
    fn bounds_keep_current_outlier_and_signal_omissions() {
        let providers = bounded_indices(20, MAX_PROVIDERS, Some(19));
        assert!(providers.contains(&19));
        assert_eq!(providers.len(), 16);
        assert!(providers.len() < 20);
        let models = bounded_indices(13, MAX_MODELS, Some(12));
        assert_eq!(models.len(), 13);
        assert_eq!(bounded_indices(0, MAX_MODELS, None), Vec::<usize>::new());
    }
    #[test]
    fn quit_wording_reflects_ownership() {
        assert!(quit_label(true).contains("stops the gateway it started"));
        assert!(quit_label(false).contains("gateway stays running"));
    }
    #[test]
    #[cfg(unix)]
    fn shutdown_disposes_only_the_owned_child_in_the_slot() {
        let dir = temp_dir("shutdown");
        let slot: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(Some(fake_child(&dir))));
        let stopped = AtomicBool::new(true);
        let settled = AtomicBool::new(true);
        // Mirrors Controller::stop's dispose step without a Tauri app handle.
        stopped.store(true, Ordering::SeqCst);
        let child = lock(&slot).take();
        if let Some(mut child) = child {
            assert!(lifecycle::stop_owned_gateway(&mut child));
        }
        assert!(settled.load(Ordering::SeqCst));
        assert!(lock(&slot).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    #[cfg(unix)]
    fn owned_state_classifies_live_starting_and_exited() {
        let dir = temp_dir("states");
        let controller_state = |reached_ready: bool, exited_script: bool| {
            let child = fake_child(&dir);
            let mut slot: Mutex<Option<Child>> = Mutex::new(Some(child));
            if exited_script {
                if let Some(c) = slot.get_mut().unwrap() {
                    let _ = c.kill();
                    let _ = c.wait();
                }
            }
            let owned = match slot.get_mut().unwrap().as_mut().unwrap().try_wait() {
                Ok(Some(_)) => {
                    *slot.get_mut().unwrap() = None;
                    OwnedGateway::Exited
                }
                Ok(None) => {
                    if reached_ready {
                        OwnedGateway::Live
                    } else {
                        OwnedGateway::Starting
                    }
                }
                Err(_) => OwnedGateway::None,
            };
            if let Some(mut child) = slot.get_mut().unwrap().take() {
                lifecycle::stop_owned_gateway(&mut child);
            }
            owned
        };
        assert_eq!(controller_state(true, false), OwnedGateway::Live);
        assert_eq!(controller_state(false, false), OwnedGateway::Starting);
        assert_eq!(controller_state(false, true), OwnedGateway::Exited);
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    #[cfg(unix)]
    fn quit_waits_for_explicit_stop_to_finish_reaping() {
        let child = std::process::Command::new("/bin/sh")
            .args(["-c", "trap '' TERM; exec sleep 30"])
            .spawn()
            .unwrap();
        let slot = Arc::new(Mutex::new(Some(child)));
        let worker_slot = Arc::clone(&slot);
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let mut guard = lock(&worker_slot);
            ready_tx.send(()).unwrap();
            assert!(lifecycle::stop_owned_gateway(guard.as_mut().unwrap()));
            guard.take();
        });
        ready_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .unwrap();
        // This is quit's exact ownership observation. It must wait for the
        // explicit stop worker to terminate and reap the child, not see None.
        assert!(lock(&slot).take().is_none());
        worker.join().unwrap();
        assert_eq!(stop_slot(&slot), None);
    }

    #[test]
    fn managed_env_marker_name_is_stable() {
        assert_eq!(MANAGED_ENV, "CCR_DESKTOP_MANAGED");
    }
}
