//! Desktop project-configuration contracts: per-project routing overrides.
//!
//! Every command is restricted to the local control-center views via
//! `popup::guard`. Projections are typed whitelists: raw configuration,
//! credentials, config paths, and upstream error bodies never cross IPC.
//! Mutations share the AdminClient write lock with the routing tab, resolve
//! project ids against a fresh `GET /api/projects` allowlist, reject stale
//! revisions before writing, and verify the persisted project through a fresh
//! `GET /api/projects` readback (mutation responses are never trusted as
//! readback). Project writes never POST `/api/config`: the global config is
//! read-only here. The gateway persists a project Router before running its
//! takeover sync, so a failed mutation may still have written config; fixed
//! error messages ask for a refresh instead of claiming nothing was written.

use crate::api::AdminClient;
use crate::control::{encode_query, revision_of, valid_alias, FAMILIES, SCENARIOS};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashSet};
use std::time::Duration;
use tauri::WebviewWindow;

/// Clients supporting project-level takeover (shared PROJECT_TAKEOVER_CLIENT_IDS).
/// Codex is excluded: its config is global-only, never per project.
const TAKEOVER_CLIENTS: [&str; 5] = ["claudeCode", "pi", "qwenCode", "opencode", "zcode"];
/// Project writes run server-side backup + takeover sync; match the routing writers.
const WRITE_TIMEOUT: Duration = Duration::from_secs(20);

// Safe fixed error messages. Transport failures on mutations are mapped to
// these so upstream bodies and project ids never reach the UI.
const ERR_OFFLINE: &str = "Gateway connection is unavailable";
const ERR_STALE: &str = "Project draft is stale; refresh the panel and retry";
const ERR_PROJECTS_LIST: &str = "Project list is unavailable";
const ERR_NOT_FOUND: &str = "Project is no longer configured; refresh the panel";
const ERR_PATH_INVALID: &str = "A valid absolute project path is required";
const ERR_TARGET_UNAVAILABLE: &str = "Routing choice is no longer available";
const ERR_FIELD: &str = "Unknown project routing field";
const ERR_ALIAS_INVALID: &str = "Invalid model alias name";
const ERR_THRESHOLD: &str = "Context thresholds must be positive integers";
const ERR_CLIENT_INPUT: &str = "Unknown takeover client";
const ERR_ADD_FAILED: &str = "Project add failed; refresh the panel to check the current state";
const ERR_SAVE_FAILED: &str = "Project update failed; refresh the panel to check the saved state";
const ERR_TAKEOVER_FAILED: &str =
    "Project takeover update failed; refresh the panel to check the current state";
const ERR_DELETE_FAILED: &str =
    "Project delete failed; refresh the panel to check the current state";
const ERR_ADD_NOT_CONFIRMED: &str = "Project add was not confirmed; refresh the panel";
const ERR_SAVE_NOT_CONFIRMED: &str = "Project update was not confirmed; refresh the panel";
const ERR_TAKEOVER_NOT_CONFIRMED: &str =
    "Project takeover update was not confirmed; refresh the panel";
const ERR_DELETE_NOT_CONFIRMED: &str = "Project delete was not confirmed; refresh the panel";

// ============================== IPC projections ==============================

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ProjectsProvider {
    pub name: String,
    pub models: Vec<String>,
}

/// Ordered scenario fallback chains, keyed by scenario name.
type FallbackMap = BTreeMap<String, Vec<String>>;

/// Typed whitelist of the editable project Router fields. Every field is
/// optional: absence means "not configured" (never a false default), and on
/// save an absent supported field deletes that field from the raw Router.
/// Unknown raw fields are preserved by the merge but never projected here.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectRouter {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub think: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub long_context: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extended_context: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_search: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enable_family_routing: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enable_fallback: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enable_extended_context: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub long_context_threshold: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extended_context_threshold: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback: Option<FallbackMap>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub families: Option<BTreeMap<String, ProjectFamily>>,
}

/// Per-family overrides: scenario targets, extended-context switch and
/// thresholds, and fallback chains. No nested families or model aliases.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectFamily {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub think: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub long_context: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extended_context: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_search: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enable_extended_context: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub long_context_threshold: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extended_context_threshold: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback: Option<FallbackMap>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectView {
    pub id: String,
    /// User-facing project directory path; the only path allowed across IPC.
    pub path: String,
    /// True when the raw project Router is empty (follows the global config).
    /// Unknown-only raw fields still count as a custom Router.
    pub use_global: bool,
    pub router: ProjectRouter,
    /// Non-reversible change-detection digest of the fresh raw project entry
    /// plus the global config. Not decodable back into configuration.
    pub revision: String,
    pub takeover_clients: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsSnapshot {
    pub providers: Vec<ProjectsProvider>,
    /// Global Router projection; the root-level `fallback` map is nested here.
    pub global_router: ProjectRouter,
    pub projects: Vec<ProjectView>,
}

// ============================== IPC inputs ==============================

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectChange {
    pub id: String,
    pub revision: String,
    pub use_global: bool,
    /// Ignored when `use_global` is true (the gateway stores `{}` exactly).
    pub router: ProjectRouter,
}

