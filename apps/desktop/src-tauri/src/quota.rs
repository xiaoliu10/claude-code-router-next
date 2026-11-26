//! Read-only quota projection. Config and upstream payloads never cross the IPC boundary.
pub(crate) mod codex_reset;
mod step_plan;
use crate::api::{admin_auth_failed, AdminClient};
use reqwest::Method;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{hash_map::RandomState, HashMap, HashSet},
    hash::BuildHasher,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use step_plan::StepPlan;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use tokio::{sync::Mutex, task::JoinSet};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    label: String,
    used: Option<f64>,
    limit: Option<f64>,
    remaining: Option<f64>,
    unit: Option<String>,
    reset_at: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderQuota {
    pub name: String,
    enabled: bool,
    codex_reset_eligible: bool,
    plan: Option<String>,
    status: QuotaStatus,
    message: Option<String>,
    windows: Vec<QuotaWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    step_plan: Option<StepPlan>,
    updated_at: Option<u64>,
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum QuotaStatus {
    Ready,
    Unavailable,
    Reauth,
    Cooling,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaSnapshot {
    providers: Vec<ProviderQuota>,
    updated_at: u64,
    online: bool,
    error: Option<String>,
}
#[derive(Clone, Copy, Debug)]
pub(crate) enum SourceError {
    Unavailable,
    Reauth,
    Cooling,
}
#[derive(Clone, Copy, Debug, PartialEq)]
enum Adapter {
    Aggregate,
    Codex,
    Kiro,
    Gemini,
    Workbuddy,
    WorkbuddyAi,
}
#[derive(Clone)]
struct ConfiguredProvider {
    row: ProviderQuota,
    adapter: Adapter,
    coding_plan: bool,
    local_limits: [bool; 3],
    step_plan_fingerprint: u64,
}

const CODEX_PROVIDER: &str = "codex-subscription";
const REFRESH_THROTTLE_MS: u64 = 3_000;
// Managed-card reads can reuse a Step Plan observation for at most the gateway's stale window.
const STEP_PLAN_REUSE_MAX_AGE: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Copy)]
struct StepPlanIdentity {
    fingerprint: u64,
    cached_at: Instant,
}

struct QuotaCache {
    snapshot: QuotaSnapshot,
    attempts: HashMap<Option<String>, u64>,
    step_plan_identities: HashMap<String, StepPlanIdentity>,
}

pub struct QuotaService {
    client: Option<AdminClient>,
    // A per-service key lets us compare raw config without retaining credentials or endpoints.
    step_plan_hasher: RandomState,
    // Holding this lock through refresh gives all callers one shared in-flight refresh.
    cache: Mutex<QuotaCache>,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn text(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.len() <= 256 && !s.chars().any(char::is_control))
        .map(str::to_owned)
}
fn number(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite() && *n >= 0.0)
}
fn reset(value: &Value) -> Option<String> {
    let date = if let Some(raw) = value.as_str() {
        OffsetDateTime::parse(raw, &Rfc3339).ok()?
    } else {
        let ms = value.as_i64()?;
        OffsetDateTime::from_unix_timestamp_nanos(ms as i128 * 1_000_000).ok()?
    };
    date.format(&Rfc3339).ok()
}
fn live(value: &Value) -> bool {
    if value.is_null() {
        return true;
    }
    reset(value)
        .and_then(|s| OffsetDateTime::parse(&s, &Rfc3339).ok())
        .is_some_and(|date| date.unix_timestamp_nanos() > now() as i128 * 1_000_000)
}
fn configured(config: &Value, step_plan_hasher: &RandomState) -> Vec<ConfiguredProvider> {
    let mut seen = HashSet::new();
    let entries = config[crate::api::provider_list_key(config)]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let unique_codex = entries
        .iter()
        .filter(|p| p["name"] == CODEX_PROVIDER)
        .count()
        == 1;
    entries
        .iter()
        .filter_map(|entry| {
            let name = text(&entry["name"])?;
            if name.contains(',') || name.trim() != name || !seen.insert(name.clone()) {
                return None;
            }
            let credential = entry["api_key"]
                .as_str()
                .or_else(|| entry["apiKey"].as_str());
            let endpoint = entry["api_base_url"].as_str();
            let enabled = entry["enabled"] != false;
            let key = credential.unwrap_or("");
            let flag = |a: &str, b: &str| entry[a] == true || entry[b] == true;
            let adapter = match name.as_str() {
                CODEX_PROVIDER
                    if flag("codex_managed", "codexManaged") || key == "ccr-managed-codex" =>
                {
                    Adapter::Codex
                }
                "kiro-subscription"
                    if flag("kiro_managed", "kiroManaged") || key == "ccr-managed-kiro" =>
                {
                    Adapter::Kiro
                }
                "gemini-oauth"
                    if flag("gemini_oauth_managed", "geminiOauthManaged")
                        || key == "ccr-managed-gemini-oauth" =>
                {
                    Adapter::Gemini
                }
                "workbuddy" if entry["ccr_managed"] == true || key == "ccr-managed-workbuddy" => {
                    Adapter::Workbuddy
                }
                "workbuddy-ai"
                    if entry["ccr_managed"] == true || key == "ccr-managed-workbuddy-ai" =>
                {
                    Adapter::WorkbuddyAi
                }
                _ => Adapter::Aggregate,
            };
            Some(ConfiguredProvider {
                row: ProviderQuota {
                    name,
                    enabled,
                    codex_reset_eligible: unique_codex
                        && adapter == Adapter::Codex
                        && matches!(entry.get("enabled"), None | Some(Value::Bool(true))),
                    plan: None,
                    status: QuotaStatus::Unavailable,
                    message: None,
                    windows: vec![],
                    step_plan: None,
                    updated_at: None,
                },
                adapter,
                coding_plan: crate::credentials::coding_plan_provider(entry),
                local_limits: [
                    !entry["quota"]["limit5h"].is_null(),
                    !entry["quota"]["limit7d"].is_null(),
                    !entry["quota"]["limit30d"].is_null(),
                ],
                step_plan_fingerprint: step_plan_hasher.hash_one((credential, endpoint, enabled)),
            })
        })
        .collect()
}
impl QuotaCache {
    fn throttled(&self, provider: &Option<String>, stamp: u64) -> bool {
        self.attempts
            .get(provider)
            .is_some_and(|at| stamp.saturating_sub(*at) < REFRESH_THROTTLE_MS)
    }

