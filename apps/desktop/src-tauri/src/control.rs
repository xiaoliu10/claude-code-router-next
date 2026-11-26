//! Desktop control center contracts: routing, usage, and client integrations.
//!
//! Every command is restricted to the local quota panel via `popup::guard`.
//! Projections are narrow and typed: raw configuration, credentials, and
//! upstream error bodies never cross IPC. Writes fetch a fresh config, apply
//! validated mutations, post, and verify by readback — a stale UI draft can
//! rejects stale snapshots; desktop writers share one lock. External full-config
//! writers still require server-side concurrency support for atomic protection.

use crate::api::AdminClient;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use tauri::WebviewWindow;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

/// Families accepted in `Router.families` (shared MODEL_FAMILIES).
pub(crate) const FAMILIES: [&str; 3] = ["opus", "sonnet", "haiku"];
/// Scenario fields on the `Router` root and per family (core RouterScenarioType).
pub(crate) const SCENARIOS: [&str; 7] = [
    "default",
    "background",
    "think",
    "longContext",
    "extendedContext",
    "webSearch",
    "image",
];
/// Client ids exposed by the gateway's client-integrations API (shared CLIENT_IDS).
const CLIENT_IDS: [&str; 5] = ["claudeCode", "codex", "pi", "qwenCode", "opencode"];
/// Allowed clients_update actions; each maps to one existing gateway route.
const CLIENT_ACTIONS: [&str; 3] = ["enable", "disable", "restore"];
/// Usage periods offered by the panel; anything else is rejected before any request.

const MAX_PROVIDER_BUCKETS: usize = 50;
const MAX_MODEL_BUCKETS: usize = 100;
const MAX_DAY_BUCKETS: usize = 62;
const MAX_ALIAS_LENGTH: usize = 64;
/// Defaults and bounds for the usage records pager; the panel shows 20 rows.
const DEFAULT_USAGE_PAGE: u32 = 1;
const DEFAULT_USAGE_PAGE_SIZE: u32 = 20;
const MAX_USAGE_PAGE_SIZE: u32 = 50;
/// Error messages are display hints; 500 characters is enough without
/// shipping an upstream response body across IPC.
const MAX_USAGE_ERROR_MESSAGE_CHARS: usize = 500;

// Safe fixed error messages. Transport failures from AdminClient are already
// sanitized to method, path, and status; validation failures use these.
const ERR_OFFLINE: &str = "Gateway connection is unavailable";
const ERR_STALE: &str = "Routing draft is stale; refresh the panel and retry";
const ERR_TARGET_UNAVAILABLE: &str = "Routing choice is no longer available";
const ERR_SCOPE: &str = "Unknown routing scope";
const ERR_FIELD: &str = "Unknown routing field";
const ERR_ALIAS_INVALID: &str = "Invalid model alias name";
const ERR_ALIAS_FALLBACK: &str = "Model aliases do not support fallback lists";
const ERR_SAVE_NOT_CONFIRMED: &str = "Routing update was not confirmed by the gateway";
const ERR_PERIOD: &str = "Unknown usage period";
const ERR_USAGE: &str = "Usage summary is unavailable";
const ERR_CLIENT_INPUT: &str = "Unknown client or action";
const ERR_CLIENTS_LIST: &str = "Client statuses are unavailable";
const ERR_CLIENT_FAILED: &str = "Client update failed";
const ERR_CLIENT_SYNC: &str = "Client updated, but project takeover sync failed";
const ERR_CLIENT_REFRESH: &str = "Client updated, but live statuses could not be refreshed";

// ============================== IPC projections ==============================

#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct RoutingRoute {
    /// "global", a family from FAMILIES, or "models" for aliases.
    pub scope: String,
    /// Scenario name for global/family scopes; alias name for "models".
    pub field: String,
    pub target: Option<String>,
    pub fallback: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct RoutingProvider {
    pub name: String,
    pub models: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RoutingSnapshot {
    pub providers: Vec<RoutingProvider>,
    pub routes: Vec<RoutingRoute>,
    pub family_routing: bool,
    pub fallback_enabled: bool,
    /// Non-reversible change-detection digest of the raw config. Not decodable
    /// back into configuration; used only for stale-draft rejection.
    pub revision: String,
}

#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UsageBucket {
    pub name: String,
    pub requests: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub period: String,
    pub total_requests: u64,
    pub success_count: u64,
    pub error_count: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub estimated_count: u64,
    pub by_model: Vec<UsageBucket>,
    pub by_provider: Vec<UsageBucket>,
    pub by_day: Vec<UsageBucket>,
    /// Average time to first token in milliseconds; None when absent or not a
    /// usable number.
    pub avg_ttft_ms: Option<u64>,
    /// Average generation speed in tokens per second; None when absent or not
    /// a finite number.
    pub avg_tokens_per_second: Option<f64>,
    pub updated_at: String,
}

/// One paginated page of usage records, projected from GET /api/usage.
#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecordsPage {
    pub period: String,
    pub page: u32,
    pub page_size: u32,
    pub total: u64,
    pub records: Vec<UsageRecordView>,
}

/// Whitelisted record fields only: responseBody, sessionId, stream, id,
/// modelFamily, and any key/config field are never projected across IPC.
#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecordView {
    pub timestamp: String,
    pub provider: String,
    pub model: String,
    pub original_model: Option<String>,
    pub upstream_model: Option<String>,
    pub client_type: Option<String>,
    pub scenario_type: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub ttft_ms: Option<u64>,
    pub tokens_per_second: Option<f64>,
    pub duration_ms: u64,
    pub status: String,
    pub usage_estimated: bool,
    /// Truncated to MAX_USAGE_ERROR_MESSAGE_CHARS characters.
    pub error_message: Option<String>,
}

#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClientView {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub managed: bool,
    pub exists: bool,
    pub active_model: Option<String>,
    pub model_alias: Option<String>,
}

#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct ClientSnapshot {
    pub clients: Vec<ClientView>,
    pub success: bool,
    pub message: Option<String>,
}

// ============================== IPC inputs ==============================

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RoutingChange {
    pub revision: String,
    pub scope: String,
    pub field: String,
    pub target: Option<String>,
    pub fallback: Option<Vec<String>>,
}

// ============================== Service ==============================

pub struct ControlService {
    client: Option<AdminClient>,
}

impl ControlService {
    pub fn new(client: Option<AdminClient>) -> Self {
        Self { client }
    }

    fn client(&self) -> Result<&AdminClient, String> {
        self.client.as_ref().ok_or_else(|| ERR_OFFLINE.to_string())
    }

    pub(crate) async fn routing_snapshot(&self) -> Result<RoutingSnapshot, String> {
        let config = self.client()?.config().await?;
        Ok(routing_snapshot_from(&config))
    }

    pub(crate) async fn routing_save(
        &self,
        change: RoutingChange,
    ) -> Result<RoutingSnapshot, String> {
        let client = self.client()?;
        let _write = client.write_guard().await;
        // Always mutate the freshest config; the UI draft's revision must match
        // it or the whole write is rejected before touching the gateway.
        let mut config = client.config().await?;
        if change.revision != revision_of(&config) {
            return Err(ERR_STALE.into());
        }
        let expected = apply_change(&mut config, &change)?;
        let verified = client.post_config_and_readback(&config).await?;
        if !expected.iter().all(|check| check.matches(&verified)) {
            return Err(ERR_SAVE_NOT_CONFIRMED.into());
        }
        Ok(routing_snapshot_from(&verified))
    }

    pub(crate) async fn routing_flags(
        &self,
        revision: String,
        family_routing: bool,
        fallback_enabled: bool,
    ) -> Result<RoutingSnapshot, String> {
        let client = self.client()?;
        let _write = client.write_guard().await;
        let mut config = client.config().await?;
        if revision != revision_of(&config) {
            return Err(ERR_STALE.into());
        }
        let router = router_mut(&mut config)?;
        router.insert("enableFamilyRouting".into(), Value::Bool(family_routing));
        // The engine gates both family and global fallbacks with this flag.
        // Toggling it must preserve the configured fallback lists and order.
        router.insert("enableFallback".into(), Value::Bool(fallback_enabled));
        let expected = [
            ExpectedMutation {
                pointer: "/Router/enableFamilyRouting".into(),
                value: Some(Value::Bool(family_routing)),
            },
            ExpectedMutation {
                pointer: "/Router/enableFallback".into(),
                value: Some(Value::Bool(fallback_enabled)),
            },
        ];
        let verified = client.post_config_and_readback(&config).await?;
        if !expected.iter().all(|check| check.matches(&verified)) {
            return Err(ERR_SAVE_NOT_CONFIRMED.into());
        }
        Ok(routing_snapshot_from(&verified))
    }