impl ProjectRouter {
    fn scenario_targets(&self) -> [(&'static str, &Option<String>); 7] {
        [
            ("default", &self.default),
            ("background", &self.background),
            ("think", &self.think),
            ("longContext", &self.long_context),
            ("extendedContext", &self.extended_context),
            ("webSearch", &self.web_search),
            ("image", &self.image),
        ]
    }

    fn scenario_targets_mut(&mut self) -> [(&'static str, &mut Option<String>); 7] {
        [
            ("default", &mut self.default),
            ("background", &mut self.background),
            ("think", &mut self.think),
            ("longContext", &mut self.long_context),
            ("extendedContext", &mut self.extended_context),
            ("webSearch", &mut self.web_search),
            ("image", &mut self.image),
        ]
    }
}

impl ProjectFamily {
    fn scenario_targets(&self) -> [(&'static str, &Option<String>); 7] {
        [
            ("default", &self.default),
            ("background", &self.background),
            ("think", &self.think),
            ("longContext", &self.long_context),
            ("extendedContext", &self.extended_context),
            ("webSearch", &self.web_search),
            ("image", &self.image),
        ]
    }

    fn scenario_targets_mut(&mut self) -> [(&'static str, &mut Option<String>); 7] {
        [
            ("default", &mut self.default),
            ("background", &mut self.background),
            ("think", &mut self.think),
            ("longContext", &mut self.long_context),
            ("extendedContext", &mut self.extended_context),
            ("webSearch", &mut self.web_search),
            ("image", &mut self.image),
        ]
    }
}

// ============================== Service ==============================

pub struct ProjectsService {
    client: Option<AdminClient>,
}

impl ProjectsService {
    pub fn new(client: Option<AdminClient>) -> Self {
        Self { client }
    }

    fn client(&self) -> Result<&AdminClient, String> {
        self.client.as_ref().ok_or_else(|| ERR_OFFLINE.to_string())
    }

    /// Fresh global config + project allowlist. The config is read-only for
    /// projects: it feeds provider validation, the global-router clone base,
    /// and the revision digest.
    async fn fetch(&self) -> Result<(Value, Vec<Value>), String> {
        let client = self.client()?;
        let config = client.config().await?;
        let response = client.get_json("/api/projects").await?;
        let entries = response
            .get("projects")
            .and_then(Value::as_array)
            .ok_or_else(|| ERR_PROJECTS_LIST.to_string())?;
        Ok((
            config,
            entries
                .iter()
                .filter(|entry| entry.is_object())
                .cloned()
                .collect(),
        ))
    }

    pub(crate) async fn snapshot(&self) -> Result<ProjectsSnapshot, String> {
        let (config, entries) = self.fetch().await?;
        Ok(snapshot_from(&config, &entries))
    }

    pub(crate) async fn add(&self, path: &str) -> Result<ProjectsSnapshot, String> {
        let path = path.trim();
        if path.is_empty() || !std::path::Path::new(path).is_absolute() {
            return Err(ERR_PATH_INVALID.into());
        }
        let client = self.client()?;
        let _write = client.write_guard().await;
        // The server defaults new projects to Claude Code takeover + global router.
        let body = json!({ "path": path });
        let added = client
            .request_with_timeout(Method::POST, "/api/projects", Some(&body), WRITE_TIMEOUT)
            .await
            .map_err(|_| ERR_ADD_FAILED.to_string())?;
        let added: Value = added.json().await.map_err(|_| ERR_ADD_FAILED.to_string())?;
        // The response path is the server-normalized path; use it only to find
        // the project in a fresh allowlist readback, never as the readback itself.
        let added_path = added
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| ERR_ADD_NOT_CONFIRMED.to_string())?;
        let (config, entries) = self.fetch().await?;
        if !entries
            .iter()
            .any(|entry| entry.get("path").and_then(Value::as_str) == Some(added_path))
        {
            return Err(ERR_ADD_NOT_CONFIRMED.into());
        }
        Ok(snapshot_from(&config, &entries))
    }

    pub(crate) async fn save(&self, change: ProjectChange) -> Result<ProjectsSnapshot, String> {
        // Structural validation happens before any request or lock.
        let draft = normalize_router(change.router)?;
        let client = self.client()?;
        let _write = client.write_guard().await;
        let (config, entries) = self.fetch().await?;
        let entry = find_project(&entries, &change.id).ok_or_else(|| ERR_NOT_FOUND.to_string())?;
        if change.revision != project_revision(entry, &config) {
            return Err(ERR_STALE.into());
        }
        let router = if change.use_global {
            // Follow-global stores an empty Router exactly.
            Map::new()
        } else {
            apply_router(
                &save_base(entry, &config),
                &draft,
                &available_targets(&config),
            )?
        };
        let expected_global = router.is_empty();
        let path = format!("/api/projects/{}", encode_query(&change.id));
        let body = json!({ "Router": router });
        let saved = client
            .request_with_timeout(Method::PUT, &path, Some(&body), WRITE_TIMEOUT)
            .await
            .map_err(|_| ERR_SAVE_FAILED.to_string())?;
        // The response embeds configPath and is not trusted as readback.
        let _saved: Value = saved
            .json()
            .await
            .map_err(|_| ERR_SAVE_FAILED.to_string())?;
        let (config, entries) = self.fetch().await?;
        let view = find_project(&entries, &change.id)
            .and_then(|entry| project_view(entry, &config))
            .ok_or_else(|| ERR_SAVE_NOT_CONFIRMED.to_string())?;
        let confirmed =
            view.use_global == expected_global && (change.use_global || view.router == draft);
        if !confirmed {
            return Err(ERR_SAVE_NOT_CONFIRMED.into());
        }
        Ok(snapshot_from(&config, &entries))
    }

    pub(crate) async fn takeover(
        &self,
        id: &str,
        revision: &str,
        clients: &[String],
    ) -> Result<ProjectsSnapshot, String> {
        let mut selected: Vec<String> = Vec::new();
        for client_id in clients {
            if !TAKEOVER_CLIENTS.contains(&client_id.as_str()) {
                return Err(ERR_CLIENT_INPUT.into());
            }
            if !selected.contains(client_id) {
                selected.push(client_id.clone());
            }
        }
        let client = self.client()?;
        let _write = client.write_guard().await;
        let (config, entries) = self.fetch().await?;
        let entry = find_project(&entries, id).ok_or_else(|| ERR_NOT_FOUND.to_string())?;
        if revision != project_revision(entry, &config) {
            return Err(ERR_STALE.into());
        }
        let path = format!("/api/projects/{}/takeover", encode_query(id));
        let body = json!({ "clients": selected });
        let updated = client
            .request_with_timeout(Method::PUT, &path, Some(&body), WRITE_TIMEOUT)
            .await
            .map_err(|_| ERR_TAKEOVER_FAILED.to_string())?;
        let _updated: Value = updated
            .json()
            .await
            .map_err(|_| ERR_TAKEOVER_FAILED.to_string())?;
        let (config, entries) = self.fetch().await?;
        let view = find_project(&entries, id)
            .and_then(|entry| project_view(entry, &config))
            .ok_or_else(|| ERR_TAKEOVER_NOT_CONFIRMED.to_string())?;
        let actual: HashSet<&str> = view.takeover_clients.iter().map(String::as_str).collect();
        let expected: HashSet<&str> = selected.iter().map(String::as_str).collect();
        if actual != expected {
            return Err(ERR_TAKEOVER_NOT_CONFIRMED.into());
        }
        Ok(snapshot_from(&config, &entries))
    }

    pub(crate) async fn delete(
        &self,
        id: &str,
        revision: &str,
    ) -> Result<ProjectsSnapshot, String> {
        let client = self.client()?;
        let _write = client.write_guard().await;
        let (config, entries) = self.fetch().await?;
        let entry = find_project(&entries, id).ok_or_else(|| ERR_NOT_FOUND.to_string())?;
        if revision != project_revision(entry, &config) {
            return Err(ERR_STALE.into());
        }
        // Removes the CCR project configuration and restores client takeover;
        // the project source directory is never touched.
        let path = format!("/api/projects/{}", encode_query(id));
        let deleted = client
            .request_with_timeout(Method::DELETE, &path, None, WRITE_TIMEOUT)
            .await
            .map_err(|_| ERR_DELETE_FAILED.to_string())?;
        let _deleted: Value = deleted
            .json()
            .await
            .map_err(|_| ERR_DELETE_FAILED.to_string())?;
        let (config, entries) = self.fetch().await?;
        if find_project(&entries, id).is_some() {
            return Err(ERR_DELETE_NOT_CONFIRMED.into());
        }
        Ok(snapshot_from(&config, &entries))
    }
}

// ============================== Tauri commands ==============================

#[tauri::command]
pub async fn projects_snapshot(
    window: WebviewWindow,
    service: tauri::State<'_, ProjectsService>,
) -> Result<ProjectsSnapshot, String> {
    crate::popup::guard(&window)?;
    service.snapshot().await
}

#[tauri::command]
pub async fn projects_add(
    window: WebviewWindow,
    service: tauri::State<'_, ProjectsService>,
    path: String,
) -> Result<ProjectsSnapshot, String> {
    crate::popup::guard(&window)?;
    service.add(&path).await
}

#[tauri::command]
pub async fn projects_save(
    window: WebviewWindow,
    service: tauri::State<'_, ProjectsService>,
    change: ProjectChange,
) -> Result<ProjectsSnapshot, String> {
    crate::popup::guard(&window)?;
    service.save(change).await
}

#[tauri::command]
pub async fn projects_takeover(
    window: WebviewWindow,
    service: tauri::State<'_, ProjectsService>,
    id: String,
    revision: String,
    clients: Vec<String>,
) -> Result<ProjectsSnapshot, String> {
    crate::popup::guard(&window)?;
    service.takeover(&id, &revision, &clients).await
}

#[tauri::command]
pub async fn projects_delete(
    window: WebviewWindow,
    service: tauri::State<'_, ProjectsService>,
    id: String,
    revision: String,
) -> Result<ProjectsSnapshot, String> {
    crate::popup::guard(&window)?;
    service.delete(&id, &revision).await
}

// ============================== Projection ==============================

fn trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_owned)
        .collect()
}

fn positive_integer(value: Option<&Value>) -> Option<u64> {
    value.and_then(Value::as_u64).filter(|value| *value > 0)
}

fn projected_fallback(value: Option<&Value>) -> Option<FallbackMap> {
    let map = value.and_then(Value::as_object)?;
    let mut result = FallbackMap::new();
    for scenario in SCENARIOS {
        let entries = string_list(map.get(scenario));
        if !entries.is_empty() {
            result.insert(scenario.to_string(), entries);
        }
    }
    if result.is_empty() {
        None
    } else {
        Some(result)
    }
}

fn projected_models(value: Option<&Value>) -> Option<BTreeMap<String, String>> {
    let map = value.and_then(Value::as_object)?;
    let mut result = BTreeMap::new();
    for (alias, target) in map {
        if valid_alias(alias) {
            if let Some(target) = trimmed_string(Some(target)) {
                result.insert(alias.trim().to_owned(), target);
            }
        }
    }
    if result.is_empty() {
        None
    } else {
        Some(result)
    }
}

fn project_family_from(value: &Value) -> ProjectFamily {
    let mut result = ProjectFamily::default();
    for (name, slot) in result.scenario_targets_mut() {
        *slot = trimmed_string(value.get(name));
    }
    result.enable_extended_context = value.get("enableExtendedContext").and_then(Value::as_bool);
    result.long_context_threshold = positive_integer(value.get("longContextThreshold"));
    result.extended_context_threshold = positive_integer(value.get("extendedContextThreshold"));
    result.fallback = projected_fallback(value.get("fallback"));
    result
}

/// Projects only the whitelisted fields. `fallback_source` is the nested
/// `Router.fallback` for projects and the root `fallback` for the global config.
fn project_router_from(router: &Value, fallback_source: Option<&Value>) -> ProjectRouter {
    let mut result = ProjectRouter::default();
    for (name, slot) in result.scenario_targets_mut() {
        *slot = trimmed_string(router.get(name));
    }
    result.enable_family_routing = router.get("enableFamilyRouting").and_then(Value::as_bool);
    result.enable_fallback = router.get("enableFallback").and_then(Value::as_bool);
    result.enable_extended_context = router.get("enableExtendedContext").and_then(Value::as_bool);
    result.long_context_threshold = positive_integer(router.get("longContextThreshold"));
    result.extended_context_threshold = positive_integer(router.get("extendedContextThreshold"));
    result.fallback = projected_fallback(fallback_source);
    result.models = projected_models(router.get("models"));
    if let Some(families) = router.get("families").and_then(Value::as_object) {
        let mut projected = BTreeMap::new();
        for family in FAMILIES {
            if let Some(value) = families.get(family) {
                projected.insert(family.to_string(), project_family_from(value));
            }
        }
        if !projected.is_empty() {
            result.families = Some(projected);
        }
    }
    result
}

fn global_router_from(config: &Value) -> ProjectRouter {
    let router = config.get("Router").unwrap_or(&Value::Null);
    project_router_from(router, config.get("fallback"))
}

/// True only when the raw Router is an empty (or missing) object. A Router
/// holding unknown fields alone is still a custom configuration.
fn use_global_of(router: Option<&Value>) -> bool {
    router
        .and_then(Value::as_object)
        .is_none_or(|map| map.is_empty())
}

fn project_view(entry: &Value, config: &Value) -> Option<ProjectView> {
    let id = trimmed_string(entry.get("id"))?;
    let path = trimmed_string(entry.get("path"))?;
    let router = entry.get("Router").unwrap_or(&Value::Null);
    Some(ProjectView {
        id,
        path,
        use_global: use_global_of(entry.get("Router")),
        router: project_router_from(router, router.get("fallback")),
        revision: project_revision(entry, config),
        takeover_clients: entry
            .get("ccrTakeoverClients")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|client| TAKEOVER_CLIENTS.contains(client))
            .map(str::to_owned)
            .collect(),
    })
}

