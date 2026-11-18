//! Provider-plugin center: installed inventory, marketplace catalog, validated
//! one-click install/update and a small allowlisted action surface.
//!
//! Gateway seams (packages/core/src/ccr):
//! - GET  /api/plugins          installed records + ACTIVE manifest state. A
//!   record that failed to load (or is disabled) carries `version:null` and an
//!   `error`; only activated plugins expose management routes.
//! - GET  /api/plugins/catalog  npm search catalog. `installedVersion` is the
//!   on-disk manifest version (what a restart would activate), NOT the active
//!   manifest version from /api/plugins — after an install without restart the
//!   two legitimately differ. `updateAvailable` is computed by the route with
//!   semver `valid` + `gt`; a registry outage degrades to an empty list plus
//!   `warning:"registry_unavailable"` (never a 500).
//! - POST /api/plugins/install  the same validated install core as the CLI
//!   (`{name, force}`; force is the update/replace lane). Confirms with
//!   `{ok:true, name, version, restartRequired:true}`. Nothing hot-loads and
//!   this module NEVER restarts the gateway — the user decides via the
//!   existing service controls.
//!
//! Safety contract: every command is restricted to the local control-center
//! views via `popup::guard`; installs and actions hold the shared AdminClient
//! write lock; request paths come exclusively from the static action table
//! (never from user input); errors are fixed strings (no npm output, registry
//! URLs, response bodies or credential material). Installs fail closed unless
//! a fresh, complete catalog validates the exact package name and version.
//!
//! Actions are offered only for shipped plugins whose route contract works
//! WITHOUT a site/account selector:
//! - qoder registers one route set PER SITE (`/api/qoder`, `/api/qoder/cn`);
//!   every action would implicitly pick a site, so none is offered.
//! - workbuddy disconnect without `site` is a full reset of EVERY connected
//!   site, and kiro disconnect without `account` removes EVERY account — both
//!   need a validated selector the desktop contract does not carry, so they
//!   are skipped (sync/usage default to the active account server-side).
//! - gemini-oauth has no POST /usage; its usage refresh is GET /quota.

use crate::api::AdminClient;
use reqwest::Method;
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::WebviewWindow;

const ERR_UNAVAILABLE: &str = "Gateway connection is unavailable";
const ERR_INVALID: &str = "Invalid plugin request";
const ERR_INVENTORY: &str = "Gateway returned invalid plugin inventory";
const ERR_REGISTRY: &str = "Plugin catalog is unavailable; try again later";
const ERR_NOT_LISTED: &str = "Plugin is not listed in the verified catalog";
const ERR_ALREADY_INSTALLED: &str = "Plugin is already installed; use update instead";
const ERR_NO_UPDATE: &str = "No validated update is available for this plugin";
const ERR_INSTALL: &str = "Plugin install was not confirmed by the gateway";
const ERR_UNSUPPORTED: &str = "This plugin action is not supported in the desktop app";
const ERR_NOT_LOADED: &str = "Plugin is not loaded; restart the gateway after installing";
const ERR_ACTION: &str = "Plugin action was not confirmed by the gateway";

/// Same bound as the shared install core's npm-spec allowlist.
const MAX_NAME_LENGTH: usize = 214;
/// npm descriptions are display text; anything huger is not a catalog row we
/// are willing to forward.
const MAX_DESCRIPTION_LENGTH: usize = 4096;
/// npm pack alone is bounded to 30s server-side; allow the full validated
/// install (pack + archive checks + atomic swap) to finish before giving up.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(60);
const ACTION_TIMEOUT: Duration = Duration::from_secs(20);

// ============================== IPC projections ==============================

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PluginInventoryEntry {
    /// Installed manifest id (the plugins.json record / install directory).
    pub id: String,
    /// Display name. Shipped manifests expose no separate display name, so
    /// this is the manifest id; the UI may prettify it.
    pub name: String,
    /// ACTIVE manifest version; null when installed but not loaded.
    pub version: Option<String>,
    pub loaded: bool,
    #[serde(rename = "connectionState", skip_serializing_if = "Option::is_none")]
    pub connection_state: Option<ConnectionState>,
    pub actions: Vec<&'static str>,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionState {
    Connected,
    Disconnected,
    Unknown,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PluginInventory {
    pub plugins: Vec<PluginInventoryEntry>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginCatalogEntry {
    /// npm package name (or the manifest/source name for local-only rows).
    pub name: String,
    pub description: String,
    /// Latest version the npm search index offers ("" when unknown).
    pub version: String,
    pub installed: bool,
    /// On-disk installed manifest version — may differ from the ACTIVE
    /// manifest version in the inventory until the gateway restarts.
    pub installed_version: Option<String>,
    pub update_available: bool,
    pub local_only: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PluginCatalog {
    pub plugins: Vec<PluginCatalogEntry>,
    /// True when the registry could not be reached (the route's stable
    /// `registry_unavailable` warning): the list is incomplete and installs
    /// fail closed until a complete catalog loads.
    pub partial: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    pub restart_required: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ActionOutcome {
    pub success: bool,
}

// ============================== Name allowlists ==============================

/// Installed manifest name: `PLUGIN_NAME_PATTERN` from the shared install
/// core — unscoped, alphanumeric start, then alphanumerics or `-`.
fn valid_plugin_name(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= MAX_NAME_LENGTH
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'-')
}

/// npm package request name: `NPM_SPEC_PATTERN` from the shared install core
/// — lowercase, optional `@scope/`, no version tag, path or URL shape.
fn valid_npm_name(value: &str) -> bool {
    if value.is_empty() || value.len() > MAX_NAME_LENGTH || value.starts_with('-') {
        return false;
    }
    let package = if let Some(scope) = value.strip_prefix('@') {
        let Some((scope, package)) = scope.split_once('/') else {
            return false;
        };
        if scope.is_empty() || !valid_npm_part(scope) {
            return false;
        }
        package
    } else {
        value
    };
    valid_npm_part(package)
}

/// One `[a-z0-9-~][a-z0-9-._~]*` segment of an npm package name.
fn valid_npm_part(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && (bytes[0].is_ascii_lowercase()
            || bytes[0].is_ascii_digit()
            || matches!(bytes[0], b'-' | b'~'))
        && bytes.iter().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'.' | b'_' | b'~')
        })
}

// ============================== Action allowlist ==============================

