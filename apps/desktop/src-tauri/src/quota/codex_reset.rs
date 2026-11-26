//! Explicit local-main-window actions. The plugin owns redemption and its idempotency key.
use super::{configured, QuotaService};
use crate::api::{admin_auth_failed, AdminClient};
use reqwest::Method;
use serde::Serialize;
use serde_json::{json, Value};
use std::{collections::HashSet, time::Duration};
use tauri::WebviewWindow;

const INVALID: &str = "codex_reset_invalid";
const UNAVAILABLE: &str = "codex_reset_unavailable";
const BUSY: &str = "codex_reset_busy";
const NO_CREDIT: &str = "codex_reset_no_credit";
const FAILED: &str = "codex_reset_failed";
const UNAUTHORIZED: &str = "codex_unauthorized";
const DISCONNECTED: &str = "codex_not_connected";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetCredits {
    available_count: u64,
    credits: Vec<ResetCredit>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResetCredit {
    id: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetResult {
    outcome: &'static str,
    windows_reset: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    available_count: Option<u64>,
}

fn safe_integer(value: &Value) -> Option<u64> {
    value.as_u64().filter(|n| *n <= (1 << 53) - 1)
}

fn bounded_text(value: &Value, max_utf16: usize) -> Option<&str> {
    value.as_str().filter(|s| {
        !s.trim().is_empty()
            && !s.chars().any(char::is_control)
            && s.encode_utf16().count() <= max_utf16
    })
}

fn parse_credits(value: &Value) -> Option<ResetCredits> {
    let available_count = safe_integer(&value["availableCount"])?;
    let rows = value["credits"].as_array().filter(|r| r.len() <= 256)?;
    let mut ids = HashSet::new();
    let mut credits = Vec::with_capacity(rows.len());
    for row in rows {
        let id = bounded_text(&row["id"], 256)?;
        if !ids.insert(id) {
            return None;
        }
        credits.push(ResetCredit {
            id: id.into(),
            status: bounded_text(&row["status"], 32)?.into(),
            expires_at: match row.get("expiresAt") {
                Some(v) => {
                    Some(safe_integer(v).filter(|n| (1..=8_640_000_000_000_000).contains(n))?)
                }
                None => None,
            },
            title: match row.get("title") {
                Some(v) => Some(bounded_text(v, 200)?.into()),
                None => None,
            },
        });
    }
    Some(ResetCredits {
        available_count,
        credits,
    })
}

fn parse_result(value: &Value) -> Option<ResetResult> {
    if value["ok"] != true || value["success"] != true {
        return None;
    }
    let outcome = match value["outcome"].as_str()? {
        "reset" => "reset",
        "already_redeemed" => "already_redeemed",
        "no_credit" => "no_credit",
        "nothing_to_reset" => "nothing_to_reset",
        _ => return None,
    };
    Some(ResetResult {
        outcome,
        windows_reset: safe_integer(&value["windowsReset"])?,
        available_count: match value.get("availableCount") {
            Some(v) => Some(safe_integer(v)?),
            None => None,
        },
    })
}

fn plugin_error(status: u16, value: &Value, fallback: &'static str) -> &'static str {
    match (status, value["error"].as_str()) {
        (401 | 403, _) => UNAUTHORIZED,
        (409, Some("codex_not_connected")) => DISCONNECTED,
        (409, Some("codex_reset_no_credit")) => NO_CREDIT,
        (429, Some("codex_reset_busy")) => BUSY,
        (422, Some("codex_reauth_required" | "codex_credential_invalid")) => {
            "codex_reauth_required"
        }
        (422, Some("codex_reset_invalid")) => INVALID,
        (502, Some("codex_reset_unavailable")) | (404 | 503, _) => UNAVAILABLE,
        _ => fallback,
    }
}

impl QuotaService {
    async fn reset_client(&self) -> Result<&AdminClient, &'static str> {
        let client = self.client.as_ref().ok_or(UNAVAILABLE)?;
        let config = client.config().await.map_err(|e| {
            if admin_auth_failed(&e) {
                UNAUTHORIZED
            } else {
                UNAVAILABLE
            }
        })?;
        configured(&config, &self.step_plan_hasher)
            .iter()
            .any(|r| r.row.codex_reset_eligible)
            .then_some(client)
            .ok_or(DISCONNECTED)
    }

    async fn list_reset_credits(&self) -> Result<ResetCredits, &'static str> {
        let client = self.reset_client().await?;
        let (status, value) = client
            .bounded_json(
                Method::GET,
                "/api/codex/reset-credits",
                None,
                Duration::from_secs(10),
            )
            .await
            .map_err(|_| UNAVAILABLE)?;
        if !status.is_success() {
            return Err(plugin_error(status.as_u16(), &value, UNAVAILABLE));
        }
        parse_credits(&value).ok_or(UNAVAILABLE)
    }

    async fn consume_reset_credit(
        &self,
        credit_id: Option<Value>,
    ) -> Result<ResetResult, &'static str> {
        let credit_id = match credit_id.as_ref() {
            Some(Value::Null) | None => None,
            Some(v) => Some(bounded_text(v, 256).ok_or(INVALID)?),
        };
        let client = self.client.as_ref().ok_or(UNAVAILABLE)?;
        // Reject simultaneous desktop confirmations immediately, including while rechecking config.
        let _guard = client.try_write_guard().ok_or(BUSY)?;
        let listing = self.list_reset_credits().await?;
        if listing.available_count == 0
            || credit_id.is_some_and(|id| {
                !listing
                    .credits
                    .iter()
                    .any(|c| c.id == id && c.status == "available")
            })
        {
            return Err(NO_CREDIT);
        }
        let body = credit_id.map_or_else(|| json!({}), |id| json!({"creditId":id}));
        let (status, value) = client
            .bounded_json(
                Method::POST,
                "/api/codex/reset-credits/consume",
                Some(&body),
                Duration::from_secs(60),
            )
            .await
            .map_err(|_| FAILED)?;
        if !status.is_success() {
            return Err(plugin_error(status.as_u16(), &value, FAILED));
        }
        let result = parse_result(&value).ok_or(FAILED)?;
        if matches!(result.outcome, "reset" | "already_redeemed") {
            // Snapshot holds this mutex until all adapters finish. Invalidate after an
            // overlapping pre-reset refresh has published its attempts and stale readings.
            let mut cache = self.cache.lock().await;
            cache.attempts.remove(&None);
            cache.attempts.remove(&Some(super::CODEX_PROVIDER.into()));
            if let Some(row) = cache
                .snapshot
                .providers
                .iter_mut()
                .find(|r| r.codex_reset_eligible)
            {
                row.windows.clear();
                row.updated_at = None;
                row.status = super::QuotaStatus::Unavailable;
                row.message = None;
            }
        }
        Ok(result)
    }
}