fn snapshot_from(config: &Value, entries: &[Value]) -> ProjectsSnapshot {
    ProjectsSnapshot {
        providers: crate::api::providers(config)
            .into_iter()
            .map(|provider| ProjectsProvider {
                name: provider.name,
                models: provider.models,
            })
            .collect(),
        global_router: global_router_from(config),
        projects: entries
            .iter()
            .filter_map(|entry| project_view(entry, config))
            .collect(),
    }
}

fn find_project<'a>(entries: &'a [Value], id: &str) -> Option<&'a Value> {
    entries
        .iter()
        .find(|entry| entry.get("id").and_then(Value::as_str) == Some(id))
}

// ============================== Revision digest ==============================

/// Digest of the fresh raw project entry (id, path, Router, takeover clients)
/// plus the whole global config: the global config feeds provider validation,
/// the global-router clone base, and server-side takeover sync, so it is
/// relevant to every project mutation. Reuses the routing tab's non-reversible
/// FNV digest; nothing here is decodable back into configuration.
fn project_revision(entry: &Value, config: &Value) -> String {
    revision_of(&json!({
        "project": {
            "id": entry.get("id"),
            "path": entry.get("path"),
            "Router": entry.get("Router"),
            "takeoverClients": entry.get("ccrTakeoverClients"),
        },
        "global": config,
    }))
}

// ============================== Draft normalization ==============================

fn clean_target(value: &mut Option<String>) {
    *value = value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
}

fn clean_threshold(value: Option<u64>) -> Result<Option<u64>, String> {
    match value {
        Some(0) => Err(ERR_THRESHOLD.into()),
        other => Ok(other),
    }
}

fn clean_fallback(fallback: Option<FallbackMap>) -> Result<Option<FallbackMap>, String> {
    let Some(map) = fallback else {
        return Ok(None);
    };
    let mut result = FallbackMap::new();
    for (scenario, entries) in map {
        if !SCENARIOS.contains(&scenario.as_str()) {
            return Err(ERR_FIELD.into());
        }
        let entries: Vec<String> = entries
            .iter()
            .map(|entry| entry.trim().to_owned())
            .filter(|entry| !entry.is_empty())
            .collect();
        if !entries.is_empty() {
            result.insert(scenario, entries);
        }
    }
    Ok(if result.is_empty() {
        None
    } else {
        Some(result)
    })
}

fn clean_models(
    models: Option<BTreeMap<String, String>>,
) -> Result<Option<BTreeMap<String, String>>, String> {
    let Some(map) = models else {
        return Ok(None);
    };
    let mut result = BTreeMap::new();
    for (alias, target) in map {
        let alias = alias.trim();
        if !valid_alias(alias) {
            return Err(ERR_ALIAS_INVALID.into());
        }
        let target = target.trim();
        if !target.is_empty() {
            result.insert(alias.to_owned(), target.to_owned());
        }
    }
    Ok(if result.is_empty() {
        None
    } else {
        Some(result)
    })
}

fn normalize_family(mut family: ProjectFamily) -> Result<ProjectFamily, String> {
    for (_, value) in family.scenario_targets_mut() {
        clean_target(value);
    }
    family.long_context_threshold = clean_threshold(family.long_context_threshold)?;
    family.extended_context_threshold = clean_threshold(family.extended_context_threshold)?;
    family.fallback = clean_fallback(family.fallback)?;
    Ok(family)
}

/// Canonical form of a submitted draft: trimmed targets, allowlisted keys,
/// positive thresholds. Empty containers collapse to absence so the readback
/// projection compares equal. Availability of targets is checked later,
/// against the fresh config, and only for changed values.
fn normalize_router(mut draft: ProjectRouter) -> Result<ProjectRouter, String> {
    for (_, value) in draft.scenario_targets_mut() {
        clean_target(value);
    }
    draft.long_context_threshold = clean_threshold(draft.long_context_threshold)?;
    draft.extended_context_threshold = clean_threshold(draft.extended_context_threshold)?;
    draft.fallback = clean_fallback(draft.fallback)?;
    draft.models = clean_models(draft.models)?;
    draft.families = match draft.families {
        None => None,
        Some(map) => {
            let mut result = BTreeMap::new();
            for (name, family) in map {
                if !FAMILIES.contains(&name.as_str()) {
                    return Err(ERR_FIELD.into());
                }
                result.insert(name, normalize_family(family)?);
            }
            if result.is_empty() {
                None
            } else {
                Some(result)
            }
        }
    };
    Ok(draft)
}

// ============================== Merge ==============================

fn available_targets(config: &Value) -> HashSet<String> {
    crate::api::providers(config)
        .iter()
        .flat_map(|provider| {
            provider
                .models
                .iter()
                .map(move |model| format!("{},{}", provider.name, model))
        })
        .collect()
}