    pub(crate) async fn usage_snapshot(&self, period: &str) -> Result<UsageSnapshot, String> {
        let query = usage_date_query(period)?;
        let path = if query.is_empty() {
            "/api/usage/summary".to_string()
        } else {
            format!("/api/usage/summary?{query}")
        };
        let summary = self.client()?.get_json(&path).await?;
        usage_snapshot_from(&summary, period)
    }

    pub(crate) async fn usage_records(
        &self,
        period: &str,
        page: Option<u32>,
        page_size: Option<u32>,
    ) -> Result<UsageRecordsPage, String> {
        let query = usage_date_query(period)?;
        let page = page.unwrap_or(DEFAULT_USAGE_PAGE).max(1);
        let page_size = page_size
            .unwrap_or(DEFAULT_USAGE_PAGE_SIZE)
            .clamp(1, MAX_USAGE_PAGE_SIZE);
        let prefix = if query.is_empty() {
            query
        } else {
            format!("{query}&")
        };
        let path = format!("/api/usage?{prefix}page={page}&pageSize={page_size}");
        let response = self.client()?.get_json(&path).await?;
        usage_records_from(&response, period, page, page_size)
    }

    pub(crate) async fn clients_snapshot(&self) -> ClientSnapshot {
        let Some(client) = self.client.as_ref() else {
            return ClientSnapshot {
                clients: Vec::new(),
                success: false,
                message: Some(ERR_CLIENTS_LIST.into()),
            };
        };
        match client.get_json("/api/clients").await {
            Ok(response) => project_clients(&response),
            Err(_) => ClientSnapshot {
                clients: Vec::new(),
                success: false,
                message: Some(ERR_CLIENTS_LIST.into()),
            },
        }
    }

    pub(crate) async fn clients_update(
        &self,
        id: &str,
        action: &str,
    ) -> Result<ClientSnapshot, String> {
        if !CLIENT_IDS.contains(&id) || !CLIENT_ACTIONS.contains(&action) {
            return Err(ERR_CLIENT_INPUT.into());
        }
        let client = self.client()?;
        let _write = client.write_guard().await;
        // The mutation response embeds the raw config; it is parsed but never
        // surfaced — only projected statuses and the boolean outcomes survive.
        let path = format!("/api/clients/{id}/{action}");
        let mutation = client
            .post_json_and_parse(&path)
            .await
            .map_err(|_| ERR_CLIENT_FAILED.to_string())?;
        let op_success = mutation
            .pointer("/result/success")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        // Top-level success includes project takeover sync: the client itself
        // may have updated fine while the sync failed. Keep that distinction.
        let top_success = mutation
            .get("success")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let (clients, refresh_ok) = match client.get_json("/api/clients").await {
            Ok(response) => (project_clients(&response).clients, true),
            // Fall back to the statuses embedded in the mutation response.
            Err(_) => (
                mutation
                    .get("clients")
                    .map(|list| project_clients(&json!({ "clients": list })).clients)
                    .unwrap_or_default(),
                false,
            ),
        };
        let (success, message) = match (top_success, op_success, refresh_ok) {
            (true, true, true) => (true, None),
            (false, true, _) => (false, Some(ERR_CLIENT_SYNC.to_string())),
            (true, true, false) => (false, Some(ERR_CLIENT_REFRESH.to_string())),
            _ => (false, Some(ERR_CLIENT_FAILED.to_string())),
        };
        Ok(ClientSnapshot {
            clients,
            success,
            message,
        })
    }
}

// ============================== Tauri commands ==============================

#[tauri::command]
pub async fn routing_snapshot(
    window: WebviewWindow,
    service: tauri::State<'_, ControlService>,
) -> Result<RoutingSnapshot, String> {
    crate::popup::guard(&window)?;
    service.routing_snapshot().await
}

#[tauri::command]
pub async fn routing_save(
    window: WebviewWindow,
    service: tauri::State<'_, ControlService>,
    change: RoutingChange,
) -> Result<RoutingSnapshot, String> {
    crate::popup::guard(&window)?;
    service.routing_save(change).await
}

#[tauri::command]
pub async fn routing_flags(
    window: WebviewWindow,
    service: tauri::State<'_, ControlService>,
    revision: String,
    family_routing: bool,
    fallback_enabled: bool,
) -> Result<RoutingSnapshot, String> {
    crate::popup::guard(&window)?;
    service
        .routing_flags(revision, family_routing, fallback_enabled)
        .await
}

#[tauri::command]
pub async fn usage_snapshot(
    window: WebviewWindow,
    service: tauri::State<'_, ControlService>,
    period: String,
) -> Result<UsageSnapshot, String> {
    crate::popup::guard(&window)?;
    service.usage_snapshot(&period).await
}

#[tauri::command]
pub async fn usage_records(
    window: WebviewWindow,
    service: tauri::State<'_, ControlService>,
    period: String,
    page: Option<u32>,
    page_size: Option<u32>,
) -> Result<UsageRecordsPage, String> {
    crate::popup::guard(&window)?;
    service.usage_records(&period, page, page_size).await
}

#[tauri::command]
pub async fn clients_snapshot(
    window: WebviewWindow,
    service: tauri::State<'_, ControlService>,
) -> Result<ClientSnapshot, String> {
    crate::popup::guard(&window)?;
    Ok(service.clients_snapshot().await)
}

#[tauri::command]
pub async fn clients_update(
    window: WebviewWindow,
    service: tauri::State<'_, ControlService>,
    id: String,
    action: String,
) -> Result<ClientSnapshot, String> {
    crate::popup::guard(&window)?;
    service.clients_update(&id, &action).await
}

// ============================== Routing projection ==============================

fn router_mut(config: &mut Value) -> Result<&mut Map<String, Value>, String> {
    config
        .as_object_mut()
        .ok_or_else(|| ERR_SAVE_NOT_CONFIRMED.to_string())?
        .entry("Router")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| ERR_SAVE_NOT_CONFIRMED.to_string())
}

fn string_target(config: &Value, pointer: &str) -> Option<String> {
    config
        .pointer(pointer)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
}

fn string_list(config: &Value, pointer: &str) -> Vec<String> {
    config
        .pointer(pointer)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|entry| !entry.trim().is_empty())
        .map(str::to_owned)
        .collect()
}