fn main_quota_view(label: &str, url: &reqwest::Url) -> bool {
    label == "main" && crate::popup::trusted_url(url)
}

fn guard(window: &WebviewWindow) -> Result<(), &'static str> {
    window
        .url()
        .ok()
        .filter(|url| main_quota_view(window.label(), url))
        .map(|_| ())
        .ok_or(UNAUTHORIZED)
}

#[tauri::command]
pub async fn codex_reset_credits(
    window: WebviewWindow,
    service: tauri::State<'_, QuotaService>,
) -> Result<ResetCredits, &'static str> {
    guard(&window)?;
    service.list_reset_credits().await
}

#[tauri::command]
pub async fn codex_reset_consume(
    window: WebviewWindow,
    service: tauri::State<'_, QuotaService>,
    credit_id: Option<Value>,
) -> Result<ResetResult, &'static str> {
    guard(&window)?;
    service.consume_reset_credit(credit_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::mock::{response, Mock};

    #[test]
    fn reset_commands_require_the_exact_local_main_view() {
        let local = if cfg!(windows) {
            "http://tauri.localhost/quota.html"
        } else {
            "tauri://localhost/quota.html"
        };
        let local = local.parse().unwrap();
        assert!(main_quota_view("main", &local));
        assert!(!main_quota_view("quota", &local));
        assert!(!main_quota_view(
            "main",
            &"http://127.0.0.1:3456/quota.html".parse().unwrap()
        ));
    }

    fn config() -> (u16, String) {
        response(json!({"Providers":[{"name":"codex-subscription","codex_managed":true}]}))
    }
    fn listing() -> Value {
        json!({"availableCount":2,"credits":[{"id":"gift","status":"available","expiresAt":123,"title":"Full reset","description":"private"},{"id":"spent","status":"redeemed"}]})
    }
    fn result(outcome: &str) -> Value {
        json!({"ok":true,"success":true,"outcome":outcome,"windowsReset":2,"availableCount":0,"ignored":"private"})
    }

    #[tokio::test]
    async fn reads_and_consumes_use_fixed_authenticated_routes_and_only_project_the_contract() {
        let mock = Mock::new(vec![
            config(),
            response(listing()),
            config(),
            response(listing()),
            response(result("reset")),
        ]);
        let service = QuotaService::new(Some(mock.client()));
        let credits = serde_json::to_value(service.list_reset_credits().await.unwrap()).unwrap();
        assert_eq!(
            credits,
            json!({"availableCount":2,"credits":[{"id":"gift","status":"available","expiresAt":123,"title":"Full reset"},{"id":"spent","status":"redeemed"}]})
        );
        let receipt = serde_json::to_value(
            service
                .consume_reset_credit(Some(json!("gift")))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            receipt,
            json!({"outcome":"reset","windowsReset":2,"availableCount":0})
        );
        let requests = mock.finish().await;
        assert_eq!(
            requests
                .iter()
                .map(|r| r.lines().next().unwrap())
                .collect::<Vec<_>>(),
            [
                "GET /api/config HTTP/1.1",
                "GET /api/codex/reset-credits HTTP/1.1",
                "GET /api/config HTTP/1.1",
                "GET /api/codex/reset-credits HTTP/1.1",
                "POST /api/codex/reset-credits/consume HTTP/1.1"
            ]
        );
        assert!(requests.iter().all(|r| r
            .to_ascii_lowercase()
            .contains("x-api-key: test-admin-key\r\n")));
        assert!(requests[4].ends_with(r#"{"creditId":"gift"}"#));
    }

    #[tokio::test]
    async fn eligibility_and_credit_selection_are_checked_again_before_post() {
        for (entry, expected) in [
            (
                json!({"name":"codex-subscription","api_key":"ordinary"}),
                false,
            ),
            (
                json!({"name":"codex-subscription","enabled":false,"codexManaged":true}),
                false,
            ),
            (
                json!({"name":"codex-subscription","enabled":"true","codexManaged":true}),
                false,
            ),
            (json!({"name":"other","codex_managed":true}), false),
            (
                json!({"name":"codex-subscription","apiKey":"ccr-managed-codex"}),
                true,
            ),
            (
                json!({"name":"codex-subscription","enabled":true,"codexManaged":true}),
                true,
            ),
        ] {
            let cfg = json!({"providers":[entry]});
            let row = configured(&cfg, &std::collections::hash_map::RandomState::new())
                .remove(0)
                .row;
            assert_eq!(
                serde_json::to_value(row).unwrap()["codexResetEligible"],
                expected
            );
            if !expected {
                let mock = Mock::new(vec![response(cfg)]);
                let service = QuotaService::new(Some(mock.client()));
                assert_eq!(
                    service
                        .consume_reset_credit(Some(json!("gift")))
                        .await
                        .unwrap_err(),
                    DISCONNECTED
                );
                assert_eq!(mock.finish().await.len(), 1);
            }
        }
        let duplicate = json!({"Providers":[{"name":"codex-subscription","codex_managed":true},{"name":"codex-subscription"}]});
        assert!(
            !configured(&duplicate, &std::collections::hash_map::RandomState::new())[0]
                .row
                .codex_reset_eligible
        );
        for id in ["spent", "different-account"] {
            let mock = Mock::new(vec![config(), response(listing())]);
            assert_eq!(
                QuotaService::new(Some(mock.client()))
                    .consume_reset_credit(Some(json!(id)))
                    .await
                    .unwrap_err(),
                NO_CREDIT
            );
            assert_eq!(mock.finish().await.len(), 2);
        }
        for value in [Value::Null, json!({"availableCount":0,"credits":[]})] {
            let mock = Mock::new(vec![config(), response(value.clone())]);
            assert_eq!(
                QuotaService::new(Some(mock.client()))
                    .consume_reset_credit(None)
                    .await
                    .unwrap_err(),
                if value.is_null() {
                    UNAVAILABLE
                } else {
                    NO_CREDIT
                }
            );
            assert_eq!(mock.finish().await.len(), 2);
        }
    }

    #[tokio::test]
    async fn invalid_ids_and_overlapping_writes_never_issue_a_request() {
        let mock = Mock::new(vec![]);
        let client = mock.client();
        let service = QuotaService::new(Some(client.clone()));
        for id in [
            json!(""),
            json!("   "),
            json!(42),
            json!("a\nb"),
            json!("😀".repeat(129)),
        ] {
            assert_eq!(
                service.consume_reset_credit(Some(id)).await.unwrap_err(),
                INVALID
            );
        }
        let _held = client.write_guard().await;
        assert_eq!(service.consume_reset_credit(None).await.unwrap_err(), BUSY);
        assert!(mock.finish().await.is_empty());
    }

    #[tokio::test]
    async fn absent_or_null_credit_leaves_backend_selection_to_the_plugin() {
        for id in [None, Some(Value::Null)] {
            let mock = Mock::new(vec![
                config(),
                response(listing()),
                response(result("nothing_to_reset")),
            ]);
            assert_eq!(
                QuotaService::new(Some(mock.client()))
                    .consume_reset_credit(id)
                    .await
                    .unwrap()
                    .outcome,
                "nothing_to_reset"
            );
            assert!(mock.finish().await[2].ends_with("\r\n\r\n{}"));
        }
    }

    #[test]
    fn malformed_listing_and_unconfirmed_receipts_fail_closed() {
        for (key, bad) in [
            ("availableCount", json!(1.5)),
            ("availableCount", json!(-1)),
            ("availableCount", json!(1u64 << 53)),
            ("credits", Value::Null),
            (
                "credits",
                json!(vec![json!({"id":"x","status":"available"}); 257]),
            ),
            (
                "credits",
                json!([{"id":"x","status":"available"},{"id":"x","status":"spent"}]),
            ),
        ] {
            let mut v = listing();
            v[key] = bad;
            assert!(parse_credits(&v).is_none());
        }
        for (key, bad) in [
            ("id", json!(true)),
            ("status", json!("")),
            ("title", json!("x".repeat(201))),
            ("expiresAt", Value::Null),
            ("expiresAt", json!(0)),
        ] {
            let mut v = listing();
            v["credits"][0][key] = bad;
            assert!(parse_credits(&v).is_none());
        }
        for outcome in ["reset", "already_redeemed", "nothing_to_reset", "no_credit"] {
            let mut v = result(outcome);
            v.as_object_mut().unwrap().remove("availableCount");
            assert!(serde_json::to_value(parse_result(&v).unwrap())
                .unwrap()
                .get("availableCount")
                .is_none());
        }
        for (key, bad) in [
            ("ok", json!(false)),
            ("success", json!("true")),
            ("outcome", json!("unknown")),
            ("windowsReset", json!(-1)),
            ("availableCount", Value::Null),
        ] {
            let mut v = result("reset");
            v[key] = bad;
            assert!(parse_result(&v).is_none());
        }
    }

    #[tokio::test]
    async fn failed_consume_maps_only_stable_codes_and_sends_one_post() {
        for (status, body, expected) in [
            (429, "codex_reset_busy", BUSY),
            (409, "codex_reset_no_credit", NO_CREDIT),
            (409, "codex_not_connected", DISCONNECTED),
            (422, "codex_reauth_required", "codex_reauth_required"),
            (422, "codex_reset_invalid", INVALID),
            (502, "codex_reset_unavailable", UNAVAILABLE),
            (401, "secret", UNAUTHORIZED),
            (500, "secret", FAILED),
            (200, "secret", FAILED),
        ] {
            let mock = Mock::new(vec![
                config(),
                response(listing()),
                (status, json!({"ok":false,"error":body}).to_string()),
            ]);
            assert_eq!(
                QuotaService::new(Some(mock.client()))
                    .consume_reset_credit(Some(json!("gift")))
                    .await
                    .unwrap_err(),
                expected
            );
            assert_eq!(mock.finish().await.len(), 3);
        }
    }

    #[tokio::test]
    async fn successful_consume_invalidates_both_attempts_after_an_overlapping_snapshot() {
        for outcome in ["reset", "already_redeemed"] {
            let current_usage = response(json!({"status":"connected","primary":{"usedPercent":0}}));
            let mock = Mock::new(vec![
                config(),
                response(listing()),
                response(result(outcome)),
                config(),
                current_usage.clone(),
                current_usage,
            ]);
            let service = QuotaService::new(Some(mock.client()));
            let target = Some("codex-subscription".into());
            let mut refresh = service.cache.lock().await;
            let consume = service.consume_reset_credit(Some(json!("gift")));
            tokio::pin!(consume);
            assert!(
                tokio::time::timeout(Duration::from_millis(100), &mut consume)
                    .await
                    .is_err()
            );
            // Model the completion of a full in-flight refresh while consume waits on its lock.
            refresh.attempts.insert(None, super::super::now());
            refresh.attempts.insert(target.clone(), super::super::now());
            drop(refresh);
            assert_eq!(consume.await.unwrap().outcome, outcome);
            assert!(!service.cache.lock().await.attempts.contains_key(&None));
            let snapshot = service.snapshot(target).await.unwrap();
            assert_eq!(snapshot.providers[0].windows[0].used, Some(0.0));
            assert_eq!(mock.finish().await.len(), 6);
        }
    }
}