fn check_target(target: &str, available: &HashSet<String>) -> Result<(), String> {
    if available.contains(target) {
        Ok(())
    } else {
        Err(ERR_TARGET_UNAVAILABLE.into())
    }
}

/// A target identical to the raw base value is unchanged: existing stale or
/// disabled choices roundtrip while unrelated fields are edited.
fn unchanged_target(base: Option<&Value>, target: &str) -> bool {
    base.and_then(Value::as_str).map(str::trim) == Some(target)
}

fn set_or_remove(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    match value {
        Some(value) => {
            map.insert(key.into(), value);
        }
        None => {
            map.remove(key);
        }
    }
}

/// Custom saves start from the freshest raw project Router when nonempty;
/// otherwise they clone the current global Router with the root fallback
/// nested inside it (mirrors ProjectsPage's globalRouterWithFallback).
fn save_base(entry: &Value, config: &Value) -> Map<String, Value> {
    if let Some(router) = entry.get("Router").and_then(Value::as_object) {
        if !router.is_empty() {
            return router.clone();
        }
    }
    let mut base = config
        .get("Router")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    base.insert(
        "fallback".into(),
        config.get("fallback").cloned().unwrap_or_else(|| json!({})),
    );
    base
}

/// Replaces known scenario keys with the submitted chains; unknown scenario
/// keys in the raw map are preserved. New entries must be available; entries
/// already present in the base chain roundtrip even when stale or reordered.
fn merge_fallback(
    base: Option<&Value>,
    submitted: Option<&FallbackMap>,
    available: &HashSet<String>,
) -> Result<Option<Value>, String> {
    let base_map = base.and_then(Value::as_object);
    let mut merged = base_map.cloned().unwrap_or_default();
    for scenario in SCENARIOS {
        merged.remove(scenario);
    }
    if let Some(entries) = submitted {
        for (scenario, entries) in entries {
            let previous: Vec<&str> = base_map
                .and_then(|map| map.get(scenario))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::trim)
                .collect();
            for target in entries {
                if !previous.contains(&target.as_str()) {
                    check_target(target, available)?;
                }
            }
            merged.insert(scenario.clone(), json!(entries));
        }
    }
    Ok(if merged.is_empty() {
        None
    } else {
        Some(Value::Object(merged))
    })
}

/// Model aliases are replaced wholesale by the submitted map (the alias
/// editor owns the full list); absence deletes the whole map.
fn merge_models(
    base: Option<&Value>,
    submitted: Option<&BTreeMap<String, String>>,
    available: &HashSet<String>,
) -> Result<Option<Value>, String> {
    let Some(models) = submitted else {
        return Ok(None);
    };
    let mut merged = Map::new();
    for (alias, target) in models {
        if !unchanged_target(base.and_then(|base| base.get(alias)), target) {
            check_target(target, available)?;
        }
        merged.insert(alias.clone(), Value::String(target.clone()));
    }
    Ok(if merged.is_empty() {
        None
    } else {
        Some(Value::Object(merged))
    })
}

fn merge_family(
    base: Option<&Value>,
    draft: &ProjectFamily,
    available: &HashSet<String>,
) -> Result<Map<String, Value>, String> {
    let base_map = base.and_then(Value::as_object);
    let mut merged = base_map.cloned().unwrap_or_default();
    for (name, value) in draft.scenario_targets() {
        if let Some(target) = value {
            if !unchanged_target(base_map.and_then(|map| map.get(name)), target) {
                check_target(target, available)?;
            }
        }
        set_or_remove(&mut merged, name, value.clone().map(Value::String));
    }
    set_or_remove(
        &mut merged,
        "enableExtendedContext",
        draft.enable_extended_context.map(Value::Bool),
    );
    set_or_remove(
        &mut merged,
        "longContextThreshold",
        draft.long_context_threshold.map(|value| json!(value)),
    );
    set_or_remove(
        &mut merged,
        "extendedContextThreshold",
        draft.extended_context_threshold.map(|value| json!(value)),
    );
    let fallback = merge_fallback(
        base_map.and_then(|map| map.get("fallback")),
        draft.fallback.as_ref(),
        available,
    )?;
    set_or_remove(&mut merged, "fallback", fallback);
    Ok(merged)
}

/// Known families are replaced per the submitted map (a missing family is a
/// deliberate deletion); unknown family entries are preserved verbatim.
fn merge_families(
    base: Option<&Value>,
    submitted: Option<&BTreeMap<String, ProjectFamily>>,
    available: &HashSet<String>,
) -> Result<Option<Value>, String> {
    let base_map = base.and_then(Value::as_object);
    let mut merged = base_map.cloned().unwrap_or_default();
    for family in FAMILIES {
        merged.remove(family);
    }
    if let Some(families) = submitted {
        for (name, draft) in families {
            let family = merge_family(base_map.and_then(|map| map.get(name)), draft, available)?;
            merged.insert(name.clone(), Value::Object(family));
        }
    }
    Ok(if merged.is_empty() {
        None
    } else {
        Some(Value::Object(merged))
    })
}