fn routing_snapshot_from(config: &Value) -> RoutingSnapshot {
    let router = config.get("Router");
    let mut routes = Vec::new();
    for field in SCENARIOS {
        routes.push(RoutingRoute {
            scope: "global".into(),
            field: (*field).into(),
            target: string_target(config, &format!("/Router/{field}")),
            fallback: string_list(config, &format!("/fallback/{field}")),
        });
    }
    for family in FAMILIES {
        for field in SCENARIOS {
            routes.push(RoutingRoute {
                scope: (*family).into(),
                field: (*field).into(),
                target: string_target(config, &format!("/Router/families/{family}/{field}")),
                fallback: string_list(
                    config,
                    &format!("/Router/families/{family}/fallback/{field}"),
                ),
            });
        }
    }
    if let Some(aliases) = router
        .and_then(|router| router.get("models"))
        .and_then(Value::as_object)
    {
        for (alias, target) in aliases {
            routes.push(RoutingRoute {
                scope: "models".into(),
                field: alias.clone(),
                target: target
                    .as_str()
                    .filter(|t| !t.trim().is_empty())
                    .map(str::to_owned),
                fallback: Vec::new(),
            });
        }
    }
    let fallback_enabled = router
        .and_then(|router| router.get("enableFallback"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    RoutingSnapshot {
        providers: crate::api::providers(config)
            .into_iter()
            .map(|provider| RoutingProvider {
                name: provider.name,
                models: provider.models,
            })
            .collect(),
        routes,
        family_routing: router
            .and_then(|router| router.get("enableFamilyRouting"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        fallback_enabled,
        revision: revision_of(config),
    }
}

// ============================== Revision digest ==============================

/// FNV-1a 64-bit over the canonical JSON encoding: a non-reversible
/// change-detection digest only. Never persisted, never a secret carrier, and
/// the config cannot be reconstructed from it.
pub(crate) fn revision_of(config: &Value) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    if let Ok(encoded) = serde_json::to_string(config) {
        for byte in encoded.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    format!("rev-{hash:016x}")
}

// ============================== Routing mutation ==============================

/// One JSON-pointer change to verify on readback. Family, scenario, and alias
/// names are allowlist-validated before they ever become pointer fragments.
struct ExpectedMutation {
    pointer: String,
    value: Option<Value>,
}

impl ExpectedMutation {
    fn matches(&self, config: &Value) -> bool {
        match (&self.value, config.pointer(&self.pointer)) {
            (Some(expected), Some(actual)) => actual == expected,
            (None, None | Some(Value::Null)) => true,
            _ => false,
        }
    }
}

fn normalize_target(target: &Option<String>) -> Option<String> {
    target
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn normalized_fallback(change: &RoutingChange) -> Option<Vec<String>> {
    change.fallback.as_ref().map(|entries| {
        entries
            .iter()
            .map(|entry| entry.trim().to_owned())
            .filter(|entry| !entry.is_empty())
            .collect::<Vec<_>>()
    })
}

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

pub(crate) fn valid_alias(alias: &str) -> bool {
    let alias = alias.trim();
    !alias.is_empty()
        && alias.len() <= MAX_ALIAS_LENGTH
        && !alias.contains(',')
        && alias
            .bytes()
            .all(|byte| byte.is_ascii_graphic() || byte == b' ')
}

fn clear_fallback_field(parent: &mut Map<String, Value>, field: &str) -> Result<(), String> {
    if let Some(value) = parent.get_mut("fallback") {
        let map = value
            .as_object_mut()
            .ok_or_else(|| ERR_SAVE_NOT_CONFIRMED.to_string())?;
        map.remove(field);
        if map.is_empty() {
            parent.remove("fallback");
        }
    }
    Ok(())
}

fn pointer_part(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}

fn apply_change(
    config: &mut Value,
    change: &RoutingChange,
) -> Result<Vec<ExpectedMutation>, String> {
    let field = change.field.trim();
    let target = normalize_target(&change.target);
    let fallback = normalized_fallback(change);
    let available = available_targets(config);
    let check = |value: &str| -> Result<(), String> {
        if available.contains(value) {
            Ok(())
        } else {
            Err(ERR_TARGET_UNAVAILABLE.into())
        }
    };
    if let Some(entries) = &fallback {
        for entry in entries {
            check(entry)?;
        }
    }

    match change.scope.as_str() {
        "global" => {
            if !SCENARIOS.contains(&field) {
                return Err(ERR_FIELD.into());
            }
            if let Some(value) = &target {
                check(value)?;
            }
            let router = router_mut(config)?;
            match &target {
                Some(value) => {
                    router.insert((*field).into(), Value::String(value.clone()));
                }
                None => {
                    router.remove(field);
                }
            }
            if let Some(entries) = &fallback {
                let root = config.as_object_mut().expect("validated config object");
                if entries.is_empty() {
                    clear_fallback_field(root, field)?;
                } else {
                    root.entry("fallback")
                        .or_insert_with(|| json!({}))
                        .as_object_mut()
                        .ok_or_else(|| ERR_SAVE_NOT_CONFIRMED.to_string())?
                        .insert((*field).into(), json!(entries));
                }
            }
            let mut expected = vec![ExpectedMutation {
                pointer: format!("/Router/{field}"),
                value: target.clone().map(Value::String),
            }];
            if fallback.is_some() {
                expected.push(ExpectedMutation {
                    pointer: format!("/fallback/{field}"),
                    // Empty list clears the scenario entry entirely.
                    value: fallback
                        .filter(|entries| !entries.is_empty())
                        .map(|entries| json!(entries)),
                });
            }
            Ok(expected)
        }
        "models" => {
            if !valid_alias(field) {
                return Err(ERR_ALIAS_INVALID.into());
            }
            if fallback.as_ref().is_some_and(|entries| !entries.is_empty()) {
                return Err(ERR_ALIAS_FALLBACK.into());
            }
            if let Some(value) = &target {
                check(value)?;
            }
            let router = router_mut(config)?;
            let models = router
                .entry("models")
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .ok_or_else(|| ERR_SAVE_NOT_CONFIRMED.to_string())?;
            match &target {
                Some(value) => {
                    models.insert((*field).into(), Value::String(value.clone()));
                }
                None => {
                    models.remove(field);
                }
            }
            Ok(vec![ExpectedMutation {
                pointer: format!("/Router/models/{}", pointer_part(field)),
                value: target.map(Value::String),
            }])
        }
        family if FAMILIES.contains(&family) => {
            if !SCENARIOS.contains(&field) {
                return Err(ERR_FIELD.into());
            }
            if let Some(value) = &target {
                check(value)?;
            }
            let router = router_mut(config)?;
            let family_config = router
                .entry("families")
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .ok_or_else(|| ERR_SAVE_NOT_CONFIRMED.to_string())?
                .entry(String::from(family))
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .ok_or_else(|| ERR_SAVE_NOT_CONFIRMED.to_string())?;
            match &target {
                Some(value) => {
                    family_config.insert((*field).into(), Value::String(value.clone()));
                }
                None => {
                    family_config.remove(field);
                }
            }
            if let Some(entries) = &fallback {
                if entries.is_empty() {
                    clear_fallback_field(family_config, field)?;
                } else {
                    family_config
                        .entry("fallback")
                        .or_insert_with(|| json!({}))
                        .as_object_mut()
                        .ok_or_else(|| ERR_SAVE_NOT_CONFIRMED.to_string())?
                        .insert((*field).into(), json!(entries));
                }
            }
            let mut expected = vec![ExpectedMutation {
                pointer: format!("/Router/families/{family}/{field}"),
                value: target.clone().map(Value::String),
            }];
            if fallback.is_some() {
                expected.push(ExpectedMutation {
                    pointer: format!("/Router/families/{family}/fallback/{field}"),
                    value: fallback
                        .filter(|entries| !entries.is_empty())
                        .map(|entries| json!(entries)),
                });
            }
            Ok(expected)
        }
        _ => Err(ERR_SCOPE.into()),
    }
}

// ============================== Usage projection ==============================

/// Loopback gateway shares this host, so the host timezone defines "today"
/// for the usage store's local-day buckets. std exposes no timezone API and
/// the `time` local-offset feature is not enabled, so probe `date +%z`
/// (locale-independent on macOS/Linux) and fall back to UTC.
fn local_utc_offset() -> time::UtcOffset {
    let Ok(output) = std::process::Command::new("date").arg("+%z").output() else {
        return time::UtcOffset::UTC;
    };
    let trimmed = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let bytes = trimmed.as_bytes();
    if trimmed.len() != 5 || (bytes[0] != b'+' && bytes[0] != b'-') {
        return time::UtcOffset::UTC;
    }
    let sign = if bytes[0] == b'-' { -1 } else { 1 };
    let (Ok(hours), Ok(minutes)) = (trimmed[1..3].parse::<i8>(), trimmed[3..5].parse::<i8>())
    else {
        return time::UtcOffset::UTC;
    };
    // Real offsets stay within ±14h; anything else is a malformed probe.
    if hours > 14 || minutes > 59 {
        return time::UtcOffset::UTC;
    }
    time::UtcOffset::from_hms(sign * hours, sign * minutes, 0).unwrap_or(time::UtcOffset::UTC)
}

fn rfc3339(moment: OffsetDateTime) -> String {
    moment
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}

/// (startDate, endDate) for the panel periods: today starts at local midnight
/// rendered in UTC, so the store's string comparisons and its local-day
/// buckets agree (never UTC midnight masquerading as "today"); 7d/30d are
/// rolling windows ending now.
fn usage_window(period: &str) -> Result<(String, String), String> {
    let now = OffsetDateTime::now_utc();
    let start = match period {
        "today" => now
            .to_offset(local_utc_offset())
            .replace_time(time::Time::MIDNIGHT),
        "7d" => now - time::Duration::days(7),
        "30d" => now - time::Duration::days(30),
        _ => return Err(ERR_PERIOD.into()),
    };
    Ok((rfc3339(start.to_offset(time::UtcOffset::UTC)), rfc3339(now)))
}

fn usage_date_query(period: &str) -> Result<String, String> {
    if period == "all" {
        return Ok(String::new());
    }
    let (start, end) = usage_window(period)?;
    Ok(format!(
        "startDate={}&endDate={}",
        encode_query(&start),
        encode_query(&end)
    ))
}

fn counter(summary: &Value, key: &str) -> u64 {
    summary
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|value| value as u64)
        .unwrap_or(0)
}

/// counter() analogue that keeps absence: missing, non-numeric, or negative
/// values become None instead of 0.
fn optional_counter(value: &Value, key: &str) -> Option<u64> {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|value| value as u64)
}

/// Finite-only float metric: missing, non-numeric, or non-finite → None.
fn optional_metric(value: &Value, key: &str) -> Option<f64> {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
}

fn buckets(summary: &Value, key: &str, cap: usize, sort_desc: bool) -> Vec<UsageBucket> {
    let mut entries: Vec<UsageBucket> = summary
        .get(key)
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|map| map.iter())
        .map(|(name, value)| UsageBucket {
            name: name.clone(),
            requests: counter(value, "count"),
            input_tokens: counter(value, "inputTokens"),
            output_tokens: counter(value, "outputTokens"),
            cache_read_tokens: counter(value, "cacheReadInputTokens"),
            cache_write_tokens: counter(value, "cacheCreationInputTokens"),
        })
        .filter(|bucket| !bucket.name.is_empty())
        .collect();
    if sort_desc {
        entries.sort_by(|a, b| b.requests.cmp(&a.requests).then(a.name.cmp(&b.name)));
    } else {
        entries.sort_by(|a, b| a.name.cmp(&b.name));
    }
    entries.truncate(cap);
    entries
}

/// Whitelisted counters only: non-whitelisted buckets (byClient, byScenario,
/// byFamily) are never projected; avgTtft/avgTokensPerSecond are surfaced as
/// the optional typed metrics on the snapshot.
fn usage_snapshot_from(summary: &Value, period: &str) -> Result<UsageSnapshot, String> {
    if !summary.is_object() {
        return Err(ERR_USAGE.into());
    }
    Ok(UsageSnapshot {
        period: period.into(),
        total_requests: counter(summary, "totalRequests"),
        success_count: counter(summary, "successCount"),
        error_count: counter(summary, "errorCount"),
        input_tokens: counter(summary, "totalInputTokens"),
        output_tokens: counter(summary, "totalOutputTokens"),
        cache_read_tokens: counter(summary, "totalCacheReadInputTokens"),
        cache_write_tokens: counter(summary, "totalCacheCreationInputTokens"),
        estimated_count: counter(summary, "estimatedCount"),
        by_model: buckets(summary, "byModel", MAX_MODEL_BUCKETS, true),
        by_provider: buckets(summary, "byProvider", MAX_PROVIDER_BUCKETS, true),
        by_day: buckets(
            summary,
            "byDay",
            if period == "all" {
                usize::MAX
            } else {
                MAX_DAY_BUCKETS
            },
            false,
        ),
        avg_ttft_ms: optional_counter(summary, "avgTtft"),
        avg_tokens_per_second: optional_metric(summary, "avgTokensPerSecond"),
        updated_at: rfc3339(OffsetDateTime::now_utc()),
    })
}

/// Char-boundary-safe truncation so the IPC payload can never split a codepoint
/// or carry an unbounded upstream error body.
fn truncate_error_message(value: Option<&Value>) -> Option<String> {
    projected_text(value).map(|text| {
        text.chars()
            .take(MAX_USAGE_ERROR_MESSAGE_CHARS)
            .collect::<String>()
    })
}

/// Non-object entries are skipped rather than defaulted, mirroring the client
/// projection's treatment of unknown ids.
fn usage_record_view(entry: &Value) -> Option<UsageRecordView> {
    // get() resolves keys only on objects, so this doubles as the object check.
    entry.as_object()?;
    Some(UsageRecordView {
        timestamp: projected_text(entry.get("timestamp")).unwrap_or_default(),
        provider: projected_text(entry.get("provider")).unwrap_or_default(),
        model: projected_text(entry.get("model")).unwrap_or_default(),
        original_model: projected_text(entry.get("originalModel")),
        upstream_model: projected_text(entry.get("upstreamModel")),
        client_type: projected_text(entry.get("clientType")),
        scenario_type: projected_text(entry.get("scenarioType")).unwrap_or_default(),
        input_tokens: counter(entry, "inputTokens"),
        output_tokens: counter(entry, "outputTokens"),
        cache_read_tokens: counter(entry, "cacheReadInputTokens"),
        cache_write_tokens: counter(entry, "cacheCreationInputTokens"),
        ttft_ms: optional_counter(entry, "ttft"),
        tokens_per_second: optional_metric(entry, "tokensPerSecond"),
        duration_ms: counter(entry, "durationMs"),
        status: projected_text(entry.get("status")).unwrap_or_default(),
        usage_estimated: entry
            .get("usageEstimated")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        error_message: truncate_error_message(entry.get("errorMessage")),
    })
}

/// Whitelisted usage records projection: non-object payloads, non-array
/// records, and sensitive fields (responseBody, sessionId, stream, id) never
/// cross IPC; the pager echoes the clamped values the gateway was queried with.
fn usage_records_from(
    response: &Value,
    period: &str,
    page: u32,
    page_size: u32,
) -> Result<UsageRecordsPage, String> {
    if !response.is_object() {
        return Err(ERR_USAGE.into());
    }
    let entries = response
        .get("records")
        .and_then(Value::as_array)
        .ok_or(ERR_USAGE)?;
    Ok(UsageRecordsPage {
        period: period.into(),
        page,
        page_size,
        total: counter(response, "total"),
        records: entries.iter().filter_map(usage_record_view).collect(),
    })
}

/// Percent-encodes everything outside the unreserved set. Used for query
/// values here and for project id path segments in `projects`.
pub(crate) fn encode_query(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

// ============================== Clients projection ==============================

fn projected_text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .map(str::to_owned)
}

/// Only the shared CLIENT_IDS allowlist is projected; configPath, details,
/// and any unknown fields are dropped here, never crossing IPC.
fn project_clients(response: &Value) -> ClientSnapshot {
    let mut clients = Vec::new();
    if let Some(entries) = response.get("clients").and_then(Value::as_array) {
        for entry in entries {
            let Some(id) = entry
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| CLIENT_IDS.contains(id))
            else {
                continue;
            };
            clients.push(ClientView {
                id: id.into(),
                name: projected_text(entry.get("name")).unwrap_or_else(|| id.to_string()),
                enabled: entry
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                managed: entry
                    .get("managed")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                exists: entry
                    .get("exists")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                active_model: projected_text(entry.get("activeModel")),
                model_alias: projected_text(entry.get("modelAlias")),
            });
        }
    }
    ClientSnapshot {
        clients,
        success: true,
        message: None,
    }
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
                "families": {
                    "opus": {
                        "default": "alpha,one",
                        "think": "alpha,two",
                        "fallback": {"think": ["alpha,one"]}
                    }
                },
                "models": {"fast": "alpha,two"}
            },
            "fallback": {"default": ["alpha,two", "beta,three"]},
            "unknown": {"deep": [true, null, 2, "$SECRET"]}
        })
    }

    fn route<'a>(snapshot: &'a RoutingSnapshot, scope: &str, field: &str) -> &'a RoutingRoute {
        snapshot
            .routes
            .iter()
            .find(|route| route.scope == scope && route.field == field)
            .unwrap_or_else(|| panic!("missing route {scope}/{field}"))
    }

    fn serialized(value: &impl Serialize) -> String {
        serde_json::to_string(value).unwrap()
    }

    #[test]
    fn snapshot_projects_all_scopes_flags_and_revision() {
        let snapshot = routing_snapshot_from(&config());
        assert_eq!(snapshot.providers.len(), 1);
        assert_eq!(snapshot.providers[0].name, "alpha");
        assert!(snapshot.family_routing);
        // Disabled providers stay valid as fallback owners server-side, so the
        // list is projected verbatim even though beta is filtered elsewhere.
        assert_eq!(
            route(&snapshot, "global", "default").fallback,
            ["alpha,two", "beta,three"]
        );
        assert_eq!(
            route(&snapshot, "global", "default").target.as_deref(),
            Some("alpha,one")
        );
        assert_eq!(route(&snapshot, "global", "webSearch").target, None);
        assert_eq!(
            route(&snapshot, "opus", "think").target.as_deref(),
            Some("alpha,two")
        );
        assert_eq!(route(&snapshot, "opus", "think").fallback, ["alpha,one"]);
        assert_eq!(route(&snapshot, "sonnet", "default").target, None);
        assert_eq!(
            route(&snapshot, "models", "fast").target.as_deref(),
            Some("alpha,two")
        );
        assert!(snapshot.revision.starts_with("rev-"));
        assert_eq!(snapshot.revision, revision_of(&config()));
    }

    #[test]
    fn snapshot_serialization_never_carries_raw_config() {
        let snapshot = routing_snapshot_from(&config());
        let rendered = serialized(&snapshot);
        for secret in ["$SECRET", "api_key", "$UPSTREAM", "$ADMIN", "unknown"] {
            assert!(!rendered.contains(secret), "leaked {secret}");
        }
    }

    #[test]
    fn clearing_one_fallback_preserves_other_scenarios() {
        for scope in ["global", "opus"] {
            let mut cfg = config();
            let base = if scope == "global" {
                "/fallback"
            } else {
                "/Router/families/opus/fallback"
            };
            let map = cfg.pointer_mut(base).unwrap().as_object_mut().unwrap();
            map.insert("image".into(), json!(["alpha,one"]));
            map.insert("think".into(), json!(["alpha,two"]));
            let expected = apply_change(
                &mut cfg,
                &RoutingChange {
                    revision: String::new(),
                    scope: scope.into(),
                    field: "think".into(),
                    target: None,
                    fallback: Some(vec![]),
                },
            )
            .unwrap();
            assert_eq!(
                cfg.pointer(&format!("{base}/image")),
                Some(&json!(["alpha,one"]))
            );
            assert!(cfg.pointer(&format!("{base}/think")).is_none());
            assert!(expected.iter().all(|check| check.matches(&cfg)));
        }
    }

    #[test]
    fn aliases_with_pointer_characters_verify_the_actual_key() {
        let mut cfg = config();
        let checks = apply_change(
            &mut cfg,
            &RoutingChange {
                revision: String::new(),
                scope: "models".into(),
                field: "custom/fast~v2".into(),
                target: Some("alpha,one".into()),
                fallback: None,
            },
        )
        .unwrap();
        assert!(checks.iter().all(|check| check.matches(&cfg)));
        assert_eq!(
            cfg["Router"]["models"]["custom/fast~v2"],
            json!("alpha,one")
        );
    }

    #[test]
    fn fallback_switch_follows_engine_flag_not_list_presence() {
        let mut cfg = config();
        assert!(!routing_snapshot_from(&cfg).fallback_enabled);
        cfg["Router"]["enableFallback"] = json!(true);
        assert!(routing_snapshot_from(&cfg).fallback_enabled);
        cfg.as_object_mut().unwrap().remove("fallback");
        assert!(routing_snapshot_from(&cfg).fallback_enabled);
    }

    #[test]
    fn revision_changes_with_any_field_and_is_stable() {
        assert_eq!(revision_of(&config()), revision_of(&config()));
        let mut changed = config();
        changed["Router"]["webSearch"] = json!("alpha,one");
        assert_ne!(revision_of(&config()), revision_of(&changed));
        changed = config();
        changed["unknown"]["deep"][3] = json!("other");
        assert_ne!(revision_of(&config()), revision_of(&changed));
    }

    #[tokio::test]
    async fn save_posts_preserving_raw_config_and_returns_refreshed_snapshot() {
        let original = config();
        let mut expected = original.clone();
        expected["Router"]["webSearch"] = json!("alpha,two");
        let mock = Mock::new(vec![
            response(original.clone()),
            response(json!({ "success": true })),
            response(expected.clone()),
        ]);
        let service = ControlService::new(Some(mock.client()));
        let snapshot = service
            .routing_save(RoutingChange {
                revision: revision_of(&original),
                scope: "global".into(),
                field: "webSearch".into(),
                target: Some("alpha,two".into()),
                fallback: None,
            })
            .await
            .unwrap();
        assert_eq!(
            route(&snapshot, "global", "webSearch").target.as_deref(),
            Some("alpha,two")
        );
        assert_eq!(snapshot.revision, revision_of(&expected));
        let requests = mock.finish().await;
        assert_eq!(requests.len(), 3);
        assert!(requests[1].starts_with("POST /api/config "));
        let posted: Value =
            serde_json::from_str(requests[1].split_once("\r\n\r\n").unwrap().1).unwrap();
        // Unrelated raw fields (placeholders, unknown keys) preserved verbatim.
        assert_eq!(posted, expected);
    }

    #[tokio::test]
    async fn save_updates_fallback_lists_and_is_reflected_in_snapshot() {
        let original = config();
        let mut expected = original.clone();
        expected["Router"]["families"]["opus"]["fallback"]["webSearch"] = json!(["alpha,one"]);
        let mock = Mock::new(vec![
            response(original.clone()),
            response(json!({ "success": true })),
            response(expected.clone()),
        ]);
        let service = ControlService::new(Some(mock.client()));
        let snapshot = service
            .routing_save(RoutingChange {
                revision: revision_of(&original),
                scope: "opus".into(),
                field: "webSearch".into(),
                target: None,
                fallback: Some(vec!["alpha,one".into()]),
            })
            .await
            .unwrap();
        assert_eq!(
            route(&snapshot, "opus", "webSearch").fallback,
            ["alpha,one"]
        );
        assert_eq!(snapshot.revision, revision_of(&expected));
        assert_eq!(mock.finish().await.len(), 3);
    }

    #[tokio::test]
    async fn save_rejects_stale_unavailable_and_malformed_without_posting() {
        // Stale revision: config fetched, nothing posted.
        let mock = Mock::new(vec![response(config())]);
        let service = ControlService::new(Some(mock.client()));
        let error = service
            .routing_save(RoutingChange {
                revision: "rev-deadbeefdeadbeef".into(),
                scope: "global".into(),
                field: "webSearch".into(),
                target: Some("alpha,one".into()),
                fallback: None,
            })
            .await
            .unwrap_err();
        assert!(error.contains("stale"));
        assert_eq!(mock.finish().await.len(), 1);

        // Unavailable target and fallback entries: validated after the fresh
        // fetch, still no post (beta is disabled, ghost models do not exist).
        for (target, fallback) in [
            (Some("alpha,ghost".to_string()), None),
            (None, Some(vec!["beta,three".to_string()])),
            (Some("beta,three".to_string()), None),
        ] {
            let mock = Mock::new(vec![response(config())]);
            let service = ControlService::new(Some(mock.client()));
            let error = service
                .routing_save(RoutingChange {
                    revision: revision_of(&config()),
                    scope: "global".into(),
                    field: "webSearch".into(),
                    target,
                    fallback,
                })
                .await
                .unwrap_err();
            assert_eq!(error, ERR_TARGET_UNAVAILABLE);
            assert_eq!(mock.finish().await.len(), 1);
        }

        // Unknown scope/field/alias and alias fallback lists are rejected
        // before any request at all.
        for (scope, field, target, fallback) in [
            ("plugins", "default", None, None),
            ("global", "notAScenario", None, None),
            ("models", "bad,alias", Some("alpha,one".to_string()), None),
            (
                "models",
                "ok",
                Some("alpha,one".to_string()),
                Some(vec!["alpha,two".to_string()]),
            ),
        ] {
            let mock = Mock::new(vec![]);
            let service = ControlService::new(Some(mock.client()));
            assert!(service
                .routing_save(RoutingChange {
                    revision: "rev-1".into(),
                    scope: scope.into(),
                    field: field.into(),
                    target,
                    fallback,
                })
                .await
                .is_err());
            assert!(mock.finish().await.is_empty());
        }
    }

    #[tokio::test]
    async fn save_clears_targets_aliases_and_family_fallback() {
        let original = config();
        let mut after_post = original.clone();
        // Clearing an already-absent choice (webSearch) is allowed; the null
        // target removes the family scenario; an empty fallback clears the
        // family fallback map. Unrelated entries (models alias) stay intact.
        after_post["Router"]["families"]["opus"]
            .as_object_mut()
            .unwrap()
            .remove("think");
        after_post["Router"]["families"]["opus"]
            .as_object_mut()
            .unwrap()
            .remove("fallback");
        let mock = Mock::new(vec![
            response(original.clone()),
            response(json!({ "success": true })),
            response(after_post.clone()),
        ]);
        let service = ControlService::new(Some(mock.client()));
        let snapshot = service
            .routing_save(RoutingChange {
                revision: revision_of(&original),
                scope: "opus".into(),
                field: "think".into(),
                target: None,
                fallback: Some(Vec::new()),
            })
            .await
            .unwrap();
        assert_eq!(route(&snapshot, "opus", "think").target, None);
        assert_eq!(
            route(&snapshot, "opus", "think").fallback,
            Vec::<String>::new()
        );
        // Unrelated scopes (the models alias) survive untouched.
        assert_eq!(
            route(&snapshot, "models", "fast").target.as_deref(),
            Some("alpha,two")
        );
        assert_eq!(snapshot.revision, revision_of(&after_post));
        let requests = mock.finish().await;
        assert_eq!(requests.len(), 3);
        let posted: Value =
            serde_json::from_str(requests[1].split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(posted.pointer("/Router/families/opus/think"), None);
        assert_eq!(posted.pointer("/Router/families/opus/fallback"), None);
    }

    #[tokio::test]
    async fn flags_toggle_engine_switches_without_removing_fallback_map() {
        let original = config();
        let mut expected = original.clone();
        expected["Router"]["enableFamilyRouting"] = json!(false);
        expected["Router"]["enableFallback"] = json!(false);
        let mock = Mock::new(vec![
            response(original.clone()),
            response(json!({ "success": true })),
            response(expected.clone()),
        ]);
        let service = ControlService::new(Some(mock.client()));
        let snapshot = service
            .routing_flags(revision_of(&original), false, false)
            .await
            .unwrap();
        assert!(!snapshot.family_routing);
        assert!(!snapshot.fallback_enabled);
        let requests = mock.finish().await;
        assert_eq!(requests.len(), 3);
        let posted: Value =
            serde_json::from_str(requests[1].split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(posted.get("fallback"), original.get("fallback"));
        assert_eq!(
            posted.pointer("/Router/families"),
            original.pointer("/Router/families")
        );
        assert_eq!(
            posted.pointer("/Router/enableFallback"),
            Some(&json!(false))
        );
        assert_eq!(
            posted.pointer("/Router/enableFamilyRouting"),
            Some(&json!(false))
        );

        // Stale revision: config fetched, nothing posted.
        let mock = Mock::new(vec![response(original.clone())]);
        let service = ControlService::new(Some(mock.client()));
        assert!(service
            .routing_flags("rev-0000000000000000".into(), true, true)
            .await
            .is_err());
        assert_eq!(mock.finish().await.len(), 1);
    }

    #[test]
    fn usage_whitelisted_counters_and_sorted_buckets_only() {
        let summary = json!({
            "totalRequests": 12, "successCount": 10, "errorCount": 2,
            "totalInputTokens": 100.0, "totalOutputTokens": 200,
            "totalCacheReadInputTokens": 30, "totalCacheCreationInputTokens": 40,
            "estimatedCount": 3, "avgTtft": 999, "avgTokensPerSecond": 42,
            "byProvider": {
                "beta": {"count": 2, "inputTokens": 5, "outputTokens": 6},
                "alpha": {"count": 10, "inputTokens": 7, "outputTokens": 8, "cacheReadInputTokens": 1},
                "$SECRET": {"count": 1}
            },
            "byDay": {"2026-11-17": {"count": 9}, "2026-11-16": {"count": 3}},
            "byModel": {"model-a": {"count": 4, "inputTokens": 12, "outputTokens": 3, "cacheReadInputTokens": 9, "cacheCreationInputTokens": 2, "secret": "sekret"}},
            "byClient": {"secret-client": {"count": 4}}
        });
        let snapshot = usage_snapshot_from(&summary, "7d").unwrap();
        assert_eq!(snapshot.period, "7d");
        assert_eq!(snapshot.total_requests, 12);
        assert_eq!(snapshot.error_count, 2);
        assert_eq!(snapshot.input_tokens, 100);
        assert_eq!(snapshot.cache_read_tokens, 30);
        assert_eq!(snapshot.cache_write_tokens, 40);
        assert_eq!(snapshot.estimated_count, 3);
        // Optional aggregates are surfaced from the same summary payload.
        assert_eq!(snapshot.avg_ttft_ms, Some(999));
        assert_eq!(snapshot.avg_tokens_per_second, Some(42.0));
        assert_eq!(snapshot.by_provider[0].name, "alpha");
        assert_eq!(snapshot.by_provider[0].requests, 10);
        assert_eq!(snapshot.by_day.first().unwrap().name, "2026-11-16");
        let rendered = serialized(&snapshot);
        assert!(rendered.contains("\"avgTtftMs\":999"));
        assert!(rendered.contains("\"avgTokensPerSecond\":42.0"));
        assert_eq!(snapshot.by_model[0].name, "model-a");
        assert_eq!(snapshot.by_model[0].cache_read_tokens, 9);
        assert_eq!(snapshot.by_model[0].cache_write_tokens, 2);
        assert!(!rendered.contains("byScenario"));
        assert!(!rendered.contains("byFamily"));
        assert!(!rendered.contains("byClient"));
        assert!(!rendered.contains("secret-client"));
        assert!(!rendered.contains("sekret"));
        assert!(snapshot.updated_at.contains('T'));

        // Bucket counts are capped for the compact panel.
        let mut overflowing = json!({ "byProvider": {}, "byDay": {}, "byModel": {} });
        let providers = overflowing["byProvider"].as_object_mut().unwrap();
        for index in 0..(MAX_PROVIDER_BUCKETS + 10) {
            providers.insert(format!("p{index:03}"), json!({ "count": index }));
        }
        let days = overflowing["byDay"].as_object_mut().unwrap();
        for index in 0..(MAX_DAY_BUCKETS + 10) {
            days.insert(format!("2026-01-{index:02}"), json!({ "count": index }));
        }
        for index in 0..(MAX_MODEL_BUCKETS + 10) {
            overflowing["byModel"]
                .as_object_mut()
                .unwrap()
                .insert(format!("m{index:03}"), json!({"count": index}));
        }
        let snapshot = usage_snapshot_from(&overflowing, "30d").unwrap();
        assert_eq!(snapshot.by_model.len(), MAX_MODEL_BUCKETS);
        assert_eq!(
            snapshot.by_model[0].requests,
            (MAX_MODEL_BUCKETS + 9) as u64
        );
        assert_eq!(snapshot.by_provider.len(), MAX_PROVIDER_BUCKETS);
        assert_eq!(snapshot.by_day.len(), MAX_DAY_BUCKETS);
    }

    #[test]
    fn usage_malformed_summary_is_a_safe_error() {
        assert_eq!(
            usage_snapshot_from(&json!([]), "today").unwrap_err(),
            ERR_USAGE
        );
        let snapshot =
            usage_snapshot_from(&json!({"totalRequests": "leak", "errorCount": -5}), "today")
                .unwrap();
        assert_eq!(snapshot.total_requests, 0);
        assert_eq!(snapshot.error_count, 0);
        assert_eq!(snapshot.avg_ttft_ms, None);
        assert_eq!(snapshot.avg_tokens_per_second, None);
    }

    #[test]
    fn usage_snapshot_optional_metrics_follow_summary_availability() {
        // Absent, null, non-numeric, and negative metrics are all None.
        let snapshot = usage_snapshot_from(
            &json!({"avgTtft": null, "avgTokensPerSecond": "leak"}),
            "today",
        )
        .unwrap();
        assert_eq!(snapshot.avg_ttft_ms, None);
        assert_eq!(snapshot.avg_tokens_per_second, None);
        let snapshot =
            usage_snapshot_from(&json!({"avgTtft": -5, "avgTokensPerSecond": 12.5}), "today")
                .unwrap();
        assert_eq!(snapshot.avg_ttft_ms, None);
        assert_eq!(snapshot.avg_tokens_per_second, Some(12.5));
    }

    #[tokio::test]
    async fn usage_unknown_period_and_transport_failures_are_safe() {
        let mock = Mock::new(vec![]);
        let service = ControlService::new(Some(mock.client()));
        assert_eq!(service.usage_snapshot("90d").await.unwrap_err(), ERR_PERIOD);
        assert!(mock.finish().await.is_empty());

        let mock = Mock::new(vec![(500, "LEAK_SECRET".into())]);
        let service = ControlService::new(Some(mock.client()));
        let error = service.usage_snapshot("today").await.unwrap_err();
        assert!(!error.contains("LEAK_SECRET"));
        assert_eq!(mock.finish().await.len(), 1);
    }

    #[tokio::test]
    async fn usage_records_project_whitelist_and_echo_clamped_pager() {
        let payload = json!({
            "records": [
                {
                    "id": "row-1", "timestamp": "2026-11-17T09:30:00.000Z",
                    "sessionId": "sess-LEAK", "stream": true,
                    "provider": "alpha", "originalModel": "claude-opus-4,group:main",
                    "model": "claude-opus-4", "upstreamModel": "claude-opus-4-5",
                    "modelFamily": "opus", "scenarioType": "think",
                    "clientType": "claude-code", "usageEstimated": true,
                    "inputTokens": 100, "outputTokens": 200.7,
                    "cacheReadInputTokens": 30, "cacheCreationInputTokens": 40,
                    "ttft": 820, "tokensPerSecond": 55.5, "durationMs": 3600,
                    "status": "success", "responseBody": "LEAK_SECRET_BODY"
                },
                {
                    "timestamp": "2026-11-17T10:00:00.000Z", "provider": "beta",
                    "model": "model-b", "scenarioType": "default",
                    "inputTokens": "leak", "outputTokens": -5,
                    "ttft": null, "tokensPerSecond": null, "durationMs": 10,
                    "status": "error", "errorMessage": "upstream exploded"
                },
                "not-an-object",
                {"APIKEY": "$SECRET"}
            ],
            "summary": {"totalRequests": "unused"},
            "total": 41, "page": 3, "pageSize": 10
        });
        let mock = Mock::new(vec![response(payload)]);
        let service = ControlService::new(Some(mock.client()));
        let page = service.usage_records("7d", None, None).await.unwrap();

        // The pager echoes the clamped request values, not the gateway's.
        assert_eq!(page.period, "7d");
        assert_eq!(page.page, 1);
        assert_eq!(page.page_size, 20);
        assert_eq!(page.total, 41);

        let full = &page.records[0];
        assert_eq!(full.timestamp, "2026-11-17T09:30:00.000Z");
        assert_eq!(full.provider, "alpha");
        assert_eq!(full.model, "claude-opus-4");
        assert_eq!(
            full.original_model.as_deref(),
            Some("claude-opus-4,group:main")
        );
        assert_eq!(full.upstream_model.as_deref(), Some("claude-opus-4-5"));
        assert_eq!(full.client_type.as_deref(), Some("claude-code"));
        assert_eq!(full.scenario_type, "think");
        assert_eq!(full.input_tokens, 100);
        assert_eq!(full.output_tokens, 200);
        assert_eq!(full.cache_read_tokens, 30);
        assert_eq!(full.cache_write_tokens, 40);
        assert_eq!(full.ttft_ms, Some(820));
        assert_eq!(full.tokens_per_second, Some(55.5));
        assert_eq!(full.duration_ms, 3600);
        assert_eq!(full.status, "success");
        assert!(full.usage_estimated);
        assert_eq!(full.error_message, None);

        // Null, missing, and non-numeric fields default to None/0.
        let errored = &page.records[1];
        assert_eq!(errored.input_tokens, 0);
        assert_eq!(errored.output_tokens, 0);
        assert_eq!(errored.ttft_ms, None);
        assert_eq!(errored.tokens_per_second, None);
        assert_eq!(errored.status, "error");
        assert_eq!(errored.error_message.as_deref(), Some("upstream exploded"));
        assert!(!errored.usage_estimated);

        // Non-object entries are skipped, object entries survive without any
        // unknown-key leakage.
        assert_eq!(page.records.len(), 3);
        let rendered = serialized(&page);
        for secret in [
            "LEAK_SECRET_BODY",
            "sess-LEAK",
            "\"sessionId\"",
            "\"stream\"",
            "row-1",
            "modelFamily",
            "responseBody",
            "summary",
            "APIKEY",
            "$SECRET",
            "\"leak\"",
        ] {
            assert!(!rendered.contains(secret), "leaked {secret}");
        }

        let requests = mock.finish().await;
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with("GET /api/usage?startDate="));
        assert!(requests[0].contains("&page=1&pageSize=20"));
    }

    #[tokio::test]
    async fn all_time_omits_date_filters_and_keeps_older_days_and_pagination() {
        let days: serde_json::Map<String, Value> = (0..90)
            .map(|i| {
                (
                    (OffsetDateTime::UNIX_EPOCH.date() + time::Duration::days(i)).to_string(),
                    json!({"count":1}),
                )
            })
            .collect();
        let mock = Mock::new(vec![
            response(json!({"byDay":days})),
            response(json!({"records":[],"total":90})),
        ]);
        let service = ControlService::new(Some(mock.client()));
        assert_eq!(
            service.usage_snapshot("all").await.unwrap().by_day.len(),
            90
        );
        service
            .usage_records("all", Some(2), Some(20))
            .await
            .unwrap();
        let requests = mock.finish().await;
        assert!(requests[0].starts_with("GET /api/usage/summary HTTP/"));
        assert!(requests[1].starts_with("GET /api/usage?page=2&pageSize=20 HTTP/"));
    }

    #[tokio::test]
    async fn usage_records_clamp_page_and_page_size_bounds() {
        for (page, page_size, expected) in [
            (None, None, "&page=1&pageSize=20"),
            (Some(0), Some(0), "&page=1&pageSize=1"),
            (Some(7), Some(999), "&page=7&pageSize=50"),
        ] {
            let mock = Mock::new(vec![response(json!({"records": [], "total": 0}))]);
            let service = ControlService::new(Some(mock.client()));
            service
                .usage_records("today", page, page_size)
                .await
                .unwrap();
            let requests = mock.finish().await;
            assert_eq!(requests.len(), 1);
            assert!(requests[0].contains(expected), "missing {expected}");
        }
    }

    #[tokio::test]
    async fn usage_records_truncate_error_messages_on_char_boundaries() {
        let long = "E".repeat(600) + "TAIL_LEAK";
        let multibyte = "中".repeat(600);
        let payload = json!({
            "records": [
                {"status": "error", "errorMessage": long},
                {"status": "error", "errorMessage": multibyte}
            ],
            "total": 2
        });
        let mock = Mock::new(vec![response(payload)]);
        let service = ControlService::new(Some(mock.client()));
        let page = service.usage_records("today", None, None).await.unwrap();
        assert_eq!(
            page.records[0].error_message,
            Some("E".repeat(MAX_USAGE_ERROR_MESSAGE_CHARS))
        );
        // Truncation counts characters, not bytes, so no codepoint is split.
        assert_eq!(
            page.records[1].error_message,
            Some("中".repeat(MAX_USAGE_ERROR_MESSAGE_CHARS))
        );
        let rendered = serialized(&page);
        assert!(!rendered.contains("TAIL_LEAK"));
    }

    #[tokio::test]
    async fn usage_records_malformed_and_failures_are_safe() {
        // Unknown period is rejected before any request.
        let mock = Mock::new(vec![]);
        let service = ControlService::new(Some(mock.client()));
        assert_eq!(
            service.usage_records("90d", None, None).await.unwrap_err(),
            ERR_PERIOD
        );
        assert!(mock.finish().await.is_empty());

        // Non-object payloads and non-array records are fixed safe errors.
        let mock = Mock::new(vec![
            response(json!([])),
            response(json!({"records": "leak"})),
        ]);
        let service = ControlService::new(Some(mock.client()));
        assert_eq!(
            service
                .usage_records("today", None, None)
                .await
                .unwrap_err(),
            ERR_USAGE
        );
        assert_eq!(
            service
                .usage_records("today", None, None)
                .await
                .unwrap_err(),
            ERR_USAGE
        );
        assert_eq!(mock.finish().await.len(), 2);

        // Transport failures stay sanitized.
        let mock = Mock::new(vec![(500, "LEAK_SECRET".into())]);
        let service = ControlService::new(Some(mock.client()));
        let error = service
            .usage_records("today", None, None)
            .await
            .unwrap_err();
        assert!(!error.contains("LEAK_SECRET"));
        assert_eq!(mock.finish().await.len(), 1);
    }

    #[test]
    fn today_window_is_local_midnight_rendered_as_utc() {
        let (start, end) = usage_window("today").unwrap();
        let parsed_start = OffsetDateTime::parse(&start, &Rfc3339).unwrap();
        let parsed_end = OffsetDateTime::parse(&end, &Rfc3339).unwrap();
        assert!(parsed_start <= parsed_end);
        // The window start is midnight of the current local day (offset probed
        // on this host, matching the loopback gateway's local-day buckets).
        let local_start = parsed_start.to_offset(local_utc_offset());
        let local_now = parsed_end.to_offset(local_utc_offset());
        assert_eq!(local_start.time(), time::Time::MIDNIGHT);
        assert_eq!(local_start.date(), local_now.date());
        // Rolling windows end at now and span their period.
        let (start_7, _) = usage_window("7d").unwrap();
        let parsed_7 = OffsetDateTime::parse(&start_7, &Rfc3339).unwrap();
        let window = parsed_end - parsed_7;
        assert!((window - time::Duration::days(7)).abs() < time::Duration::seconds(5));
    }

    #[tokio::test]
    async fn clients_snapshot_projects_safe_fields_and_drops_paths_and_details() {
        let statuses = json!({"clients": [
            {"id": "claudeCode", "name": "Claude Code", "enabled": true, "managed": true,
             "exists": true, "activeModel": "alpha,one", "modelAlias": "fast",
             "configPath": "/Users/x/.claude/settings.json", "details": "LEAK_SECRET"},
            {"id": "codex", "name": "Codex", "enabled": false, "managed": false, "exists": false},
            {"id": "evilClient", "name": "Injected", "enabled": true},
            {"id": "pi", "api_key": "$SECRET"}
        ]});
        let snapshot = project_clients(&statuses);
        assert!(snapshot.success);
        assert!(snapshot.message.is_none());
        assert_eq!(snapshot.clients.len(), 3);
        assert_eq!(
            snapshot.clients[0].active_model.as_deref(),
            Some("alpha,one")
        );
        assert_eq!(snapshot.clients[0].model_alias.as_deref(), Some("fast"));
        assert!(!snapshot.clients[1].enabled);
        let rendered = serialized(&snapshot);
        for secret in [
            "configPath",
            "details",
            "LEAK_SECRET",
            "$SECRET",
            "evilClient",
        ] {
            assert!(!rendered.contains(secret), "leaked {secret}");
        }

        // Fetch failure -> success:false with a fixed safe message.
        let mock = Mock::new(vec![(500, "LEAK_SECRET".into())]);
        let service = ControlService::new(Some(mock.client()));
        let snapshot = service.clients_snapshot().await;
        assert!(!snapshot.success);
        assert_eq!(snapshot.clients, Vec::<ClientView>::new());
        assert!(!snapshot.message.unwrap().contains("LEAK_SECRET"));
        assert_eq!(mock.finish().await.len(), 1);
    }

    #[tokio::test]
    async fn clients_update_allowlists_ids_and_surfaces_partial_failure() {
        let mock = Mock::new(vec![]);
        let service = ControlService::new(Some(mock.client()));
        assert_eq!(
            service
                .clients_update("evilClient", "disable")
                .await
                .unwrap_err(),
            ERR_CLIENT_INPUT
        );
        assert_eq!(
            service.clients_update("pi", "takeover").await.unwrap_err(),
            ERR_CLIENT_INPUT
        );
        assert!(mock.finish().await.is_empty());

        // Operation succeeds but top-level success is false (project takeover
        // sync failed): the distinction must survive projection, and the raw
        // `config` embedded in the mutation response must never surface.
        let statuses = json!({"clients": [
            {"id": "pi", "name": "pi", "enabled": false, "managed": false, "exists": true}
        ]});
        let mutation = json!({
            "success": false,
            "result": {"id": "pi", "action": "disable", "success": true},
            "clients": statuses["clients"],
            "config": {"APIKEY": "$SECRET", "Clients": {"pi": {"enabled": false}}}
        });
        let refresh = json!({"clients": [
            {"id": "pi", "name": "pi", "enabled": false, "managed": true, "exists": true,
             "configPath": "/secret/path", "details": "LEAK"}
        ]});
        let mock = Mock::new(vec![response(mutation), response(refresh)]);
        let service = ControlService::new(Some(mock.client()));
        let snapshot = service.clients_update("pi", "disable").await.unwrap();
        assert!(!snapshot.success);
        assert_eq!(snapshot.message.as_deref(), Some(ERR_CLIENT_SYNC));
        assert_eq!(snapshot.clients.len(), 1);
        assert!(snapshot.clients[0].managed);
        let rendered = serialized(&snapshot);
        for secret in ["$SECRET", "configPath", "LEAK", "\"config\""] {
            assert!(!rendered.contains(secret), "leaked {secret}");
        }
        let requests = mock.finish().await;
        assert_eq!(requests.len(), 2);
        assert!(requests[0].starts_with("POST /api/clients/pi/disable "));
        assert!(requests[1].starts_with("GET /api/clients "));
    }

    #[tokio::test]
    async fn clients_update_refresh_failure_falls_back_and_reports() {
        let mutation = json!({
            "success": true,
            "result": {"id": "codex", "action": "restore", "success": true},
            "clients": [
                {"id": "codex", "name": "Codex", "enabled": false, "managed": false, "exists": true}
            ]
        });
        let mock = Mock::new(vec![response(mutation), (500, "LEAK_SECRET".into())]);
        let service = ControlService::new(Some(mock.client()));
        let snapshot = service.clients_update("codex", "restore").await.unwrap();
        assert!(!snapshot.success);
        assert_eq!(snapshot.message.as_deref(), Some(ERR_CLIENT_REFRESH));
        assert_eq!(snapshot.clients.len(), 1);
        assert!(!snapshot.clients[0].enabled);
        assert_eq!(mock.finish().await.len(), 2);
    }

    #[tokio::test]
    async fn clients_update_transport_failure_is_safe() {
        let mock = Mock::new(vec![(401, "LEAK_SECRET".into())]);
        let service = ControlService::new(Some(mock.client()));
        let error = service.clients_update("pi", "enable").await.unwrap_err();
        assert!(!error.contains("LEAK_SECRET"));
        assert_eq!(mock.finish().await.len(), 1);
    }

    #[tokio::test]
    async fn offline_service_reports_fixed_safe_errors() {
        let service = ControlService::new(None);
        assert_eq!(service.routing_snapshot().await.unwrap_err(), ERR_OFFLINE);
        assert_eq!(
            service.usage_snapshot("today").await.unwrap_err(),
            ERR_OFFLINE
        );
        assert_eq!(
            service
                .usage_records("today", None, None)
                .await
                .unwrap_err(),
            ERR_OFFLINE
        );
        assert!(!service.clients_snapshot().await.success);
    }

    #[test]
    fn encode_query_percent_encodes_dates() {
        assert_eq!(
            encode_query("2026-11-17T00:00:00Z"),
            "2026-11-17T00%3A00%3A00Z"
        );
    }
}