/// How a successful gateway response confirms the action. Mirrors each
/// shipped plugin's actual route contract — HTTP 200 alone is NOT enough
/// where the route reports an explicit success/ok flag.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Confirmation {
    /// Body must carry `success:true` (codex/workbuddy/kiro/grok/cursor sync,
    /// codex/grok/cursor disconnect).
    SuccessTrue,
    /// Body must carry `ok:true` (gemini-oauth sync/disconnect, workbuddy usage).
    OkTrue,
    /// Body must be a JSON object (kiro/grok/cursor usage snapshots).
    JsonObject,
    /// Any valid JSON confirms; the quota surface is legitimately null when
    /// the account has no quota info (codex usage, gemini-oauth quota).
    AnyJson,
}

#[derive(Clone, Copy, Debug)]
struct ActionRoute {
    action: &'static str,
    /// Fixed allowlisted gateway path — never built from user input.
    path: &'static str,
    get: bool,
    confirm: Confirmation,
}

const fn post(action: &'static str, path: &'static str, confirm: Confirmation) -> ActionRoute {
    ActionRoute {
        action,
        path,
        get: false,
        confirm,
    }
}

const CODEX_ACTIONS: &[ActionRoute] = &[
    post("sync", "/api/codex/sync", Confirmation::SuccessTrue),
    post("usage", "/api/codex/usage", Confirmation::AnyJson),
    post(
        "disconnect",
        "/api/codex/disconnect",
        Confirmation::SuccessTrue,
    ),
];
const GEMINI_OAUTH_ACTIONS: &[ActionRoute] = &[
    post("sync", "/api/gemini-oauth/sync", Confirmation::OkTrue),
    // No POST /usage exists; the read-only quota GET is the refresh lane.
    ActionRoute {
        action: "usage",
        path: "/api/gemini-oauth/quota",
        get: true,
        confirm: Confirmation::AnyJson,
    },
    post(
        "disconnect",
        "/api/gemini-oauth/disconnect",
        Confirmation::OkTrue,
    ),
];
/// No disconnect: without a `site` selector the route resets EVERY site.
const WORKBUDDY_ACTIONS: &[ActionRoute] = &[
    post("sync", "/api/workbuddy/sync", Confirmation::SuccessTrue),
    post("usage", "/api/workbuddy/usage", Confirmation::OkTrue),
];
/// No disconnect: without an `account` selector the route removes EVERY account.
const KIRO_ACTIONS: &[ActionRoute] = &[
    post("sync", "/api/kiro/sync", Confirmation::SuccessTrue),
    post("usage", "/api/kiro/usage", Confirmation::JsonObject),
];
const GROK_ACTIONS: &[ActionRoute] = &[
    post("sync", "/api/grok/sync", Confirmation::SuccessTrue),
    post("usage", "/api/grok/usage", Confirmation::JsonObject),
    post(
        "disconnect",
        "/api/grok/disconnect",
        Confirmation::SuccessTrue,
    ),
];
const CURSOR_ACTIONS: &[ActionRoute] = &[
    post("sync", "/api/cursor/sync", Confirmation::SuccessTrue),
    post("usage", "/api/cursor/usage", Confirmation::JsonObject),
    post(
        "disconnect",
        "/api/cursor/disconnect",
        Confirmation::SuccessTrue,
    ),
];

/// Shipped-plugin action table. qoder (per-site route bases) and any unknown
/// third-party plugin get no actions: the desktop contract carries no
/// validated site/account selector and no arbitrary route access.
fn action_routes(id: &str) -> &'static [ActionRoute] {
    match id {
        "codex" => CODEX_ACTIONS,
        "gemini-oauth" => GEMINI_OAUTH_ACTIONS,
        "workbuddy" => WORKBUDDY_ACTIONS,
        "kiro" => KIRO_ACTIONS,
        "grok" => GROK_ACTIONS,
        "cursor" => CURSOR_ACTIONS,
        _ => &[],
    }
}

// ============================== Projections ==============================

fn inventory_from(response: &Value) -> Result<PluginInventory, &'static str> {
    let entries = response["plugins"].as_array().ok_or(ERR_INVENTORY)?;
    let mut plugins = Vec::new();
    for entry in entries {
        let Some(id) = entry["name"]
            .as_str()
            .filter(|name| valid_plugin_name(name))
        else {
            continue;
        };
        if plugins.iter().any(|p: &PluginInventoryEntry| p.id == id) {
            continue;
        }
        let version = entry["version"]
            .as_str()
            .filter(|version| !version.trim().is_empty())
            .map(str::to_owned);
        // describeInstalledPlugins: activated records carry the manifest
        // version and enabled:true; failed/disabled records carry version:null
        // plus an error string. Only activated plugins have live routes.
        let loaded =
            entry["enabled"] == json!(true) && version.is_some() && entry.get("error").is_none();
        plugins.push(PluginInventoryEntry {
            id: id.to_owned(),
            name: id.to_owned(),
            version,
            loaded,
            connection_state: None,
            actions: if loaded {
                action_routes(id).iter().map(|route| route.action).collect()
            } else {
                Vec::new()
            },
        });
    }
    Ok(PluginInventory { plugins })
}

fn catalog_from(response: &Value) -> Result<PluginCatalog, &'static str> {
    if response["ok"] != json!(true) {
        return Err(ERR_REGISTRY);
    }
    let partial = match response.get("warning") {
        None => false,
        Some(Value::String(_)) => true,
        Some(_) => return Err(ERR_REGISTRY),
    };
    let entries = response["plugins"].as_array().ok_or(ERR_REGISTRY)?;
    let mut plugins = Vec::new();
    for entry in entries {
        let Some(name) = entry["name"].as_str().filter(|name| valid_npm_name(name)) else {
            continue;
        };
        if plugins.iter().any(|p: &PluginCatalogEntry| p.name == name) {
            continue;
        }
        let (Some(description), Some(version), Some(installed)) = (
            entry["description"].as_str(),
            entry["version"].as_str(),
            entry["installed"].as_bool(),
        ) else {
            continue;
        };
        if description.len() > MAX_DESCRIPTION_LENGTH || version.len() > MAX_NAME_LENGTH {
            continue;
        }
        let installed_version = match entry.get("installedVersion") {
            None | Some(Value::Null) => None,
            Some(Value::String(version)) if !version.trim().is_empty() => Some(version.clone()),
            _ => continue,
        };
        plugins.push(PluginCatalogEntry {
            name: name.to_owned(),
            description: description.to_owned(),
            version: version.to_owned(),
            installed,
            installed_version,
            update_available: entry["updateAvailable"] == json!(true),
            local_only: entry["localOnly"] == json!(true),
        });
    }
    Ok(PluginCatalog { plugins, partial })
}