/// Applies the typed draft onto the raw base: supported fields are replaced
/// (absent supported fields are deleted), unknown fields survive at the
/// router, family, and fallback levels. Only changed targets are validated
/// against the currently available provider/model choices.
fn apply_router(
    base: &Map<String, Value>,
    draft: &ProjectRouter,
    available: &HashSet<String>,
) -> Result<Map<String, Value>, String> {
    let mut merged = base.clone();
    for (name, value) in draft.scenario_targets() {
        if let Some(target) = value {
            if !unchanged_target(base.get(name), target) {
                check_target(target, available)?;
            }
        }
        set_or_remove(&mut merged, name, value.clone().map(Value::String));
    }
    set_or_remove(
        &mut merged,
        "enableFamilyRouting",
        draft.enable_family_routing.map(Value::Bool),
    );
    set_or_remove(
        &mut merged,
        "enableFallback",
        draft.enable_fallback.map(Value::Bool),
    );
    set_or_remove(
        &mut merged,
        "enableExtendedContext",
        draft.enable_extended_context.map(Value::Bool),
    );
    set_or_remove(
        &mut merged,
        "longContextThreshold",
        draft.long_context_threshold.map(|value| json!(value)),
    );
    set_or_remove(
        &mut merged,
        "extendedContextThreshold",
        draft.extended_context_threshold.map(|value| json!(value)),
    );
    let fallback = merge_fallback(base.get("fallback"), draft.fallback.as_ref(), available)?;
    set_or_remove(&mut merged, "fallback", fallback);
    let models = merge_models(base.get("models"), draft.models.as_ref(), available)?;
    set_or_remove(&mut merged, "models", models);
    let families = merge_families(base.get("families"), draft.families.as_ref(), available)?;
    set_or_remove(&mut merged, "families", families);
    Ok(merged)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::mock::{response, Mock};

    fn config() -> Value {
        json!({
            "APIKEY": "$ADMIN",
            "Providers": [
                {"name": "alpha", "models": ["one", "two"], "api_key": "${UPSTREAM}"},
                {"name": "beta", "models": ["three"], "enabled": false}
            ],
            "Router": {
                "default": "alpha,one",
                "background": "alpha,two",
                "enableFamilyRouting": true,
                "enableFallback": true,
                "longContextThreshold": 60000,
                "families": {"opus": {"default": "alpha,one", "fallback": {"think": ["alpha,two"]}}},
                "models": {"fast": "alpha,two"},
                "customRule": {"secret": "$GLOBAL_UNKNOWN"}
            },
            "fallback": {"default": ["alpha,two", "beta,three"]},
            "unknown": {"deep": [true, null, "$SECRET"]}
        })
    }

    fn project_entry() -> Value {
        json!({
            "id": "-Users-dev-demo",
            "path": "/Users/dev/demo",
            "configPath": "/Users/dev/.claude-code-router/-Users-dev-demo/config.json",
            "Router": {
                "default": "beta,three",
                "think": "alpha,two",
                "enableFallback": true,
                "longContextThreshold": 60000,
                "fallback": {"default": ["beta,three"], "customScenario": ["$FALLBACK_UNKNOWN"]},
                "families": {
                    "opus": {
                        "default": "alpha,one",
                        "customKey": "$FAMILY_UNKNOWN",
                        "models": {"inner": "alpha,one"},
                        "fallback": {"think": ["alpha,two"], "customScenario": ["x"]}
                    },
                    "sonnet": {"default": "alpha,two"},
                    "claude": {"default": "$UNKNOWN_FAMILY"}
                },
                "models": {"fast": "alpha,two"},
                "customRule": {"secret": "$ROUTER_UNKNOWN"}
            },
            "ccrTakeoverClients": ["claudeCode", "pi", "codex"],
            "ccrTakeover": true
        })
    }

    fn projects_response(entries: Vec<Value>) -> Value {
        json!({ "projects": entries })
    }

    fn entry_with_router(router: Value) -> Value {
        let mut entry = project_entry();
        entry["Router"] = router;
        entry
    }

    fn draft_of(entry: &Value) -> ProjectRouter {
        let router = &entry["Router"];
        project_router_from(router, router.get("fallback"))
    }

    fn change_for(
        entry: &Value,
        config: &Value,
        use_global: bool,
        router: ProjectRouter,
    ) -> ProjectChange {
        ProjectChange {
            id: entry["id"].as_str().unwrap().to_owned(),
            revision: project_revision(entry, config),
            use_global,
            router,
        }
    }

    fn posted_router(request: &str) -> Value {
        let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        body["Router"].clone()
    }

    #[test]
    fn snapshot_projects_typed_whitelist_use_global_and_revisions() {
        let cfg = config();
        let entries = vec![
            project_entry(),
            json!({"id": "-Users-dev-global", "path": "/Users/dev/global",
                   "configPath": "/secret/config.json", "Router": {},
                   "ccrTakeoverClients": [], "ccrTakeover": false}),
            json!({"id": "-Users-dev-unknown", "path": "/Users/dev/unknown",
                   "Router": {"customRule": {"secret": "$ONLY_UNKNOWN"}},
                   "ccrTakeoverClients": ["zcode"]}),
            json!({"id": " ", "path": "/bad"}),
            json!({"id": "-nopath"}),
        ];
        let snapshot = snapshot_from(&cfg, &entries);
        assert_eq!(snapshot.providers.len(), 1);
        assert_eq!(snapshot.providers[0].name, "alpha");
        assert_eq!(snapshot.projects.len(), 3);

        let custom = &snapshot.projects[0];
        assert_eq!(custom.path, "/Users/dev/demo");
        assert!(!custom.use_global);
        assert_eq!(custom.router.default.as_deref(), Some("beta,three"));
        assert_eq!(custom.router.think.as_deref(), Some("alpha,two"));
        // Absence stays absent: missing fields are not projected as false/empty.
        assert_eq!(custom.router.background, None);
        assert_eq!(custom.router.enable_family_routing, None);
        assert_eq!(custom.router.enable_fallback, Some(true));
        assert_eq!(custom.router.long_context_threshold, Some(60000));
        assert_eq!(custom.router.extended_context_threshold, None);
        let fallback = custom.router.fallback.as_ref().unwrap();
        assert_eq!(fallback["default"], ["beta,three"]);
        assert!(!fallback.contains_key("customScenario"));
        let families = custom.router.families.as_ref().unwrap();
        assert_eq!(families.len(), 2);
        assert_eq!(families["opus"].default.as_deref(), Some("alpha,one"));
        assert_eq!(
            families["opus"].fallback.as_ref().unwrap()["think"],
            ["alpha,two"]
        );
        assert_eq!(custom.router.models.as_ref().unwrap()["fast"], "alpha,two");
        // codex is global-only and never a project takeover client.
        assert_eq!(custom.takeover_clients, ["claudeCode", "pi"]);
        assert!(custom.revision.starts_with("rev-"));

        assert!(snapshot.projects[1].use_global);
        assert_eq!(snapshot.projects[1].router, ProjectRouter::default());
        // Unknown-only raw Router is still custom: useGlobal follows raw emptiness.
        assert!(!snapshot.projects[2].use_global);
        assert_eq!(snapshot.projects[2].router, ProjectRouter::default());
        assert_eq!(snapshot.projects[2].takeover_clients, ["zcode"]);

        // The root global fallback maps into globalRouter.fallback.
        let global = &snapshot.global_router;
        assert_eq!(global.default.as_deref(), Some("alpha,one"));
        assert_eq!(
            global.fallback.as_ref().unwrap()["default"],
            ["alpha,two", "beta,three"]
        );
        assert_eq!(global.enable_family_routing, Some(true));

        let rendered = serde_json::to_string(&snapshot).unwrap();
        for secret in [
            "$SECRET",
            "$ADMIN",
            "$UPSTREAM",
            "api_key",
            "configPath",
            "$ROUTER_UNKNOWN",
            "$FAMILY_UNKNOWN",
            "$FALLBACK_UNKNOWN",
            "$UNKNOWN_FAMILY",
            "$GLOBAL_UNKNOWN",
            "$ONLY_UNKNOWN",
            "customRule",
            "customScenario",
            "customKey",
            "ccrTakeover",
        ] {
            assert!(!rendered.contains(secret), "leaked {secret}");
        }
        assert!(rendered.contains("/Users/dev/demo"));
    }

    #[test]
    fn revision_tracks_raw_router_takeover_path_and_global_config() {
        let cfg = config();
        let entry = project_entry();
        let base = project_revision(&entry, &cfg);
        assert_eq!(base, project_revision(&entry.clone(), &cfg));
        for mutation in [
            json!({"Router": {"think": "alpha,one"}}),
            json!({"Router": {"customRule": {"secret": "other"}}}),
            json!({"ccrTakeoverClients": ["claudeCode"]}),
            json!({"path": "/Users/dev/other"}),
        ] {
            let mut changed = entry.clone();
            for (key, value) in mutation.as_object().unwrap() {
                changed[key] = value.clone();
            }
            assert_ne!(base, project_revision(&changed, &cfg));
        }
        let mut changed_cfg = cfg.clone();
        changed_cfg["Router"]["default"] = json!("alpha,two");
        assert_ne!(base, project_revision(&entry, &changed_cfg));
    }

    #[test]
    fn change_deserialization_rejects_unknown_fields_and_wrong_types() {
        assert!(serde_json::from_value::<ProjectChange>(json!({
            "id": "x", "revision": "r", "useGlobal": false,
            "router": {"default": "alpha,one", "configPath": "/secret"}
        }))
        .is_err());
        assert!(serde_json::from_value::<ProjectRouter>(
            json!({"families": {"opus": {"models": {"x": "alpha,one"}}}})
        )
        .is_err());
        assert!(
            serde_json::from_value::<ProjectRouter>(json!({"longContextThreshold": -5})).is_err()
        );
        assert!(serde_json::from_value::<ProjectRouter>(json!({"enableFallback": "yes"})).is_err());
        // Absence crosses IPC as absence, never as false defaults.
        assert_eq!(
            serde_json::to_value(ProjectRouter::default()).unwrap(),
            json!({})
        );
    }

    #[test]
    fn apply_router_removes_absent_supported_fields_and_keeps_unknown_siblings() {
        let entry = project_entry();
        let base = entry["Router"].as_object().unwrap().clone();
        let merged = apply_router(&base, &ProjectRouter::default(), &HashSet::new()).unwrap();
        assert_eq!(merged.get("customRule"), base.get("customRule"));
        for key in [
            "default",
            "think",
            "enableFallback",
            "longContextThreshold",
            "models",
        ] {
            assert!(merged.get(key).is_none(), "{key} should be deleted");
        }
        // Unknown scenario keys survive inside fallback; known ones are cleared.
        assert_eq!(
            merged["fallback"],
            json!({"customScenario": ["$FALLBACK_UNKNOWN"]})
        );
        // Known families are deliberately deleted; the unknown family survives.
        assert_eq!(
            merged["families"],
            json!({"claude": {"default": "$UNKNOWN_FAMILY"}})
        );
    }

    #[test]
    fn empty_family_draft_keeps_family_present_with_unknown_fields() {
        let entry = project_entry();
        let base = entry["Router"].as_object().unwrap().clone();
        let draft = ProjectRouter {
            families: Some(BTreeMap::from([(
                "opus".to_string(),
                ProjectFamily::default(),
            )])),
            ..Default::default()
        };
        let merged = apply_router(&base, &draft, &HashSet::new()).unwrap();
        // The family stays present; unknown siblings (incl. nested models) survive.
        assert_eq!(
            merged["families"]["opus"],
            json!({
                "customKey": "$FAMILY_UNKNOWN",
                "models": {"inner": "alpha,one"},
                "fallback": {"customScenario": ["x"]}
            })
        );
        assert!(merged["families"].get("sonnet").is_none());
        assert_eq!(
            merged["families"]["claude"],
            json!({"default": "$UNKNOWN_FAMILY"})
        );
    }

    #[tokio::test]
    async fn save_custom_merges_typed_subset_preserving_unknown_fields() {
        let cfg = config();
        let entry = project_entry();
        let mut draft = draft_of(&entry);
        draft.think = Some("alpha,one".into());
        draft.long_context_threshold = None;
        draft
            .fallback
            .as_mut()
            .unwrap()
            .insert("think".into(), vec!["alpha,two".into()]);
        draft.families.as_mut().unwrap().remove("sonnet");
        let expected = json!({
            "default": "beta,three",
            "think": "alpha,one",
            "enableFallback": true,
            "fallback": {
                "default": ["beta,three"],
                "think": ["alpha,two"],
                "customScenario": ["$FALLBACK_UNKNOWN"]
            },
            "families": {
                "opus": {
                    "default": "alpha,one",
                    "customKey": "$FAMILY_UNKNOWN",
                    "models": {"inner": "alpha,one"},
                    "fallback": {"think": ["alpha,two"], "customScenario": ["x"]}
                },
                "claude": {"default": "$UNKNOWN_FAMILY"}
            },
            "models": {"fast": "alpha,two"},
            "customRule": {"secret": "$ROUTER_UNKNOWN"}
        });
        let after = entry_with_router(expected.clone());
        let mock = Mock::new(vec![
            response(cfg.clone()),
            response(projects_response(vec![entry.clone()])),
            response(json!({"id": "-Users-dev-demo", "path": "/Users/dev/demo",
                            "configPath": "/secret", "Router": expected,
                            "ccrTakeoverClients": ["claudeCode", "pi"]})),
            response(cfg.clone()),
            response(projects_response(vec![after.clone()])),
        ]);
        let service = ProjectsService::new(Some(mock.client()));
        let snapshot = service
            .save(change_for(&entry, &cfg, false, draft))
            .await
            .unwrap();
        assert_eq!(
            snapshot.projects[0].router.think.as_deref(),
            Some("alpha,one")
        );
        assert_eq!(snapshot.projects[0].router.long_context_threshold, None);
        assert_eq!(
            snapshot.projects[0].revision,
            project_revision(&after, &cfg)
        );
        let requests = mock.finish().await;
        assert_eq!(requests.len(), 5);
        assert!(requests[0].starts_with("GET /api/config "));
        assert!(requests[1].starts_with("GET /api/projects "));
        assert!(requests[2].starts_with("PUT /api/projects/-Users-dev-demo "));
        assert!(requests[3].starts_with("GET /api/config "));
        assert!(requests[4].starts_with("GET /api/projects "));
        // Project writes never POST the global config.
        assert!(requests
            .iter()
            .all(|request| !request.starts_with("POST /api/config ")));
        // The stale disabled default roundtrips; unknown fields survive verbatim.
        assert_eq!(posted_router(&requests[2]), expected);
    }

    #[tokio::test]
    async fn save_use_global_posts_empty_router_exactly() {
        let cfg = config();
        let entry = project_entry();
        let after = entry_with_router(json!({}));
        let mock = Mock::new(vec![
            response(cfg.clone()),
            response(projects_response(vec![entry.clone()])),
            response(json!({"id": "-Users-dev-demo", "path": "/Users/dev/demo", "Router": {}})),
            response(cfg.clone()),
            response(projects_response(vec![after])),
        ]);
        let service = ProjectsService::new(Some(mock.client()));
        // The draft router is ignored when useGlobal is true.
        let mut draft = draft_of(&entry);
        draft.default = Some("alpha,one".into());
        let snapshot = service
            .save(change_for(&entry, &cfg, true, draft))
            .await
            .unwrap();
        assert!(snapshot.projects[0].use_global);
        assert_eq!(snapshot.projects[0].router, ProjectRouter::default());
        let requests = mock.finish().await;
        assert_eq!(requests.len(), 5);
        assert_eq!(posted_router(&requests[2]), json!({}));
    }

    #[tokio::test]
    async fn clearing_visible_fields_confirms_actual_inheritance_and_preserves_hidden_fields() {
        for hidden in [false, true] {
            let cfg = config();
            let mut raw = json!({"default": "alpha,one"});
            let mut expected = json!({});
            if hidden {
                raw["customRule"] = json!({"keep": true});
                expected["customRule"] = json!({"keep": true});
            }
            let entry = entry_with_router(raw);
            let after = entry_with_router(expected.clone());
            let mock = Mock::new(vec![
                response(cfg.clone()),
                response(projects_response(vec![entry.clone()])),
                response(json!({"success": true})),
                response(cfg.clone()),
                response(projects_response(vec![after])),
            ]);
            let service = ProjectsService::new(Some(mock.client()));
            let snapshot = service
                .save(change_for(&entry, &cfg, false, ProjectRouter::default()))
                .await
                .unwrap();
            assert_eq!(snapshot.projects[0].use_global, !hidden);
            assert_eq!(snapshot.projects[0].router, ProjectRouter::default());
            assert_eq!(posted_router(&mock.finish().await[2]), expected);
        }
    }

    #[tokio::test]
    async fn save_empty_project_clones_global_router_and_root_fallback() {
        let cfg = config();
        let entry = entry_with_router(json!({}));
        // Roundtrip the current global projection as the first custom draft.
        let draft = global_router_from(&cfg);
        let mut expected = cfg["Router"].clone();
        expected["fallback"] = cfg["fallback"].clone();
        let after = entry_with_router(expected.clone());
        let mock = Mock::new(vec![
            response(cfg.clone()),
            response(projects_response(vec![entry.clone()])),
            response(
                json!({"id": "-Users-dev-demo", "path": "/Users/dev/demo", "Router": expected}),
            ),
            response(cfg.clone()),
            response(projects_response(vec![after])),
        ]);
        let service = ProjectsService::new(Some(mock.client()));
        let snapshot = service
            .save(change_for(&entry, &cfg, false, draft))
            .await
            .unwrap();
        assert!(!snapshot.projects[0].use_global);
        assert_eq!(
            snapshot.projects[0].router.fallback.as_ref().unwrap()["default"],
            ["alpha,two", "beta,three"]
        );
        let requests = mock.finish().await;
        assert_eq!(requests.len(), 5);
        // The clone keeps unknown global Router fields and nests the root fallback.
        assert_eq!(posted_router(&requests[2]), expected);
        assert_eq!(
            posted_router(&requests[2])["customRule"],
            json!({"secret": "$GLOBAL_UNKNOWN"})
        );
    }

    #[tokio::test]
    async fn save_rejects_stale_revision_and_unknown_id_before_write() {
        let cfg = config();
        let entry = project_entry();
        let mock = Mock::new(vec![
            response(cfg.clone()),
            response(projects_response(vec![entry.clone()])),
        ]);
        let service = ProjectsService::new(Some(mock.client()));
        let mut change = change_for(&entry, &cfg, false, draft_of(&entry));
        change.revision = "rev-deadbeefdeadbeef".into();
        let error = service.save(change).await.unwrap_err();
        assert!(error.contains("stale"));
        let requests = mock.finish().await;
        assert_eq!(requests.len(), 2);
        assert!(requests.iter().all(|request| request.starts_with("GET ")));

        let mock = Mock::new(vec![
            response(cfg.clone()),
            response(projects_response(vec![entry.clone()])),
        ]);
        let service = ProjectsService::new(Some(mock.client()));
        let mut change = change_for(&entry, &cfg, false, draft_of(&entry));
        change.id = "-Users-dev-gone".into();
        assert_eq!(service.save(change).await.unwrap_err(), ERR_NOT_FOUND);
        assert_eq!(mock.finish().await.len(), 2);
    }

    #[tokio::test]
    async fn save_structural_errors_reject_before_any_request() {
        let entry = project_entry();
        let bad_family = ProjectRouter {
            families: Some(BTreeMap::from([(
                "claude".to_string(),
                ProjectFamily::default(),
            )])),
            ..Default::default()
        };
        let bad_fallback = ProjectRouter {
            fallback: Some(BTreeMap::from([(
                "customScenario".to_string(),
                vec!["alpha,one".to_string()],
            )])),
            ..Default::default()
        };
        let bad_alias = ProjectRouter {
            models: Some(BTreeMap::from([(
                "bad,alias".to_string(),
                "alpha,one".to_string(),
            )])),
            ..Default::default()
        };
        let zero_threshold = ProjectRouter {
            long_context_threshold: Some(0),
            ..Default::default()
        };
        for draft in [bad_family, bad_fallback, bad_alias, zero_threshold] {
            let mock = Mock::new(vec![]);
            let service = ProjectsService::new(Some(mock.client()));
            assert!(service
                .save(change_for(&entry, &config(), false, draft))
                .await
                .is_err());
            assert!(mock.finish().await.is_empty());
        }
    }

    #[tokio::test]
    async fn save_validates_only_changed_targets_after_fresh_fetch() {
        let cfg = config();
        let entry = project_entry();
        // Changed scenario/family/alias targets and new fallback entries must be
        // available; beta is disabled and ghost models do not exist.
        let mut changed_scenario = draft_of(&entry);
        changed_scenario.think = Some("beta,three".into());
        let mut changed_family = draft_of(&entry);
        changed_family
            .families
            .as_mut()
            .unwrap()
            .get_mut("opus")
            .unwrap()
            .default = Some("alpha,ghost".into());
        let mut changed_alias = draft_of(&entry);
        changed_alias
            .models
            .as_mut()
            .unwrap()
            .insert("fast".into(), "beta,three".into());
        let mut new_fallback_entry = draft_of(&entry);
        new_fallback_entry
            .fallback
            .as_mut()
            .unwrap()
            .get_mut("default")
            .unwrap()
            .push("alpha,ghost".into());
        for draft in [
            changed_scenario,
            changed_family,
            changed_alias,
            new_fallback_entry,
        ] {
            let mock = Mock::new(vec![
                response(cfg.clone()),
                response(projects_response(vec![entry.clone()])),
            ]);
            let service = ProjectsService::new(Some(mock.client()));
            assert_eq!(
                service
                    .save(change_for(&entry, &cfg, false, draft))
                    .await
                    .unwrap_err(),
                ERR_TARGET_UNAVAILABLE
            );
            let requests = mock.finish().await;
            assert_eq!(requests.len(), 2);
            assert!(requests.iter().all(|request| request.starts_with("GET ")));
        }
    }

    #[tokio::test]
    async fn save_readback_mismatch_is_a_safe_error() {
        let cfg = config();
        let entry = project_entry();
        let mut draft = draft_of(&entry);
        draft.think = Some("alpha,one".into());
        // The gateway readback still shows the old Router: not confirmed.
        let mock = Mock::new(vec![
            response(cfg.clone()),
            response(projects_response(vec![entry.clone()])),
            response(json!({"id": "-Users-dev-demo", "path": "/Users/dev/demo", "Router": {}})),
            response(cfg.clone()),
            response(projects_response(vec![entry.clone()])),
        ]);
        let service = ProjectsService::new(Some(mock.client()));
        assert_eq!(
            service
                .save(change_for(&entry, &cfg, false, draft))
                .await
                .unwrap_err(),
            ERR_SAVE_NOT_CONFIRMED
        );
        assert_eq!(mock.finish().await.len(), 5);
    }

    #[tokio::test]
    async fn takeover_allowlists_clients_encodes_ids_and_verifies_readback() {
        let mock = Mock::new(vec![]);
        let service = ProjectsService::new(Some(mock.client()));
        assert_eq!(
            service
                .takeover("-Users-dev-demo", "rev-1", &["codex".into()])
                .await
                .unwrap_err(),
            ERR_CLIENT_INPUT
        );
        assert!(mock.finish().await.is_empty());

        let cfg = config();
        let mut entry = project_entry();
        entry["id"] = json!("-Users-dev-my project%");
        entry["path"] = json!("/Users/dev/my project%");
        let mut after = entry.clone();
        after["ccrTakeoverClients"] = json!(["claudeCode", "pi"]);
        let mock = Mock::new(vec![
            response(cfg.clone()),
            response(projects_response(vec![entry.clone()])),
            response(
                json!({"id": "-Users-dev-my project%", "path": "/Users/dev/my project%",
                            "ccrTakeoverClients": ["claudeCode", "pi"], "ccrTakeover": true}),
            ),
            response(cfg.clone()),
            response(projects_response(vec![after])),
        ]);
        let service = ProjectsService::new(Some(mock.client()));
        let snapshot = service
            .takeover(
                "-Users-dev-my project%",
                &project_revision(&entry, &cfg),
                &["pi".into(), "claudeCode".into(), "pi".into()],
            )
            .await
            .unwrap();
        assert_eq!(snapshot.projects[0].takeover_clients, ["claudeCode", "pi"]);
        let requests = mock.finish().await;
        assert_eq!(requests.len(), 5);
        assert!(requests[2].starts_with("PUT /api/projects/-Users-dev-my%20project%25/takeover "));
        let body: Value =
            serde_json::from_str(requests[2].split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body, json!({"clients": ["pi", "claudeCode"]}));

        // Stale revision: fetched, nothing written.
        let mock = Mock::new(vec![
            response(cfg.clone()),
            response(projects_response(vec![entry.clone()])),
        ]);
        let service = ProjectsService::new(Some(mock.client()));
        assert!(service
            .takeover("-Users-dev-my project%", "rev-0", &["pi".into()])
            .await
            .unwrap_err()
            .contains("stale"));
        assert_eq!(mock.finish().await.len(), 2);
    }

    #[tokio::test]
    async fn takeover_readback_mismatch_is_a_safe_error() {
        let cfg = config();
        let entry = project_entry();
        // The server only managed to take over Claude Code; pi was requested.
        let mut after = entry.clone();
        after["ccrTakeoverClients"] = json!(["claudeCode"]);
        let mock = Mock::new(vec![
            response(cfg.clone()),
            response(projects_response(vec![entry.clone()])),
            response(json!({"id": "-Users-dev-demo", "ccrTakeoverClients": ["claudeCode"]})),
            response(cfg.clone()),
            response(projects_response(vec![after])),
        ]);
        let service = ProjectsService::new(Some(mock.client()));
        assert_eq!(
            service
                .takeover(
                    "-Users-dev-demo",
                    &project_revision(&entry, &cfg),
                    &["claudeCode".into(), "pi".into()],
                )
                .await
                .unwrap_err(),
            ERR_TAKEOVER_NOT_CONFIRMED
        );
        assert_eq!(mock.finish().await.len(), 5);
    }

    #[tokio::test]
    async fn delete_verifies_removal_and_rejects_stale_and_unconfirmed() {
        let cfg = config();
        let entry = project_entry();
        let mock = Mock::new(vec![
            response(cfg.clone()),
            response(projects_response(vec![entry.clone()])),
            response(json!({"success": true})),
            response(cfg.clone()),
            response(projects_response(vec![])),
        ]);
        let service = ProjectsService::new(Some(mock.client()));
        let snapshot = service
            .delete("-Users-dev-demo", &project_revision(&entry, &cfg))
            .await
            .unwrap();
        assert!(snapshot.projects.is_empty());
        let requests = mock.finish().await;
        assert_eq!(requests.len(), 5);
        assert!(requests[2].starts_with("DELETE /api/projects/-Users-dev-demo "));
        assert!(requests
            .iter()
            .all(|request| !request.starts_with("POST /api/config ")));

        // Stale revision: fetched, nothing deleted.
        let mock = Mock::new(vec![
            response(cfg.clone()),
            response(projects_response(vec![entry.clone()])),
        ]);
        let service = ProjectsService::new(Some(mock.client()));
        assert!(service
            .delete("-Users-dev-demo", "rev-0")
            .await
            .unwrap_err()
            .contains("stale"));
        assert_eq!(mock.finish().await.len(), 2);

        // Readback still lists the project: not confirmed.
        let mock = Mock::new(vec![
            response(cfg.clone()),
            response(projects_response(vec![entry.clone()])),
            response(json!({"success": true})),
            response(cfg.clone()),
            response(projects_response(vec![entry.clone()])),
        ]);
        let service = ProjectsService::new(Some(mock.client()));
        assert_eq!(
            service
                .delete("-Users-dev-demo", &project_revision(&entry, &cfg))
                .await
                .unwrap_err(),
            ERR_DELETE_NOT_CONFIRMED
        );
        assert_eq!(mock.finish().await.len(), 5);
    }

    #[tokio::test]
    async fn add_requires_absolute_path_and_confirms_via_fresh_list() {
        let mock = Mock::new(vec![]);
        let service = ProjectsService::new(Some(mock.client()));
        for path in ["", "   ", "demo/project", "./demo"] {
            assert_eq!(service.add(path).await.unwrap_err(), ERR_PATH_INVALID);
        }
        assert!(mock.finish().await.is_empty());

        let cfg = config();
        let added = json!({"id": "-Users-dev-new", "path": "/Users/dev/new",
                           "configPath": "/secret", "Router": {},
                           "ccrTakeoverClients": ["claudeCode"], "ccrTakeover": true});
        let mock = Mock::new(vec![
            response(added.clone()),
            response(cfg.clone()),
            response(projects_response(vec![added.clone()])),
        ]);
        let service = ProjectsService::new(Some(mock.client()));
        let snapshot = service.add(" /Users/dev/new ").await.unwrap();
        assert_eq!(snapshot.projects.len(), 1);
        assert_eq!(snapshot.projects[0].path, "/Users/dev/new");
        assert!(snapshot.projects[0].use_global);
        assert_eq!(snapshot.projects[0].takeover_clients, ["claudeCode"]);
        let requests = mock.finish().await;
        assert_eq!(requests.len(), 3);
        assert!(requests[0].starts_with("POST /api/projects "));
        let body: Value =
            serde_json::from_str(requests[0].split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body, json!({"path": "/Users/dev/new"}));
        let rendered = serde_json::to_string(&snapshot).unwrap();
        assert!(!rendered.contains("configPath"));

        // Readback without the added project: not confirmed.
        let mock = Mock::new(vec![
            response(added),
            response(cfg.clone()),
            response(projects_response(vec![])),
        ]);
        let service = ProjectsService::new(Some(mock.client()));
        assert_eq!(
            service.add("/Users/dev/new").await.unwrap_err(),
            ERR_ADD_NOT_CONFIRMED
        );
        assert_eq!(mock.finish().await.len(), 3);
    }

    #[tokio::test]
    async fn mutation_transport_failures_are_bounded_and_safe() {
        let cfg = config();
        let entry = project_entry();
        // The gateway may have persisted the Router before a takeover-sync 500:
        // the fixed error asks for a refresh and never claims nothing was written.
        let mock = Mock::new(vec![
            response(cfg.clone()),
            response(projects_response(vec![entry.clone()])),
            (500, "LEAK_SECRET".into()),
        ]);
        let service = ProjectsService::new(Some(mock.client()));
        let error = service
            .save(change_for(&entry, &cfg, false, draft_of(&entry)))
            .await
            .unwrap_err();
        assert_eq!(error, ERR_SAVE_FAILED);
        assert!(error.contains("refresh"));
        assert!(!error.contains("LEAK_SECRET"));
        assert_eq!(mock.finish().await.len(), 3);

        // Invalid mutation JSON is the same safe failure.
        let mock = Mock::new(vec![
            response(cfg.clone()),
            response(projects_response(vec![entry.clone()])),
            (200, "not json LEAK_SECRET".into()),
        ]);
        let service = ProjectsService::new(Some(mock.client()));
        assert_eq!(
            service
                .save(change_for(&entry, &cfg, false, draft_of(&entry)))
                .await
                .unwrap_err(),
            ERR_SAVE_FAILED
        );
        assert_eq!(mock.finish().await.len(), 3);

        for (operation, expected) in [
            ("takeover", ERR_TAKEOVER_FAILED),
            ("delete", ERR_DELETE_FAILED),
        ] {
            let mock = Mock::new(vec![
                response(cfg.clone()),
                response(projects_response(vec![entry.clone()])),
                (500, "LEAK_SECRET".into()),
            ]);
            let service = ProjectsService::new(Some(mock.client()));
            let revision = project_revision(&entry, &cfg);
            let error = match operation {
                "takeover" => service
                    .takeover("-Users-dev-demo", &revision, &["pi".into()])
                    .await
                    .unwrap_err(),
                _ => service
                    .delete("-Users-dev-demo", &revision)
                    .await
                    .unwrap_err(),
            };
            assert_eq!(error, expected);
            assert!(!error.contains("LEAK_SECRET"));
            assert_eq!(mock.finish().await.len(), 3);
        }

        let mock = Mock::new(vec![(500, "LEAK_SECRET".into())]);
        let service = ProjectsService::new(Some(mock.client()));
        let error = service.add("/Users/dev/new").await.unwrap_err();
        assert_eq!(error, ERR_ADD_FAILED);
        assert!(!error.contains("LEAK_SECRET"));
        assert_eq!(mock.finish().await.len(), 1);
    }

    #[tokio::test]
    async fn list_failures_are_safe_and_malformed_lists_rejected() {
        let mock = Mock::new(vec![(500, "LEAK_SECRET".into())]);
        let service = ProjectsService::new(Some(mock.client()));
        let error = service.snapshot().await.unwrap_err();
        assert!(!error.contains("LEAK_SECRET"));
        assert_eq!(mock.finish().await.len(), 1);

        let mock = Mock::new(vec![
            response(config()),
            response(json!({"error": "LEAK_SECRET"})),
        ]);
        let service = ProjectsService::new(Some(mock.client()));
        assert_eq!(service.snapshot().await.unwrap_err(), ERR_PROJECTS_LIST);
        assert_eq!(mock.finish().await.len(), 2);
    }

    #[tokio::test]
    async fn offline_service_reports_fixed_safe_errors() {
        let service = ProjectsService::new(None);
        assert_eq!(service.snapshot().await.unwrap_err(), ERR_OFFLINE);
        assert_eq!(
            service.add("/Users/dev/new").await.unwrap_err(),
            ERR_OFFLINE
        );
        assert_eq!(
            service
                .save(ProjectChange {
                    id: "-Users-dev-demo".into(),
                    revision: "rev-1".into(),
                    use_global: true,
                    router: ProjectRouter::default(),
                })
                .await
                .unwrap_err(),
            ERR_OFFLINE
        );
        assert_eq!(
            service
                .takeover("-Users-dev-demo", "rev-1", &["pi".into()])
                .await
                .unwrap_err(),
            ERR_OFFLINE
        );
        assert_eq!(
            service
                .delete("-Users-dev-demo", "rev-1")
                .await
                .unwrap_err(),
            ERR_OFFLINE
        );
    }
}