    fn invalidate_step_plans(&mut self, rows: &[ConfiguredProvider], stamp: u64) {
        self.snapshot.providers.retain_mut(|row| {
            if row.step_plan.is_none() {
                return true;
            }
            let current = rows.iter().find(|entry| entry.row.name == row.name);
            if current.is_some_and(|entry| {
                self.step_plan_identities.get(&row.name).is_some_and(|old| {
                    old.fingerprint == entry.step_plan_fingerprint
                        && old.cached_at.elapsed() < STEP_PLAN_REUSE_MAX_AGE
                })
            }) {
                return true;
            }
            self.step_plan_identities.remove(&row.name);
            self.attempts.remove(&Some(row.name.clone()));
            self.attempts.remove(&None);
            self.snapshot.updated_at = stamp;
            if let Some(entry) = current {
                *row = entry.row.clone();
                true
            } else {
                false
            }
        });
    }
}

impl QuotaService {
    pub fn new(client: Option<AdminClient>) -> Self {
        Self {
            client,
            step_plan_hasher: RandomState::new(),
            cache: Mutex::new(QuotaCache {
                snapshot: QuotaSnapshot {
                    providers: vec![],
                    updated_at: now(),
                    online: false,
                    error: None,
                },
                attempts: HashMap::new(),
                step_plan_identities: HashMap::new(),
            }),
        }
    }
    pub async fn snapshot(&self, provider: Option<String>) -> Result<QuotaSnapshot, String> {
        let mut cache = self.cache.lock().await;
        let stamp = now();
        // A throttled response may include Step Plan data for a different row than requested.
        if cache.step_plan_identities.is_empty() && cache.throttled(&provider, stamp) {
            return Ok(cache.snapshot.clone());
        }
        let config = match &self.client {
            Some(client) => match client.config().await {
                Ok(config) => Some(config),
                Err(error) if admin_auth_failed(&error) => {
                    cache.snapshot.providers.clear();
                    cache.step_plan_identities.clear();
                    cache.attempts.clear();
                    cache.snapshot.online = false;
                    cache.snapshot.error = Some("本地 CCR 认证失败，请检查连接凭证".into());
                    return Ok(cache.snapshot.clone());
                }
                Err(_) => None,
            },
            None => None,
        };
        let Some(config) = config else {
            cache.attempts.insert(provider.clone(), now());
            cache.snapshot.online = false;
            cache.snapshot.error = Some("无法连接本地 CCR，显示上次已知数据（可能过期）".into());
            cache.step_plan_identities.clear();
            for row in &mut cache.snapshot.providers {
                row.codex_reset_eligible = false;
                if row.step_plan.is_some() {
                    *row = project_step_plan(row.clone(), &Value::Null);
                }
            }
            return Ok(cache.snapshot.clone());
        };
        let rows = configured(&config, &self.step_plan_hasher);
        drop(config);
        cache.invalidate_step_plans(&rows, stamp);
        // Even a throttled result must reflect any freshly observed loss of eligibility.
        for row in &mut cache.snapshot.providers {
            if row.codex_reset_eligible {
                row.codex_reset_eligible = rows.iter().any(|r| r.row.codex_reset_eligible);
            }
        }
        if provider
            .as_ref()
            .is_some_and(|name| !rows.iter().any(|r| &r.row.name == name))
        {
            cache.attempts.remove(&provider);
            return Err("Provider is no longer configured".into());
        }
        if cache.throttled(&provider, stamp) {
            return Ok(cache.snapshot.clone());
        }
        let client = self.client.as_ref().expect("config requires client");
        let chosen: Vec<_> = rows
            .iter()
            .filter(|r| provider.as_ref().is_none_or(|name| &r.row.name == name))
            .cloned()
            .collect();
        let aggregate = if chosen.iter().any(|r| r.adapter == Adapter::Aggregate) {
            Some(
                client
                    .quota_json(Method::GET, "/api/providers/quota", None)
                    .await,
            )
        } else {
            None
        };
        let mut refreshed = Vec::new();
        // At most four adapters concurrently; each adapter uses at most two 5s requests.
        for batch in chosen.chunks(4) {
            let mut tasks = JoinSet::new();
            for entry in batch {
                let entry = entry.clone();
                let client = client.clone();
                let aggregate = aggregate.clone();
                tasks.spawn(async move { refresh(&client, entry, aggregate.as_ref()).await });
            }
            while let Some(result) = tasks.join_next().await {
                if let Ok(row) = result {
                    refreshed.push(row);
                }
            }
        }
        cache.invalidate_step_plans(&rows, stamp);
        let mut step_plan_identities = HashMap::new();
        let providers = rows
            .into_iter()
            .map(|entry| {
                let previous = cache
                    .snapshot
                    .providers
                    .iter()
                    .find(|r| r.name == entry.row.name);
                let row = if let Some(row) = refreshed.iter().find(|r| r.name == entry.row.name) {
                    preserve_stale(row.clone(), previous)
                } else if let Some(result) = aggregate
                    .as_ref()
                    .filter(|_| entry.adapter == Adapter::Aggregate)
                {
                    // A per-card aggregate read can also revoke another Step Plan account.
                    let plan = result
                        .as_ref()
                        .ok()
                        .and_then(|v| aggregate_row(v, &entry.row.name))
                        .and_then(|q| q.get("stepPlan"));
                    if let Some(plan) = plan.filter(|_| entry.row.enabled) {
                        project_step_plan(entry.row, plan)
                    } else if previous.is_some_and(|p| p.step_plan.is_some()) {
                        entry.row
                    } else {
                        reuse_row(entry.row, previous)
                    }
                } else {
                    if let Some(identity) = cache.step_plan_identities.get(&entry.row.name) {
                        step_plan_identities.insert(entry.row.name.clone(), *identity);
                    }
                    return reuse_row(entry.row, previous);
                };
                if row.step_plan.is_some() {
                    step_plan_identities.insert(
                        row.name.clone(),
                        StepPlanIdentity {
                            fingerprint: entry.step_plan_fingerprint,
                            cached_at: Instant::now(),
                        },
                    );
                }
                row
            })
            .collect();
        let completed = now();
        cache.attempts.insert(provider.clone(), completed);
        if provider.is_none() {
            for row in &refreshed {
                cache.attempts.insert(Some(row.name.clone()), completed);
            }
        }
        cache.step_plan_identities = step_plan_identities;
        cache.snapshot = QuotaSnapshot {
            providers,
            updated_at: stamp,
            online: true,
            error: None,
        };
        Ok(cache.snapshot.clone())
    }
}
fn reuse_row(configured: ProviderQuota, previous: Option<&ProviderQuota>) -> ProviderQuota {
    match previous {
        Some(previous) => ProviderQuota {
            enabled: configured.enabled,
            codex_reset_eligible: configured.codex_reset_eligible,
            ..previous.clone()
        },
        None => configured,
    }
}
fn preserve_stale(mut row: ProviderQuota, previous: Option<&ProviderQuota>) -> ProviderQuota {
    // The gateway owns Step Plan staleness and credential invalidation. Never merge account samples.
    if row.step_plan.is_some() || previous.is_some_and(|old| old.step_plan.is_some()) {
        return row;
    }
    if matches!(
        row.status,
        QuotaStatus::Unavailable | QuotaStatus::Reauth | QuotaStatus::Cooling
    ) {
        if let Some(previous) = previous.filter(|r| !r.windows.is_empty()) {
            row.windows = previous.windows.clone();
            row.updated_at = previous.updated_at;
            if row.plan.is_none() {
                row.plan = previous.plan.clone();
            }
            row.message = Some("刷新失败，显示上次已知数据（可能过期）".into());
        }
    }
    row
}
fn aggregate_row<'a>(value: &'a Value, provider: &str) -> Option<&'a Value> {
    value["quotas"]
        .as_array()?
        .iter()
        .find(|q| q["provider"].as_str() == Some(provider))
}
fn project_step_plan(mut row: ProviderQuota, raw: &Value) -> ProviderQuota {
    let plan = StepPlan::project(raw);
    row.updated_at = plan.observed_at;
    row.status = if plan.state == "unavailable" {
        QuotaStatus::Unavailable
    } else {
        QuotaStatus::Ready
    };
    row.step_plan = Some(plan);
    row
}
async fn refresh(
    client: &AdminClient,
    entry: ConfiguredProvider,
    aggregate: Option<&Result<Value, SourceError>>,
) -> ProviderQuota {
    let mut row = entry.row.clone();
    if entry.adapter == Adapter::Aggregate {
        match aggregate {
            Some(Ok(value)) if value["quotas"].is_array() => {
                if let Some(quota) = aggregate_row(value, &row.name) {
                    if let Some(raw) = quota.get("stepPlan") {
                        if row.enabled {
                            return project_step_plan(row, raw);
                        }
                    } else {
                        row.windows =
                            project_aggregate_windows(quota, entry.local_limits, entry.coding_plan);
                    }
                }
                let has_data = row.windows.iter().any(|window| window.limit.is_some());
                row.status = if has_data {
                    QuotaStatus::Ready
                } else {
                    QuotaStatus::Unavailable
                };
                row.message = Some(
                    if !has_data {
                        "未提供可用额度数据（来源未声明查询能力）"
                    } else {
                        "服务端聚合统计，可能包含本地用量；读取时间不代表上游采样时间。单卡刷新仍读取聚合缓存"
                    }
                    .into(),
                );
            }
            _ => fail(&mut row, SourceError::Unavailable),
        }
    } else {
        let (status_path, usage_path, method, body) = match entry.adapter {
            Adapter::Codex => (
                "/api/codex/status",
                "/api/codex/usage",
                Method::POST,
                Some(json!({})),
            ),
            Adapter::Kiro => (
                "/api/kiro/status",
                "/api/kiro/usage",
                Method::POST,
                Some(json!({})),
            ),
            Adapter::Gemini => (
                "/api/gemini-oauth/status",
                "/api/gemini-oauth/quota",
                Method::GET,
                None,
            ),
            Adapter::Workbuddy => (
                "/api/workbuddy/status?site=workbuddy",
                "/api/workbuddy/usage",
                Method::POST,
                Some(json!({"site":"workbuddy"})),
            ),
            Adapter::WorkbuddyAi => (
                "/api/workbuddy/status?site=workbuddy-ai",
                "/api/workbuddy/usage",
                Method::POST,
                Some(json!({"site":"workbuddy-ai"})),
            ),
            Adapter::Aggregate => unreachable!(),
        };
        let (status, usage) = tokio::join!(
            client.quota_json(Method::GET, status_path, None),
            client.quota_json(method, usage_path, body.as_ref())
        );
        match usage {
            Ok(value) => {
                row.windows = adapter_windows(entry.adapter, &value);
                row.plan = text(&value["plan"]).or_else(|| text(&value["usage"]["plan"]));
                row.status = if row.windows.is_empty() {
                    QuotaStatus::Unavailable
                } else {
                    QuotaStatus::Ready
                };
                if entry.adapter == Adapter::Kiro && value["stale"] == true {
                    row.status = QuotaStatus::Unavailable;
                    row.message = Some("来源报告数据已过期".into());
                }
            }
            Err(error) => fail(&mut row, error),
        }
        if status.is_err() && row.status == QuotaStatus::Ready {
            row.message = Some("额度已读取；账号状态暂不可用".into());
        }
        if let Ok(status) = status {
            row.plan = row
                .plan
                .or_else(|| text(&status["plan"]))
                .or_else(|| text(&status["tier"]));
            apply_status(&mut row, &status);
        }
    }
    if row.status == QuotaStatus::Ready {
        row.updated_at = Some(now());
    }
    if row.message.is_none() && row.status == QuotaStatus::Unavailable {
        row.message = Some("未提供可用额度数据".into());
    }
    row
}
fn fail(row: &mut ProviderQuota, error: SourceError) {
    let (status, message) = match error {
        SourceError::Unavailable => (QuotaStatus::Unavailable, "配额暂不可用"),
        SourceError::Reauth => (QuotaStatus::Reauth, "请在 CCR UI 重新授权"),
        SourceError::Cooling => (QuotaStatus::Cooling, "账号冷却中"),
    };
    row.status = status;
    row.message = Some(message.into());
}
fn apply_status(row: &mut ProviderQuota, status: &Value) {
    let code = status["lastErrorCode"]
        .as_str()
        .or_else(|| status["lastError"]["code"].as_str())
        .unwrap_or("");
    let accounts = status["accounts"].as_array();
    if matches!(
        code,
        "codex_reauth_required" | "gemini_oauth_reauth_required"
    ) || status["status"] == "expired"
        || accounts.is_some_and(|a| !a.is_empty() && a.iter().all(|a| a["needReauth"] == true))
    {
        fail(row, SourceError::Reauth);
    } else if number(&status["coolingUntil"])
        .or_else(|| number(&status["cooldownUntil"]))
        .is_some_and(|until| until > now() as f64)
        || accounts.is_some_and(|a| {
            !a.is_empty()
                && a.iter()
                    .all(|a| number(&a["coolingUntil"]).is_some_and(|until| until > now() as f64))
        })
    {
        fail(row, SourceError::Cooling);
    } else if status["connected"] == false
        || matches!(
            status["status"].as_str(),
            Some("not_connected" | "disconnected")
        )
    {
        fail(row, SourceError::Unavailable);
    }
}
fn measured(
    label: String,
    used: Option<f64>,
    limit: f64,
    unit: Option<String>,
    reset_at: Option<String>,
) -> QuotaWindow {
    QuotaWindow {
        label,
        used,
        limit: Some(limit),
        remaining: used.map(|u| (limit - u).max(0.0)),
        unit,
        reset_at,
    }
}
pub(crate) fn step_plan_tray_lines(value: &Value) -> Vec<String> {
    StepPlan::project(value).tray_lines()
}