// WorkBuddy's status handler can migrate local config. A passive inventory
// read only queries status routes that are read-only. Qoder's two sites
// together describe whether any account is connected to the plugin.
const STATUS_ROUTES: &[(&str, &[&str])] = &[
    ("codex", &["/api/codex/status"]),
    ("gemini-oauth", &["/api/gemini-oauth/status"]),
    ("kiro", &["/api/kiro/status"]),
    ("cursor", &["/api/cursor/status"]),
    ("grok", &["/api/grok/status"]),
    ("qoder", &["/api/qoder/status", "/api/qoder/cn/status"]),
];

async fn connection_state(
    client: &AdminClient,
    id: &str,
    paths: &[&'static str],
) -> ConnectionState {
    use ConnectionState::*;
    let mut combined = Disconnected;
    for path in paths {
        // The authenticated transport caps both the status body and read time.
        let state = match client.quota_json(Method::GET, path, None).await {
            Ok(body) if matches!(id, "kiro" | "gemini-oauth") => {
                match body["connected"].as_bool() {
                    Some(true) => Connected,
                    Some(false) => Disconnected,
                    _ => Unknown,
                }
            }
            Ok(body) => match body["status"].as_str() {
                Some("connected") => Connected,
                Some("not_connected") => Disconnected,
                _ => Unknown,
            },
            Err(_) => Unknown,
        };
        match state {
            Connected => return Connected,
            Unknown => combined = Unknown,
            Disconnected => (),
        }
    }
    combined
}

// ============================== Service ==============================

pub struct PluginsService {
    client: Option<AdminClient>,
}

impl PluginsService {
    pub fn new(client: Option<AdminClient>) -> Self {
        Self { client }
    }

    async fn manifests(&self) -> Result<PluginInventory, &'static str> {
        let client = self.client.as_ref().ok_or(ERR_UNAVAILABLE)?;
        let response = client
            .get_json("/api/plugins")
            .await
            .map_err(|_| ERR_UNAVAILABLE)?;
        inventory_from(&response)
    }

    async fn inventory(&self) -> Result<PluginInventory, &'static str> {
        let mut inventory = self.manifests().await?;
        let client = self.client.as_ref().ok_or(ERR_UNAVAILABLE)?;
        let mut probes = tokio::task::JoinSet::new();
        for &(id, paths) in STATUS_ROUTES {
            if let Some(index) = inventory
                .plugins
                .iter()
                .position(|row| row.loaded && row.id == id)
            {
                inventory.plugins[index].connection_state = Some(ConnectionState::Unknown);
                let client = client.clone();
                probes.spawn(async move { (index, connection_state(&client, id, paths).await) });
            }
        }
        while let Some(result) = probes.join_next().await {
            if let Ok((index, state)) = result {
                inventory.plugins[index].connection_state = Some(state);
            }
        }
        Ok(inventory)
    }

    async fn catalog(&self) -> Result<PluginCatalog, &'static str> {
        let client = self.client.as_ref().ok_or(ERR_UNAVAILABLE)?;
        let response = client
            .get_json("/api/plugins/catalog")
            .await
            .map_err(|_| ERR_REGISTRY)?;
        catalog_from(&response)
    }

    async fn install(
        &self,
        name: Option<Value>,
        update: Option<Value>,
    ) -> Result<InstallOutcome, &'static str> {
        let Some(Value::String(name)) = name else {
            return Err(ERR_INVALID);
        };
        if !valid_npm_name(&name) {
            return Err(ERR_INVALID);
        }
        let update = match update {
            None | Some(Value::Null) => false,
            Some(Value::Bool(update)) => update,
            Some(_) => return Err(ERR_INVALID),
        };
        let client = self.client.as_ref().ok_or(ERR_UNAVAILABLE)?;
        let _write = client.write_guard().await;
        // Validate against a FRESH, complete catalog under the write lock —
        // never a cached or partial list. The npm name allowlist above already
        // excludes paths, URLs and version tags.
        let catalog = self.catalog().await?;
        if catalog.partial {
            return Err(ERR_REGISTRY);
        }
        let entry = catalog
            .plugins
            .iter()
            .find(|entry| entry.name == name)
            .ok_or(ERR_NOT_LISTED)?;
        // Fail closed when the offered version is not a valid semantic version
        // (the route's own updateAvailable uses semver valid + gt).
        let latest = semver::Version::parse(&entry.version).map_err(|_| ERR_REGISTRY)?;
        if update {
            let current = entry
                .installed_version
                .as_deref()
                .and_then(|version| semver::Version::parse(version).ok())
                .ok_or(ERR_NO_UPDATE)?;
            // Independently re-check the upgrade direction: a stale or lying
            // catalog must never turn the update lane into a downgrade.
            if !entry.installed || !entry.update_available || latest <= current {
                return Err(ERR_NO_UPDATE);
            }
        } else if entry.installed {
            return Err(ERR_ALREADY_INSTALLED);
        }
        // force is the documented update/replace lane (same staged atomic
        // swap); a plain install never forces over an existing directory.
        let body = json!({"name": name, "force": update});
        let response = client
            .request_with_timeout(
                Method::POST,
                "/api/plugins/install",
                Some(&body),
                INSTALL_TIMEOUT,
            )
            .await
            .map_err(|_| ERR_INSTALL)?;
        let confirmed: Value = response.json().await.map_err(|_| ERR_INSTALL)?;
        // The route confirms with the VALIDATED manifest name/version and an
        // explicit restartRequired:true. The manifest id may differ from the
        // npm name, and the registry search index may lag the packed latest
        // version, so confirmation checks shape, not equality with the catalog.
        if confirmed["ok"] != json!(true)
            || confirmed["restartRequired"] != json!(true)
            || !confirmed["name"].as_str().is_some_and(valid_plugin_name)
            || !confirmed["version"]
                .as_str()
                .is_some_and(|version| semver::Version::parse(version).is_ok())
        {
            return Err(ERR_INSTALL);
        }
        // Never restart here: the user restarts explicitly via service controls.
        Ok(InstallOutcome {
            restart_required: true,
        })
    }

    async fn action(
        &self,
        id: Option<Value>,
        action: Option<Value>,
    ) -> Result<ActionOutcome, &'static str> {
        let (Some(Value::String(id)), Some(Value::String(action))) = (id, action) else {
            return Err(ERR_INVALID);
        };
        if !valid_plugin_name(&id) {
            return Err(ERR_INVALID);
        }
        let route = action_routes(&id)
            .iter()
            .find(|route| route.action == action)
            .ok_or(ERR_UNSUPPORTED)?;
        let client = self.client.as_ref().ok_or(ERR_UNAVAILABLE)?;
        let _write = client.write_guard().await;
        // Actions drive live plugin routes: confirm the plugin is actually
        // activated on a fresh read instead of trusting a stale UI list.
        let inventory = self.manifests().await?;
        if !inventory
            .plugins
            .iter()
            .any(|entry| entry.id == id && entry.loaded)
        {
            return Err(ERR_NOT_LOADED);
        }
        let (method, body) = if route.get {
            (Method::GET, None)
        } else {
            (Method::POST, Some(json!({})))
        };
        let response = client
            .request_with_timeout(method, route.path, body.as_ref(), ACTION_TIMEOUT)
            .await
            .map_err(|_| ERR_ACTION)?;
        let confirmed: Value = response.json().await.map_err(|_| ERR_ACTION)?;
        let ok = match route.confirm {
            Confirmation::SuccessTrue => confirmed["success"] == json!(true),
            Confirmation::OkTrue => confirmed["ok"] == json!(true),
            Confirmation::JsonObject => confirmed.is_object(),
            Confirmation::AnyJson => true,
        };
        if !ok {
            return Err(ERR_ACTION);
        }
        Ok(ActionOutcome { success: true })
    }
}

