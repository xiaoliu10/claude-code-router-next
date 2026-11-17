use crate::{
    api::{AdminClient, TraySnapshot},
    lifecycle,
    settings::ConnectionSettings,
};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
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

#[derive(Clone)]
struct View {
    snapshot: Option<TraySnapshot>,
    status: String,
    online: bool,
    switching: bool,
    revision: u64,
}

pub struct Controller {
    app: tauri::AppHandle,
    client: AdminClient,
    settings: ConnectionSettings,
    operation: AsyncMutex<()>,
    view: Mutex<View>,
    epoch: AtomicU64,
    switching: AtomicBool,
    stopped: AtomicBool,
    loaded: AtomicBool,
    wake: Notify,
    launcher: Mutex<Option<std::process::Child>>,
    // Set when the user manually hides the window; recovery never re-shows it.
    user_hidden: AtomicBool,
    // Signature of the last tray menu actually applied, to avoid rebuilding
    // an identical NSMenu every 30s poll.
    applied: Mutex<Option<u64>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn open_window(app: &tauri::AppHandle) {
    if let Some(controller) = app.try_state::<Arc<Controller>>() {
        controller.user_hidden.store(false, Ordering::SeqCst);
    }
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
                "More quota details in Web UI",
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
                    "More in Web UI…",
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
                "More in Web UI…",
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
        "Open CCR UI",
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        "quit",
        "Quit Desktop (gateway stays running)",
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
    ) -> Result<Arc<Self>, String> {
        let controller = Arc::new(Self {
            app: app.clone(),
            settings,
            client,
            operation: AsyncMutex::new(()),
            view: Mutex::new(View {
                snapshot: None,
                status: "Connecting to CCR…".into(),
                online: false,
                switching: false,
                revision: 0,
            }),
            epoch: AtomicU64::new(0),
            switching: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            loaded: AtomicBool::new(false),
            wake: Notify::new(),
            launcher: Mutex::new(None),
            user_hidden: AtomicBool::new(false),
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
        let view = {
            let mut view = lock(&self.view);
            change(&mut view);
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

    fn show_ready(self: &Arc<Self>) {
        if self.loaded.swap(true, Ordering::SeqCst) {
            return;
        }
        let url = self.settings.ui_url();
        let app = self.app.clone();
        let controller = Arc::clone(self);
        let _ = self.app.run_on_main_thread(move || {
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(url) = url.parse() {
                    let _ = window.navigate(url);
                }
                // Navigate to the live UI, but never steal the window back once the
                // user has manually hidden it.
                if !controller.user_hidden.load(Ordering::SeqCst) {
                    let _ = window.show();
                }
            }
        });
    }

    pub fn mark_user_hidden(&self) {
        self.user_hidden.store(true, Ordering::SeqCst);
    }

    pub fn start(self: &Arc<Self>) {
        let controller = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            {
                let _operation = controller.operation.lock().await;
                let startup =
                    lifecycle::connect_or_launch(&controller.client, &controller.settings).await;
                *lock(&controller.launcher) = startup.launcher;
                controller.update(|v| {
                    v.status = startup.message;
                });
                if startup.ready {
                    controller.show_ready();
                } else {
                    let app = controller.app.clone();
                    let _ = controller.app.run_on_main_thread(move || open_window(&app));
                }
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

    fn reap(&self) {
        let mut child = lock(&self.launcher);
        if let Some(launcher) = child.as_mut() {
            if matches!(launcher.try_wait(), Ok(Some(_))) {
                *child = None;
            }
        }
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.wake.notify_one();
        // Only reap an exited launcher. The detached/shared gateway survives.
        self.reap();
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
                    v.status = format!("Switch failed: {e} — Refresh to retry");
                }),
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
}