#[cfg(test)]
fn aggregate_windows(value: &Value, local_limits: [bool; 3]) -> Vec<QuotaWindow> {
    project_aggregate_windows(value, local_limits, false)
}

fn project_aggregate_windows(
    value: &Value,
    local_limits: [bool; 3],
    coding_plan: bool,
) -> Vec<QuotaWindow> {
    let ark_periods = coding_plan
        && ["type5h", "type7d", "type30d"]
            .iter()
            .any(|k| value[*k] == "rateLimit");
    ["5h", "7d", "30d"]
        .into_iter()
        .enumerate()
        .filter_map(|(index, slot)| {
            let kind = value[format!("type{slot}")].as_str();
            let period = ["5 小时", "7 天", "30 天"][index];
            let limit = number(&value[format!("limit{slot}")]).filter(|n| *n > 0.0);
            let raw_reset = &value[format!("reset{slot}")];
            if ark_periods
                && kind != Some("balance")
                && (kind != Some("rateLimit") || limit.is_none() || !live(raw_reset))
            {
                return Some(QuotaWindow {
                    label: period.into(),
                    used: None,
                    remaining: None,
                    limit: None,
                    unit: None,
                    reset_at: None,
                });
            }
            let limit = limit?;
            if local_limits[index] && kind.is_none() {
                return None;
            }
            if !live(raw_reset) {
                return None;
            }
            let unit = value["currency"]
                .as_str()
                .filter(|s| s.len() == 3 && s.bytes().all(|c| c.is_ascii_uppercase()))
                .map(str::to_owned);
            // Balance-only sources may synthesize used=0. Preserve the total without
            // claiming that a full balance is available. Other finite usage is the
            // existing aggregate contract, explicitly marked as such in the card.
            let used = number(&value[format!("used{slot}")]);
            let used = if kind == Some("balance") && used == Some(0.0) {
                None
            } else {
                used
            };
            let label = if kind == Some("balance") {
                "余额"
            } else if kind.is_none() {
                // Untyped samples include generic x-ratelimit-* merges with no
                // real window duration — keep the generic label.
                "配额"
            } else {
                period
            };
            Some(measured(label.into(), used, limit, unit, reset(raw_reset)))
        })
        .collect()
}
fn adapter_windows(adapter: Adapter, value: &Value) -> Vec<QuotaWindow> {
    match adapter {
        Adapter::Codex => ["primary", "secondary"]
            .into_iter()
            .filter_map(|key| {
                let v = &value[key];
                let used = number(&v["usedPercent"])?;
                if used > 100.0 || !live(&v["resetAt"]) {
                    return None;
                }
                let label = match number(&v["windowSeconds"]) {
                    Some(18000.0) => "5 小时",
                    Some(604800.0) => "7 天",
                    _ => "配额",
                };
                Some(measured(
                    label.into(),
                    Some(used),
                    100.0,
                    Some("%".into()),
                    reset(&v["resetAt"]),
                ))
            })
            .collect(),
        Adapter::Kiro => value["windows"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| {
                let limit = number(&v["limit"]).filter(|n| *n > 0.0)?;
                if !live(&v["resetsAt"]) || !live(&v["expiresAt"]) {
                    return None;
                }
                Some(measured(
                    text(&v["name"]).unwrap_or("配额".into()),
                    number(&v["amount"]),
                    limit,
                    text(&v["unit"]),
                    reset(&v["resetsAt"]),
                ))
            })
            .collect(),
        Adapter::Gemini => {
            let mut result = Vec::new();
            for v in value["pools"].as_array().into_iter().flatten() {
                let Some(pool) = text(&v["pool"]) else {
                    continue;
                };
                let label = text(&v["window"])
                    .map(|w| format!("{pool} · {w}"))
                    .unwrap_or(pool);
                if let Some(window) = gemini_window(label, v) {
                    result.push(window);
                }
            }
            if let Some(models) = value["models"].as_object() {
                for (id, v) in models {
                    if let Some(label) = text(&Value::String(id.clone())) {
                        if let Some(window) = gemini_window(label, v) {
                            result.push(window);
                        }
                    }
                }
            }
            result
        }
        Adapter::Workbuddy | Adapter::WorkbuddyAi => {
            let v = &value["usage"];
            number(&v["limit"])
                .filter(|n| *n > 0.0)
                .map(|limit| {
                    vec![measured(
                        "配额".into(),
                        number(&v["used"]),
                        limit,
                        text(&v["unit"]),
                        None,
                    )]
                })
                .unwrap_or_default()
        }
        Adapter::Aggregate => vec![],
    }
}
fn gemini_window(label: String, value: &Value) -> Option<QuotaWindow> {
    let remaining = number(&value["remaining"]).filter(|n| *n <= 1.0)?;
    if !live(&value["resetAt"]) {
        return None;
    }
    Some(QuotaWindow {
        label,
        used: Some((1.0 - remaining) * 100.0),
        limit: Some(100.0),
        remaining: Some(remaining * 100.0),
        unit: Some("%".into()),
        reset_at: reset(&value["resetAt"]),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn configured_rows(config: &Value) -> Vec<ConfiguredProvider> {
        configured(config, &RandomState::new())
    }

    struct Mock {
        client: AdminClient,
        requests: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
        worker: std::thread::JoinHandle<()>,
    }
    impl Mock {
        fn new(config: Value, responses: Vec<(String, u16, Value)>) -> Self {
            use std::io::{Read, Write};
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let client = AdminClient::new(crate::settings::ConnectionSettings {
                base_url: format!("http://{}", listener.local_addr().unwrap()),
                api_key: Some("PRIVATE_ADMIN".into()),
            })
            .unwrap();
            let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let recorded = requests.clone();
            let worker = std::thread::spawn(move || {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
                while std::time::Instant::now() < deadline {
                    let (mut stream, _) = match listener.accept() {
                        Ok(socket) => socket,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(std::time::Duration::from_millis(2));
                            continue;
                        }
                        Err(error) => panic!("{error}"),
                    };
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                        .unwrap();
                    let mut bytes = Vec::new();
                    loop {
                        let mut chunk = [0; 4096];
                        let count = stream.read(&mut chunk).unwrap();
                        if count == 0 {
                            break;
                        }
                        bytes.extend_from_slice(&chunk[..count]);
                        if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                            let headers = String::from_utf8_lossy(&bytes[..end]);
                            let size = headers
                                .lines()
                                .find_map(|l| {
                                    l.to_ascii_lowercase()
                                        .strip_prefix("content-length:")
                                        .map(|s| s.trim().parse::<usize>().unwrap())
                                })
                                .unwrap_or(0);
                            if bytes.len() >= end + 4 + size {
                                break;
                            }
                        }
                    }
                    let request = String::from_utf8(bytes).unwrap();
                    let line = request.lines().next().unwrap().to_owned();
                    if line == "GET /done HTTP/1.1" {
                        break;
                    }
                    recorded.lock().unwrap().push(request);
                    let (status, value) = if line == "GET /api/config HTTP/1.1" {
                        (200, config.clone())
                    } else {
                        responses
                            .iter()
                            .find(|r| line == r.0)
                            .map(|r| (r.1, r.2.clone()))
                            .unwrap_or((500, json!({"error":"RAW_SECRET"})))
                    };
                    let body = value.to_string();
                    write!(stream,"HTTP/1.1 {status} Mock\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
                }
            });
            Self {
                client,
                requests,
                worker,
            }
        }
        async fn finish(self) -> Vec<String> {
            let _ = self.client.quota_json(Method::GET, "/done", None).await;
            self.worker.join().unwrap();
            self.requests.lock().unwrap().clone()
        }
    }
    #[tokio::test]
    async fn single_card_refresh_is_scoped_merged_cached_and_read_only() {
        let mock = Mock::new(
            json!({"Providers":[{"name":"codex-subscription","codex_managed":true,"api_key":"SECRET"},{"name":"disabled","enabled":false}]}),
            vec![
                (
                    "GET /api/codex/status HTTP/1.1".into(),
                    200,
                    json!({"status":"connected","plan":"plus"}),
                ),
                (
                    "POST /api/codex/usage HTTP/1.1".into(),
                    200,
                    json!({"plan":"plus","primary":{"usedPercent":25,"windowSeconds":18000,"resetAt":4102444800000_i64}}),
                ),
            ],
        );
        let service = QuotaService::new(Some(mock.client.clone()));
        let snapshot = service
            .snapshot(Some("codex-subscription".into()))
            .await
            .unwrap();
        assert_eq!(snapshot.providers.len(), 2);
        assert!(!snapshot.providers[1].enabled);
        assert_eq!(snapshot.providers[0].windows[0].remaining, Some(75.0));
        service
            .snapshot(Some("codex-subscription".into()))
            .await
            .unwrap();
        let requests = mock.finish().await;
        assert_eq!(requests.len(), 3);
        assert!(requests.iter().all(|r| !r.contains("/api/providers/quota")
            && !r.contains("/sync")
            && !r.contains("/login")
            && !r.starts_with("POST /api/config")));
        let encoded = serde_json::to_string(&snapshot).unwrap();
        assert!(!encoded.contains("SECRET"));
        assert!(!encoded.contains("PRIVATE_ADMIN"));
    }
    #[tokio::test]
    async fn partial_network_failure_and_offline_keep_last_snapshot() {
        let mock = Mock::new(
            json!({"Providers":[{"name":"good"},{"name":"kiro-subscription","kiro_managed":true}]}),
            vec![
                (
                    "GET /api/providers/quota HTTP/1.1".into(),
                    200,
                    json!({"quotas":[{"provider":"good","used5h":40,"limit5h":100,"type5h":"rateLimit"}]}),
                ),
                (
                    "GET /api/kiro/status HTTP/1.1".into(),
                    503,
                    json!({"error":"RAW_SECRET"}),
                ),
                (
                    "POST /api/kiro/usage HTTP/1.1".into(),
                    502,
                    json!({"error":"RAW_SECRET"}),
                ),
            ],
        );
        let service = QuotaService::new(Some(mock.client.clone()));
        let snapshot = service.snapshot(None).await.unwrap();
        assert!(snapshot.online);
        assert_eq!(snapshot.providers[0].status, QuotaStatus::Ready);
        assert_eq!(snapshot.providers[0].windows[0].used, Some(40.0));
        assert_eq!(snapshot.providers[1].status, QuotaStatus::Unavailable);
        assert!(!serde_json::to_string(&snapshot)
            .unwrap()
            .contains("RAW_SECRET"));
        mock.finish().await;
        service.cache.lock().await.attempts.clear();
        let stale = service.snapshot(None).await.unwrap();
        assert!(!stale.online);
        assert!(stale.error.is_some());
        assert_eq!(stale.providers[0].windows[0].used, Some(40.0));
        assert_eq!(stale.updated_at, snapshot.updated_at);
    }
    #[tokio::test]
    async fn ark_snapshot_preserves_all_three_named_periods_in_order() {
        let config = json!({"Providers":[{"name":"custom-plan", "api_base_url":"https://ark.cn-beijing.volces.com/api/coding/v3"}]});
        let balance = json!({"type7d":"balance","limit7d":25,"used7d":0,"currency":"USD"});
        let ws = project_aggregate_windows(&balance, [false; 3], true);
        assert_eq!(
            (
                ws[0].label.as_str(),
                ws[0].limit,
                ws[0].remaining,
                ws[0].unit.as_deref()
            ),
            ("余额", Some(25.0), None, Some("USD"))
        );
        for (extra, expected) in [
            (
                json!({"type5h":"rateLimit","limit5h":100,"used5h":0,"type7d":"rateLimit","limit7d":100,"used7d":12}),
                [Some(0.0), Some(12.0), Some(32.0)],
            ),
            (
                json!({"used5h":999,"limit5h":100,"type7d":"rateLimit","limit7d":100,"used7d":12,"reset7d":"2000-01-01T00:00:00Z"}),
                [None, None, Some(32.0)],
            ),
        ] {
            let mut row =
                json!({"provider":"custom-plan","type30d":"rateLimit","limit30d":100,"used30d":32});
            row.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            let mock = Mock::new(
                config.clone(),
                vec![(
                    "GET /api/providers/quota HTTP/1.1".into(),
                    200,
                    json!({"quotas":[row]}),
                )],
            );
            let snapshot = QuotaService::new(Some(mock.client.clone()))
                .snapshot(None)
                .await
                .unwrap();
            let ws = &snapshot.providers[0].windows;
            assert_eq!(
                ws.iter().map(|w| w.label.as_str()).collect::<Vec<_>>(),
                ["5 小时", "7 天", "30 天"]
            );
            assert_eq!(ws.iter().map(|w| w.used).collect::<Vec<_>>(), expected);
            mock.finish().await;
        }
    }

    #[tokio::test]
    async fn step_plan_replaces_accounts_and_clears_on_auth_failure() {
        use crate::api::mock::{response, Mock as Sequence};
        let config = response(json!({"Providers":[{"name":"step"},{"name":"other"}]}));
        let exact = "9007199254740993.0100";
        let token = json!({"state":"partial","family":"token","name":"Plus","observedAt":123,"allowed":true,
        "account":{"id":"SECRET"},"creditBuckets":[
            {"type":"subscription","total":exact,"remaining":"0","usedPercent":100,"expiresAt":456,"id":"SECRET"},
            {"type":"topup","total":"3.00","remaining":"1.21","resetsAt":456,"expiresAt":678},
            {"type":"topup","total":"2","remaining":"2","usedPercent":0,"expiresAt":789},
            {"type":"topup","total":"SECRET","remaining":"9"}
        ]});
        let mut unavailable = token.clone();
        unavailable["state"] = json!("unavailable");
        let aggregate = |plan| {
            response(
                json!({"quotas":[{"provider":"step","stepPlan":plan,"used5h":5,"limit5h":10}]}),
            )
        };
        let mock = Sequence::new(vec![
            config.clone(),
            aggregate(token.clone()),
            config.clone(),
            aggregate(unavailable),
            config.clone(),
            aggregate(token),
            (403, "SECRET".into()),
        ]);
        let service = QuotaService::new(Some(mock.client()));
        let first = service.snapshot(None).await.unwrap();
        let row = serde_json::to_value(&first.providers[0]).unwrap();
        assert_eq!(row["windows"], json!([]));
        assert_eq!(row["updatedAt"], 123);
        let buckets = row["stepPlan"]["creditBuckets"].as_array().unwrap();
        assert_eq!(buckets.len(), 3);
        assert_eq!(buckets[0]["total"], exact);
        assert_eq!(buckets[1]["usedPercent"], Value::Null);
        assert_eq!(buckets[2]["expiresAt"], 789);
        assert!(!row.to_string().contains("SECRET"));
        service.cache.lock().await.attempts.clear();
        let cleared = service.snapshot(Some("other".into())).await.unwrap();
        let plan = serde_json::to_value(&cleared.providers[0]).unwrap();
        assert_eq!(
            plan["stepPlan"],
            json!({"state":"unavailable","family":"none","name":null,"allowed":null,"observedAt":null,"creditBuckets":[],"windows":[]})
        );
        service.cache.lock().await.attempts.clear();
        assert_eq!(
            service.snapshot(None).await.unwrap().providers[0].status,
            QuotaStatus::Ready
        );
        service.cache.lock().await.attempts.clear();
        let rejected = service.snapshot(None).await.unwrap();
        assert!(rejected.providers.is_empty());
        assert!(!rejected.online);
        mock.finish().await;
    }
    #[tokio::test]
    async fn managed_refresh_drops_step_plan_after_key_replacement() {
        use crate::api::mock::{response, Mock as Sequence};

        let config = |key| {
            response(json!({"Providers":[
                {"name":"step","api_key":key,"api_base_url":"https://api.stepfun.com/v1"},
                {"name":"codex-subscription","codex_managed":true}
            ]}))
        };
        let plan = response(json!({"quotas":[{"provider":"step","stepPlan":{
            "state":"known","family":"token","observedAt":123,
            "creditBuckets":[{"type":"subscription","total":"20","remaining":"15"}]
        }}]}));
        let codex = json!({"status":"connected","plan":"plus",
            "primary":{"usedPercent":25,"windowSeconds":18000,"resetAt":4102444800000_i64}});
        let managed = Some("codex-subscription".to_owned());

        for throttled in [false, true] {
            let mut replies = vec![
                config("FIRST_KEY"),
                plan.clone(),
                config("FIRST_KEY"),
                response(codex.clone()),
                response(codex.clone()),
                config("SECOND_KEY"),
            ];
            if !throttled {
                replies.extend([response(codex.clone()), response(codex.clone())]);
            }
            let mock = Sequence::new(replies);
            let service = QuotaService::new(Some(mock.client()));
            service.snapshot(Some("step".into())).await.unwrap();
            let unchanged = service.snapshot(managed.clone()).await.unwrap();
            let old = serde_json::to_value(&unchanged.providers[0]).unwrap();
            assert_eq!(old["stepPlan"]["creditBuckets"][0]["remaining"], "15");
            assert_eq!(unchanged.providers[1].windows[0].remaining, Some(75.0));
            if !throttled {
                service.cache.lock().await.attempts.remove(&managed);
            }

            let changed = service.snapshot(managed.clone()).await.unwrap();
            assert_eq!(changed.providers[0].name, "step");
            assert_eq!(changed.providers[0].status, QuotaStatus::Unavailable);
            assert!(changed.providers[0].step_plan.is_none());
            assert!(changed.providers[0].updated_at.is_none());
            assert_eq!(changed.providers[1].windows[0].remaining, Some(75.0));
            let encoded = serde_json::to_string(&changed).unwrap();
            for private in ["FIRST_KEY", "SECOND_KEY", "api.stepfun.com", "fingerprint"] {
                assert!(!encoded.contains(private));
            }
            let requests = mock.finish().await;
            assert_eq!(
                requests
                    .iter()
                    .filter(|r| r.starts_with("GET /api/config "))
                    .count(),
                3
            );
            assert_eq!(
                requests
                    .iter()
                    .filter(|r| r.starts_with("GET /api/providers/quota "))
                    .count(),
                1
            );
            assert_eq!(
                requests
                    .iter()
                    .filter(|r| r.starts_with("POST /api/codex/usage "))
                    .count(),
                if throttled { 1 } else { 2 }
            );
        }
    }

    #[test]
    fn step_plan_identity_expires_and_rejects_endpoint_or_enabled_changes() {
        let make_config = |endpoint, enabled| json!({"Providers":[{"name":"step","api_key":"KEY","api_base_url":endpoint,"enabled":enabled}]});
        let hasher = RandomState::new();
        let initial = configured(&make_config("first", true), &hasher).remove(0);
        for (config, age) in [
            (make_config("second", true), Duration::ZERO),
            (make_config("first", false), Duration::ZERO),
            (make_config("first", true), STEP_PLAN_REUSE_MAX_AGE),
        ] {
            let mut cache = QuotaCache {
                snapshot: QuotaSnapshot {
                    providers: vec![project_step_plan(
                        initial.row.clone(),
                        &json!({"state":"known","family":"token","observedAt":123}),
                    )],
                    updated_at: 123,
                    online: true,
                    error: None,
                },
                attempts: [(None, 123), (Some("step".into()), 123)].into(),
                step_plan_identities: [(
                    "step".into(),
                    StepPlanIdentity {
                        fingerprint: initial.step_plan_fingerprint,
                        cached_at: Instant::now() - age,
                    },
                )]
                .into(),
            };
            cache.invalidate_step_plans(&configured(&config, &hasher), 456);
            assert!(cache.step_plan_identities.is_empty());
            assert!(cache.attempts.is_empty());
            assert!(cache.snapshot.providers[0].step_plan.is_none());
            assert_eq!(
                cache.snapshot.providers[0].enabled,
                config["Providers"][0]["enabled"] == true
            );
        }
    }

    #[test]
    fn all_configured_rows_in_order_without_models_or_enabled_filter() {
        let providers: Vec<_> = (0..25)
            .map(|i| json!({"name": format!("p{i}"), "enabled": i % 2 == 0}))
            .chain([
                json!({"name": ""}),
                json!({"name": "bad,name"}),
                json!({"name": 2}),
                json!({"name":"p1"}),
            ])
            .collect();
        let rows = configured_rows(&json!({"Providers": providers}));
        assert_eq!(rows.len(), 25);
        assert_eq!(rows[24].row.name, "p24");
        assert!(!rows[1].row.enabled);
    }
    #[test]
    fn local_counts_and_config_limits_are_not_upstream_available_quota() {
        assert!(aggregate_windows(&json!({"used5h": 800, "used7d": 1200}), [false; 3]).is_empty());
        assert!(
            aggregate_windows(&json!({"used5h": 0, "limit5h": 100}), [true, false, false])
                .is_empty()
        );
        let windows = aggregate_windows(
            &json!({"used7d": 0, "limit7d": 25, "type7d": "balance", "currency":"USD"}),
            [false; 3],
        );
        assert_eq!(windows[0].label, "余额");
        assert!(windows[0].used.is_none());
        assert!(windows[0].remaining.is_none());
        let rate = aggregate_windows(
            &json!({"used5h": 34, "limit5h": 100, "type5h":"rateLimit"}),
            [false; 3],
        );
        assert_eq!(rate[0].used, Some(34.0));
        assert_eq!(rate[0].remaining, Some(66.0));
        assert_eq!(rate[0].label, "5 小时");
        let untyped = aggregate_windows(&json!({"used5h": 34, "limit5h": 100}), [false; 3]);
        assert_eq!(untyped[0].label, "配额");
        let monthly = aggregate_windows(
            &json!({"used30d": 14.6, "limit30d": 100, "type30d":"rateLimit"}),
            [false; 3],
        );
        assert_eq!(monthly[0].label, "30 天");
        assert_eq!(monthly[0].limit, Some(100.0));
        assert_eq!(monthly[0].remaining, Some(85.4));
        assert!(
            adapter_windows(Adapter::Codex, &json!({"primary":{"windowSeconds":18000}})).is_empty()
        );
    }
    #[test]
    fn exact_plugin_fixtures_preserve_units_pools_and_plan_sources() {
        let codex = adapter_windows(
            Adapter::Codex,
            &json!({"plan":"plus", "primary":{"usedPercent":30,"windowSeconds":18000,"resetAt":4102444800000_i64},"secondary":{"usedPercent":40,"windowSeconds":604800,"resetAt":4102444800000_i64}}),
        );
        assert_eq!(codex[0].remaining, Some(70.0));
        assert_eq!(codex[1].label, "7 天");
        let kiro = adapter_windows(
            Adapter::Kiro,
            &json!({"known":true,"stale":false,"plan":"Pro","windows":[{"name":"Credits","used":25,"amount":50,"limit":200,"unit":"credits","resetsAt":"2100-01-01T00:00:00Z"}]}),
        );
        assert_eq!(kiro[0].used, Some(50.0));
        assert_eq!(kiro[0].remaining, Some(150.0));
        let gemini = adapter_windows(
            Adapter::Gemini,
            &json!({"pools":[{"pool":"Argon","window":"5h","remaining":0.2},{"pool":"Hydrogen","window":"weekly","remaining":0.8}],"models":{"claude-opus":{"remaining":0.4},"missing":{}}}),
        );
        assert_eq!(gemini.len(), 3);
        assert_eq!(gemini[0].remaining, Some(20.0));
        assert!(gemini[1].label.contains("Hydrogen"));
    }
    #[test]
    fn partial_error_preserves_previous_numbers_and_no_credentials_serialize() {
        let mut old = configured_rows(&json!({"Providers":[{"name":"one","api_key":"SECRET","api_base_url":"https://secret.invalid","quotaToken":"TOKEN"}]})).remove(0).row;
        old.windows = vec![measured("配额".into(), Some(5.0), 10.0, None, None)];
        old.updated_at = Some(123);
        let mut failed = old.clone();
        failed.windows.clear();
        fail(&mut failed, SourceError::Unavailable);
        let stale = preserve_stale(failed, Some(&old));
        assert_eq!(stale.windows[0].used, Some(5.0));
        assert_eq!(stale.updated_at, Some(123));
        let encoded = serde_json::to_string(&stale).unwrap();
        for forbidden in [
            "SECRET",
            "TOKEN",
            "secret.invalid",
            "api_key",
            "apiKey",
            "baseUrl",
        ] {
            assert!(!encoded.contains(forbidden));
        }
    }
    #[test]
    fn guards_status_and_malformed_numbers_without_echoing_errors() {
        let mut row = configured_rows(
            &json!({"Providers":[{"name":"codex-subscription","codex_managed":true}]}),
        )
        .remove(0)
        .row;
        apply_status(
            &mut row,
            &json!({"lastErrorCode":"codex_reauth_required","lastError":"SECRET"}),
        );
        assert_eq!(row.status, QuotaStatus::Reauth);
        assert!(!row.message.unwrap().contains("SECRET"));
        assert!(adapter_windows(
            Adapter::Gemini,
            &json!({"pools":[{"pool":"Argon","remaining":null},{"pool":"Other","remaining":2}]})
        )
        .is_empty());
        assert!(adapter_windows(Adapter::Kiro, &json!({"windows":[{"name":"old","amount":1,"limit":2,"resetsAt":"2000-01-01T00:00:00Z"}]})).is_empty());
    }
}