// ============================== Commands ==============================

#[tauri::command]
pub async fn plugin_inventory(
    window: WebviewWindow,
    service: tauri::State<'_, PluginsService>,
) -> Result<PluginInventory, String> {
    crate::popup::guard(&window)?;
    service.inventory().await.map_err(str::to_owned)
}

#[tauri::command]
pub async fn plugin_catalog(
    window: WebviewWindow,
    service: tauri::State<'_, PluginsService>,
) -> Result<PluginCatalog, String> {
    crate::popup::guard(&window)?;
    service.catalog().await.map_err(str::to_owned)
}

#[tauri::command]
pub async fn plugin_install(
    window: WebviewWindow,
    service: tauri::State<'_, PluginsService>,
    name: Option<Value>,
    update: Option<Value>,
) -> Result<InstallOutcome, String> {
    crate::popup::guard(&window)?;
    service.install(name, update).await.map_err(str::to_owned)
}

#[tauri::command]
pub async fn plugin_action(
    window: WebviewWindow,
    service: tauri::State<'_, PluginsService>,
    id: Option<Value>,
    action: Option<Value>,
) -> Result<ActionOutcome, String> {
    crate::popup::guard(&window)?;
    service.action(id, action).await.map_err(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::mock::{response, Mock};

    fn catalog_entry(name: &str, version: &str, installed: bool) -> Value {
        json!({
            "name": name, "description": "a provider plugin", "version": version,
            "installed": installed,
            "installedVersion": if installed { json!("1.0.0") } else { Value::Null },
        })
    }

    fn catalog(entries: Vec<Value>) -> Value {
        json!({"ok": true, "plugins": entries})
    }

    fn installed_record(name: &str, version: &str) -> Value {
        json!({"name": name, "version": version, "enabled": true,
            "cardUrl": format!("/plugins/{name}/card.js"), "locales": {"en": {}}})
    }

    fn failed_record(name: &str) -> Value {
        json!({"name": name, "version": null, "enabled": true,
            "error": "plugin missing or failed to load"})
    }

    // ------------------------------ inventory ------------------------------

    #[tokio::test]
    async fn inventory_separates_loaded_from_installed_and_advertises_only_safe_actions() {
        let mock = Mock::new(vec![response(json!({"plugins": [
            installed_record("codex", "1.0.14"),
            installed_record("gemini-oauth", "1.0.14"),
            installed_record("workbuddy", "1.0.3"),
            installed_record("kiro", "0.1.3"),
            installed_record("grok", "0.1.2"),
            installed_record("cursor", "0.1.1"),
            installed_record("qoder", "0.3.5"),
            installed_record("third-party", "9.9.9"),
            failed_record("codex-failed"),
            {"name": "disabled", "version": null, "enabled": false, "error": "disabled"},
        ]}))]);
        let inventory = PluginsService::new(Some(mock.client()))
            .manifests()
            .await
            .unwrap();
        let actions = |id: &str| {
            inventory
                .plugins
                .iter()
                .find(|p| p.id == id)
                .unwrap()
                .actions
                .clone()
        };
        assert_eq!(actions("codex"), ["sync", "usage", "disconnect"]);
        assert_eq!(actions("gemini-oauth"), ["sync", "usage", "disconnect"]);
        assert_eq!(actions("grok"), ["sync", "usage", "disconnect"]);
        assert_eq!(actions("cursor"), ["sync", "usage", "disconnect"]);
        // Selector-dependent disconnects and per-site qoder routes stay out.
        assert_eq!(actions("workbuddy"), ["sync", "usage"]);
        assert_eq!(actions("kiro"), ["sync", "usage"]);
        assert!(actions("qoder").is_empty());
        assert!(actions("third-party").is_empty());
        let failed = inventory
            .plugins
            .iter()
            .find(|p| p.id == "codex-failed")
            .unwrap();
        assert!(!failed.loaded);
        assert_eq!(failed.version, None);
        assert!(failed.actions.is_empty());
        let disabled = inventory
            .plugins
            .iter()
            .find(|p| p.id == "disabled")
            .unwrap();
        assert!(!disabled.loaded);
        assert!(disabled.actions.is_empty());
        let codex = inventory.plugins.iter().find(|p| p.id == "codex").unwrap();
        assert!(codex.loaded);
        assert_eq!(codex.version.as_deref(), Some("1.0.14"));
        assert_eq!(codex.name, "codex");
        let requests = mock.finish().await;
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with("GET /api/plugins "));
    }

    #[tokio::test]
    async fn inventory_skips_malformed_records_and_rejects_malformed_payloads() {
        let mock = Mock::new(vec![response(json!({"plugins": [
            null, {}, {"name": "../escape", "version": "1.0.0", "enabled": true},
            {"name": "bad/name", "version": "1.0.0", "enabled": true},
            {"name": 7, "version": "1.0.0", "enabled": true},
            installed_record("codex", "1.0.0"),
            installed_record("codex", "2.0.0"),
            {"name": "no-version", "enabled": true},
        ]}))]);
        let inventory = PluginsService::new(Some(mock.client()))
            .manifests()
            .await
            .unwrap();
        assert_eq!(inventory.plugins.len(), 2);
        assert_eq!(inventory.plugins[0].version.as_deref(), Some("1.0.0"));
        assert!(!inventory.plugins[1].loaded);
        assert!(inventory.plugins[1].actions.is_empty());
        mock.finish().await;
        for bad in [json!({}), json!({"plugins": {}}), json!([])] {
            let mock = Mock::new(vec![response(bad)]);
            assert_eq!(
                PluginsService::new(Some(mock.client()))
                    .manifests()
                    .await
                    .unwrap_err(),
                ERR_INVENTORY
            );
            mock.finish().await;
        }
        assert_eq!(
            PluginsService::new(None).manifests().await.unwrap_err(),
            ERR_UNAVAILABLE
        );
        let mock = Mock::new(vec![(500, "LEAK_SECRET".into())]);
        let error = PluginsService::new(Some(mock.client()))
            .manifests()
            .await
            .unwrap_err();
        assert!(!error.contains("LEAK_SECRET"));
        mock.finish().await;
    }

    #[tokio::test]
    async fn inventory_projects_only_connection_state_from_status() {
        for (id, path, reply, state) in [
            (
                "codex",
                "/api/codex/status",
                response(json!({"status":"connected", "email":"private", "accountId":"private"})),
                "connected",
            ),
            (
                "kiro",
                "/api/kiro/status",
                response(json!({"connected":false,"accounts":["private"]})),
                "disconnected",
            ),
            (
                "gemini-oauth",
                "/api/gemini-oauth/status",
                response(json!({"connected":true,"email":"private"})),
                "connected",
            ),
            (
                "cursor",
                "/api/cursor/status",
                response(json!({"status":"not_connected","account":"private"})),
                "disconnected",
            ),
            (
                "grok",
                "/api/grok/status",
                response(json!({"status":"expired"})),
                "unknown",
            ),
            (
                "codex",
                "/api/codex/status",
                (503, "private".into()),
                "unknown",
            ),
            (
                "codex",
                "/api/codex/status",
                response(json!({"status": "private"})),
                "unknown",
            ),
        ] {
            let mock = Mock::new(vec![
                response(
                    json!({"plugins":[installed_record(id, "1.0.0"), failed_record("qoder"), installed_record("unknown-plugin", "1.0.0"), installed_record("workbuddy", "1.0.0")]}),
                ),
                reply,
            ]);
            let inventory = PluginsService::new(Some(mock.client()))
                .inventory()
                .await
                .unwrap();
            let safe = serde_json::to_value(inventory).unwrap();
            assert_eq!(safe["plugins"][0]["connectionState"], state);
            for index in 1..4 {
                assert!(safe["plugins"][index].get("connectionState").is_none());
            }
            assert!(!safe.to_string().contains("private"));
            let requests = mock.finish().await;
            assert_eq!(requests.len(), 2);
            assert!(requests[1].starts_with(&format!("GET {path} ")));
        }
    }

    #[tokio::test]
    async fn qoder_connection_state_covers_both_sites() {
        for (international, cn, expected) in [
            ("not_connected", "connected", ConnectionState::Connected),
            (
                "not_connected",
                "not_connected",
                ConnectionState::Disconnected,
            ),
            ("invalid", "not_connected", ConnectionState::Unknown),
        ] {
            let mock = Mock::new(vec![
                response(json!({"plugins": [installed_record("qoder", "0.3.5")]})),
                response(json!({"status":international})),
                response(json!({"status":cn})),
            ]);
            let inventory = PluginsService::new(Some(mock.client()))
                .inventory()
                .await
                .unwrap();
            assert_eq!(inventory.plugins[0].connection_state, Some(expected));
            let requests = mock.finish().await;
            assert!(requests[1].starts_with("GET /api/qoder/status "));
            assert!(requests[2].starts_with("GET /api/qoder/cn/status "));
        }
    }

    // ------------------------------ catalog ------------------------------

    #[tokio::test]
    async fn catalog_projects_installed_manifest_version_and_upgrade_flags() {
        let mut outdated = catalog_entry("@wengine-ai/ccr-provider-codex", "1.1.0", true);
        outdated["installedVersion"] = json!("1.0.0");
        outdated["updateAvailable"] = json!(true);
        let local = json!({"name": "local-plugin", "description": "", "version": "0.2.0",
            "installed": true, "installedVersion": "0.2.0", "localOnly": true});
        let mock = Mock::new(vec![response(catalog(vec![
            outdated,
            catalog_entry("@wengine-ai/ccr-provider-grok", "0.1.2", false),
            local,
        ]))]);
        let catalog = PluginsService::new(Some(mock.client()))
            .catalog()
            .await
            .unwrap();
        assert!(!catalog.partial);
        assert_eq!(
            serde_json::to_value(&catalog).unwrap(),
            json!({"plugins": [
                {"name": "@wengine-ai/ccr-provider-codex", "description": "a provider plugin",
                 "version": "1.1.0", "installed": true, "installedVersion": "1.0.0",
                 "updateAvailable": true, "localOnly": false},
                {"name": "@wengine-ai/ccr-provider-grok", "description": "a provider plugin",
                 "version": "0.1.2", "installed": false, "installedVersion": null,
                 "updateAvailable": false, "localOnly": false},
                {"name": "local-plugin", "description": "", "version": "0.2.0",
                 "installed": true, "installedVersion": "0.2.0",
                 "updateAvailable": false, "localOnly": true},
            ], "partial": false})
        );
        let requests = mock.finish().await;
        assert!(requests[0].starts_with("GET /api/plugins/catalog "));
    }

    #[tokio::test]
    async fn registry_outage_is_partial_and_malformed_catalogs_fail_closed() {
        let mock = Mock::new(vec![response(
            json!({"ok": true, "plugins": [], "warning": "registry_unavailable"}),
        )]);
        let outage = PluginsService::new(Some(mock.client()))
            .catalog()
            .await
            .unwrap();
        assert!(outage.partial);
        assert!(outage.plugins.is_empty());
        mock.finish().await;
        for bad in [
            json!({"ok": false, "plugins": []}),
            json!({"ok": true}),
            json!({"ok": true, "plugins": [], "warning": 7}),
            json!([]),
        ] {
            let mock = Mock::new(vec![response(bad)]);
            assert_eq!(
                PluginsService::new(Some(mock.client()))
                    .catalog()
                    .await
                    .unwrap_err(),
                ERR_REGISTRY
            );
            mock.finish().await;
        }
        // Malformed rows are skipped, never half-projected.
        let mock = Mock::new(vec![response(catalog(vec![
            json!({"name": "ok-plugin", "description": "", "version": "1.0.0", "installed": false}),
            json!({"name": "https://evil.example/x", "description": "", "version": "1.0.0", "installed": false}),
            json!({"name": "no-installed", "description": "", "version": "1.0.0"}),
            json!({"name": "bad-version", "description": "", "version": 7, "installed": false}),
            json!({"name": "bad-installed-version", "description": "", "version": "1.0.0", "installed": true, "installedVersion": 7}),
        ]))]);
        let projected = PluginsService::new(Some(mock.client()))
            .catalog()
            .await
            .unwrap();
        assert_eq!(projected.plugins.len(), 1);
        assert_eq!(projected.plugins[0].name, "ok-plugin");
        mock.finish().await;
        assert_eq!(
            PluginsService::new(None).catalog().await.unwrap_err(),
            ERR_UNAVAILABLE
        );
    }

    // ------------------------------ install ------------------------------

    #[tokio::test]
    async fn install_validates_names_and_update_flag_before_any_request() {
        let mock = Mock::new(vec![]);
        let service = PluginsService::new(Some(mock.client()));
        for name in [
            None,
            Some(json!(7)),
            Some(json!("")),
            Some(json!("../path")),
            Some(json!("/abs/path")),
            Some(json!("https://evil.example/x.tgz")),
            Some(json!("@scope/pkg@1.0.0")),
            Some(json!("pkg@1.0.0")),
            Some(json!("-flag")),
            Some(json!("UPPERCASE")),
            Some(json!("@scope/")),
            Some(json!("@/pkg")),
            Some(json!("a".repeat(215))),
        ] {
            assert_eq!(service.install(name, None).await.unwrap_err(), ERR_INVALID);
        }
        for update in [json!("true"), json!(1), json!({})] {
            assert_eq!(
                service
                    .install(Some(json!("pkg")), Some(update))
                    .await
                    .unwrap_err(),
                ERR_INVALID
            );
        }
        assert!(mock.finish().await.is_empty());
        assert_eq!(
            PluginsService::new(None)
                .install(Some(json!("pkg")), None)
                .await
                .unwrap_err(),
            ERR_UNAVAILABLE
        );
    }

    #[tokio::test]
    async fn install_fails_closed_on_partial_missing_or_unvalidatable_catalog() {
        for (reply, error) in [
            (
                json!({"ok": true, "plugins": [], "warning": "registry_unavailable"}),
                ERR_REGISTRY,
            ),
            (catalog(vec![]), ERR_NOT_LISTED),
            (
                catalog(vec![catalog_entry("other-plugin", "1.0.0", false)]),
                ERR_NOT_LISTED,
            ),
            // Offered version is not valid semver → never installable.
            (
                catalog(vec![catalog_entry("pkg", "not-a-version", false)]),
                ERR_REGISTRY,
            ),
            (catalog(vec![catalog_entry("pkg", "", false)]), ERR_REGISTRY),
        ] {
            let mock = Mock::new(vec![response(reply)]);
            assert_eq!(
                PluginsService::new(Some(mock.client()))
                    .install(Some(json!("pkg")), None)
                    .await
                    .unwrap_err(),
                error
            );
            let requests = mock.finish().await;
            assert_eq!(requests.len(), 1);
            assert!(requests[0].starts_with("GET /api/plugins/catalog "));
        }
    }

    #[tokio::test]
    async fn plain_install_posts_unforced_and_requires_full_confirmation() {
        let mock = Mock::new(vec![
            response(catalog(vec![catalog_entry("@scope/pkg", "1.2.3", false)])),
            response(
                json!({"ok": true, "name": "pkg", "version": "1.2.3", "restartRequired": true}),
            ),
        ]);
        let outcome = PluginsService::new(Some(mock.client()))
            .install(Some(json!("@scope/pkg")), Some(json!(false)))
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(outcome).unwrap(),
            json!({"restartRequired": true})
        );
        let requests = mock.finish().await;
        assert_eq!(requests.len(), 2);
        assert!(requests[1].starts_with("POST /api/plugins/install "));
        assert_eq!(
            serde_json::from_str::<Value>(requests[1].split_once("\r\n\r\n").unwrap().1).unwrap(),
            json!({"name": "@scope/pkg", "force": false})
        );
        // Missing/false confirmation fields are failures, never a silent success.
        for confirmed in [
            json!({"ok": false, "error": "install_failed"}),
            json!({"ok": true, "name": "pkg", "version": "1.2.3"}),
            json!({"ok": true, "name": "pkg", "version": "1.2.3", "restartRequired": false}),
            json!({"ok": true, "name": "../escape", "version": "1.2.3", "restartRequired": true}),
            json!({"ok": true, "name": "pkg", "version": "junk", "restartRequired": true}),
        ] {
            let mock = Mock::new(vec![
                response(catalog(vec![catalog_entry("pkg", "1.2.3", false)])),
                response(confirmed),
            ]);
            assert_eq!(
                PluginsService::new(Some(mock.client()))
                    .install(Some(json!("pkg")), None)
                    .await
                    .unwrap_err(),
                ERR_INSTALL
            );
            assert_eq!(mock.finish().await.len(), 2);
        }
        for reply in [(500, "LEAK_SECRET".into()), (200, "bad LEAK_SECRET".into())] {
            let mock = Mock::new(vec![
                response(catalog(vec![catalog_entry("pkg", "1.2.3", false)])),
                reply,
            ]);
            let error = PluginsService::new(Some(mock.client()))
                .install(Some(json!("pkg")), None)
                .await
                .unwrap_err();
            assert_eq!(error, ERR_INSTALL);
            assert!(!error.contains("LEAK_SECRET"));
            assert_eq!(mock.finish().await.len(), 2);
        }
    }

    #[tokio::test]
    async fn already_installed_never_posts_without_the_update_lane() {
        let mock = Mock::new(vec![response(catalog(vec![catalog_entry(
            "pkg", "1.2.3", true,
        )]))]);
        assert_eq!(
            PluginsService::new(Some(mock.client()))
                .install(Some(json!("pkg")), None)
                .await
                .unwrap_err(),
            ERR_ALREADY_INSTALLED
        );
        assert_eq!(mock.finish().await.len(), 1);
    }

    #[tokio::test]
    async fn update_requires_a_validated_upgrade_and_posts_force() {
        let mut upgradable = catalog_entry("pkg", "1.3.0", true);
        upgradable["installedVersion"] = json!("1.2.0");
        upgradable["updateAvailable"] = json!(true);
        let mock = Mock::new(vec![
            response(catalog(vec![upgradable.clone()])),
            response(
                json!({"ok": true, "name": "pkg", "version": "1.3.0", "restartRequired": true}),
            ),
        ]);
        let outcome = PluginsService::new(Some(mock.client()))
            .install(Some(json!("pkg")), Some(json!(true)))
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(outcome).unwrap(),
            json!({"restartRequired": true})
        );
        let requests = mock.finish().await;
        assert_eq!(
            serde_json::from_str::<Value>(requests[1].split_once("\r\n\r\n").unwrap().1).unwrap(),
            json!({"name": "pkg", "force": true})
        );
        // Every unvalidatable upgrade shape fails closed before any POST.
        let mut downgrade = upgradable.clone();
        downgrade["version"] = json!("1.1.0"); // lying updateAvailable flag
        let mut not_installed = upgradable.clone();
        not_installed["installed"] = json!(false);
        let mut no_flag = upgradable.clone();
        no_flag["updateAvailable"] = json!(false);
        let mut no_installed_version = upgradable.clone();
        no_installed_version["installedVersion"] = Value::Null;
        let mut bad_installed_version = upgradable.clone();
        bad_installed_version["installedVersion"] = json!("junk");
        let mut equal = upgradable.clone();
        equal["version"] = json!("1.2.0");
        for entry in [
            downgrade,
            not_installed,
            no_flag,
            no_installed_version,
            bad_installed_version,
            equal,
        ] {
            let mock = Mock::new(vec![response(catalog(vec![entry]))]);
            assert_eq!(
                PluginsService::new(Some(mock.client()))
                    .install(Some(json!("pkg")), Some(json!(true)))
                    .await
                    .unwrap_err(),
                ERR_NO_UPDATE
            );
            assert_eq!(mock.finish().await.len(), 1);
        }
    }

    #[tokio::test]
    async fn install_uses_the_shared_write_guard() {
        let mock = Mock::new(vec![
            response(catalog(vec![catalog_entry("pkg", "1.2.3", false)])),
            response(
                json!({"ok": true, "name": "pkg", "version": "1.2.3", "restartRequired": true}),
            ),
        ]);
        let client = mock.client();
        let service = PluginsService::new(Some(client.clone()));
        let guard = client.write_guard().await;
        let install = service.install(Some(json!("pkg")), None);
        tokio::pin!(install);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut install)
                .await
                .is_err()
        );
        drop(guard);
        install.await.unwrap();
        assert_eq!(mock.finish().await.len(), 2);
    }

    // ------------------------------ action ------------------------------

    #[tokio::test]
    async fn unsupported_or_invalid_actions_never_touch_the_gateway() {
        let mock = Mock::new(vec![]);
        let service = PluginsService::new(Some(mock.client()));
        for (id, action) in [
            (None, Some(json!("sync"))),
            (Some(json!("codex")), None),
            (Some(json!(7)), Some(json!("sync"))),
            (Some(json!("codex")), Some(json!(7))),
            (Some(json!("../escape")), Some(json!("sync"))),
            (Some(json!("codex")), Some(json!("login/start"))),
            (Some(json!("codex")), Some(json!("models/hide"))),
            (Some(json!("codex")), Some(json!("reset-credits/consume"))),
            // Selector-dependent actions are not in the desktop contract.
            (Some(json!("workbuddy")), Some(json!("disconnect"))),
            (Some(json!("kiro")), Some(json!("disconnect"))),
            (Some(json!("qoder")), Some(json!("sync"))),
            (Some(json!("qoder")), Some(json!("usage"))),
            (Some(json!("qoder")), Some(json!("disconnect"))),
            (Some(json!("unknown-plugin")), Some(json!("sync"))),
        ] {
            let error = service.action(id, action).await.unwrap_err();
            assert!(error == ERR_INVALID || error == ERR_UNSUPPORTED);
        }
        assert!(mock.finish().await.is_empty());
        assert_eq!(
            PluginsService::new(None)
                .action(Some(json!("codex")), Some(json!("sync")))
                .await
                .unwrap_err(),
            ERR_UNAVAILABLE
        );
    }

    #[tokio::test]
    async fn actions_require_a_loaded_plugin_on_a_fresh_read() {
        for record in [
            failed_record("codex"),
            json!({"name": "codex", "version": null, "enabled": false, "error": "disabled"}),
        ] {
            let mock = Mock::new(vec![response(json!({"plugins": [record]}))]);
            assert_eq!(
                PluginsService::new(Some(mock.client()))
                    .action(Some(json!("codex")), Some(json!("sync")))
                    .await
                    .unwrap_err(),
                ERR_NOT_LOADED
            );
            let requests = mock.finish().await;
            assert_eq!(requests.len(), 1);
            assert!(requests[0].starts_with("GET /api/plugins "));
        }
        let mock = Mock::new(vec![response(json!({"plugins": []}))]);
        assert_eq!(
            PluginsService::new(Some(mock.client()))
                .action(Some(json!("codex")), Some(json!("sync")))
                .await
                .unwrap_err(),
            ERR_NOT_LOADED
        );
        mock.finish().await;
    }

    #[tokio::test]
    async fn each_action_hits_its_fixed_route_and_confirms_per_contract() {
        // (id, action, expected request prefix, expected body, confirming reply)
        let cases: &[(&str, &str, &str, Option<&str>, Value)] = &[
            (
                "codex",
                "sync",
                "POST /api/codex/sync ",
                Some("{}"),
                json!({"success": true, "models": [], "modelCount": 0}),
            ),
            (
                "codex",
                "usage",
                "POST /api/codex/usage ",
                Some("{}"),
                Value::Null,
            ),
            (
                "codex",
                "disconnect",
                "POST /api/codex/disconnect ",
                Some("{}"),
                json!({"success": true}),
            ),
            (
                "gemini-oauth",
                "sync",
                "POST /api/gemini-oauth/sync ",
                Some("{}"),
                json!({"ok": true}),
            ),
            (
                "gemini-oauth",
                "usage",
                "GET /api/gemini-oauth/quota ",
                None,
                Value::Null,
            ),
            (
                "gemini-oauth",
                "disconnect",
                "POST /api/gemini-oauth/disconnect ",
                Some("{}"),
                json!({"ok": true, "removedModelRefs": [], "defaultFallback": null}),
            ),
            (
                "workbuddy",
                "sync",
                "POST /api/workbuddy/sync ",
                Some("{}"),
                json!({"success": true, "models": [], "modelCount": 0}),
            ),
            (
                "workbuddy",
                "usage",
                "POST /api/workbuddy/usage ",
                Some("{}"),
                json!({"ok": true, "usage": null}),
            ),
            (
                "kiro",
                "sync",
                "POST /api/kiro/sync ",
                Some("{}"),
                json!({"success": true, "models": []}),
            ),
            (
                "kiro",
                "usage",
                "POST /api/kiro/usage ",
                Some("{}"),
                json!({"known": true, "windows": []}),
            ),
            (
                "grok",
                "sync",
                "POST /api/grok/sync ",
                Some("{}"),
                json!({"success": true}),
            ),
            (
                "grok",
                "usage",
                "POST /api/grok/usage ",
                Some("{}"),
                json!({"known": true}),
            ),
            (
                "grok",
                "disconnect",
                "POST /api/grok/disconnect ",
                Some("{}"),
                json!({"success": true}),
            ),
            (
                "cursor",
                "sync",
                "POST /api/cursor/sync ",
                Some("{}"),
                json!({"success": true}),
            ),
            (
                "cursor",
                "usage",
                "POST /api/cursor/usage ",
                Some("{}"),
                json!({"known": false, "windows": []}),
            ),
            (
                "cursor",
                "disconnect",
                "POST /api/cursor/disconnect ",
                Some("{}"),
                json!({"success": true}),
            ),
        ];
        for (id, action, prefix, body, reply) in cases {
            let mock = Mock::new(vec![
                response(json!({"plugins": [installed_record(id, "1.0.0")]})),
                response(reply.clone()),
            ]);
            let outcome = PluginsService::new(Some(mock.client()))
                .action(Some(json!(id)), Some(json!(action)))
                .await
                .unwrap_or_else(|error| panic!("{id}/{action}: {error}"));
            assert_eq!(
                serde_json::to_value(outcome).unwrap(),
                json!({"success": true})
            );
            let requests = mock.finish().await;
            assert_eq!(requests.len(), 2);
            assert!(requests[0].starts_with("GET /api/plugins "));
            assert!(
                requests[1].starts_with(prefix),
                "{id}/{action}: {}",
                requests[1]
            );
            let sent = requests[1].split_once("\r\n\r\n").unwrap().1;
            match body {
                Some(body) => assert_eq!(sent, *body),
                None => assert_eq!(sent, ""),
            }
            assert!(requests.iter().all(|request| request
                .to_lowercase()
                .contains("x-api-key: test-admin-key\r\n")));
        }
    }

    #[tokio::test]
    async fn unconfirmed_or_failed_actions_are_fixed_errors() {
        // (id, action, reply that must NOT confirm)
        let cases: &[(&str, &str, Value)] = &[
            (
                "codex",
                "sync",
                json!({"success": false, "error": "codex_models_fetch_failed"}),
            ),
            ("codex", "sync", json!({"ok": true})),
            ("gemini-oauth", "sync", json!({"ok": false})),
            ("gemini-oauth", "disconnect", json!({"success": true})),
            (
                "workbuddy",
                "usage",
                json!({"ok": false, "error": "source_invalid"}),
            ),
            ("kiro", "usage", Value::Null),
            ("grok", "usage", json!("not-an-object")),
            ("cursor", "disconnect", json!({"success": "true"})),
        ];
        for (id, action, reply) in cases {
            let mock = Mock::new(vec![
                response(json!({"plugins": [installed_record(id, "1.0.0")]})),
                response(reply.clone()),
            ]);
            assert_eq!(
                PluginsService::new(Some(mock.client()))
                    .action(Some(json!(id)), Some(json!(action)))
                    .await
                    .unwrap_err(),
                ERR_ACTION,
                "{id}/{action}"
            );
            assert_eq!(mock.finish().await.len(), 2);
        }
        for reply in [
            (403, "LEAK_SECRET".into()),
            (500, "LEAK_SECRET".into()),
            (200, "bad LEAK_SECRET".into()),
        ] {
            let mock = Mock::new(vec![
                response(json!({"plugins": [installed_record("codex", "1.0.0")]})),
                reply,
            ]);
            let error = PluginsService::new(Some(mock.client()))
                .action(Some(json!("codex")), Some(json!("disconnect")))
                .await
                .unwrap_err();
            assert_eq!(error, ERR_ACTION);
            assert!(!error.contains("LEAK_SECRET"));
            assert_eq!(mock.finish().await.len(), 2);
        }
    }

    #[tokio::test]
    async fn actions_use_the_shared_write_guard() {
        let mock = Mock::new(vec![
            response(json!({"plugins": [installed_record("codex", "1.0.0")]})),
            response(json!({"success": true})),
        ]);
        let client = mock.client();
        let service = PluginsService::new(Some(client.clone()));
        let guard = client.write_guard().await;
        let action = service.action(Some(json!("codex")), Some(json!("sync")));
        tokio::pin!(action);
        assert!(tokio::time::timeout(Duration::from_millis(20), &mut action)
            .await
            .is_err());
        drop(guard);
        action.await.unwrap();
        assert_eq!(mock.finish().await.len(), 2);
    }

    // ------------------------------ name allowlists ------------------------------

    #[test]
    fn name_allowlists_mirror_the_shared_install_core() {
        for name in ["codex", "gemini-oauth", "WorkBuddy", "a", "plugin-2"] {
            assert!(valid_plugin_name(name), "{name}");
        }
        for name in [
            "",
            "../x",
            "a/b",
            "@scope/x",
            "a.b",
            "a_b",
            "-x",
            "x y",
            "x\n",
            &"a".repeat(215),
        ] {
            assert!(!valid_plugin_name(name), "{name}");
        }
        for name in [
            "pkg",
            "my-plugin",
            "my_plugin",
            "my.plugin",
            "~pkg",
            "@scope/pkg",
            "@my-scope/my.pkg-2",
            "@scope/-pkg",
        ] {
            assert!(valid_npm_name(name), "{name}");
        }
        for name in [
            "",
            "-pkg",
            ".pkg",
            "_pkg",
            "@scope/.pkg",
            "Pkg",
            "UPPER",
            "pkg@1.0.0",
            "@scope/pkg@1.0.0",
            "/path",
            "./path",
            "../path",
            "https://x/y",
            "@scope/",
            "@/pkg",
            "@scope",
            "a/b/c",
            "pkg name",
            "pkg\n",
            &"a".repeat(215),
        ] {
            assert!(!valid_npm_name(name), "{name}");
        }
    }
}
