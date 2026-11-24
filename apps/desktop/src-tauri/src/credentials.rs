//! Volcengine Coding Plan quota credentials (AK/SK) for matching providers.
//!
//! Every command is restricted to the local control-center views via
//! `popup::guard`. Only providers whose `api_base_url` points at the Ark
//! Coding Plan endpoint (`ark.cn-beijing.volces.com` with `/api/coding/` in
//! the path — the same condition as the core quota adapter) are addressable.
//! The IPC projection is `{providers:[{name, configured}]}` only: secret
//! values never cross IPC, never appear in errors, and are never logged.
//! Saves share the AdminClient write lock, mutate only `quotaAccessKey` /
//! `quotaSecretKey` on a fresh config, and verify the persisted fields through
//! the post-save readback. Omitted input keeps the saved field; an empty
//! string clears it.

use crate::api::AdminClient;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use tauri::WebviewWindow;

const ACCESS_KEY_FIELD: &str = "quotaAccessKey";
const SECRET_KEY_FIELD: &str = "quotaSecretKey";
/// Same host/path condition as the core VolcengineCodingPlanQuotaAdapter.
const CODING_PLAN_HOST: &str = "ark.cn-beijing.volces.com";
const CODING_PLAN_PATH: &str = "/api/coding/";
/// Credentials are short opaque tokens; mirror the quota name bound.
const MAX_VALUE_LENGTH: usize = 256;

// Safe fixed error messages. Transport failures from AdminClient are already
// sanitized to method, path, and status; submitted values are never echoed.
const ERR_OFFLINE: &str = "Gateway connection is unavailable";
const ERR_NOT_FOUND: &str = "Coding Plan provider is no longer configured; refresh the panel";
const ERR_INPUT: &str = "Invalid credentials input";
const ERR_SAVE_NOT_CONFIRMED: &str = "Credentials update was not confirmed by the gateway";

// ============================== IPC projection ==============================

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct CredentialsProvider {
    pub name: String,
    pub configured: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct CredentialsStatus {
    pub providers: Vec<CredentialsProvider>,
}

// ============================== Matching ==============================

/// True only for the Ark Coding Plan endpoint the core adapter signs for.
/// `/api/v3` (pay-as-you-go) and `/api/plan` (Agent Plan) never match.
pub(super) fn coding_plan_provider(entry: &Value) -> bool {
    let Some(base) = entry["api_base_url"].as_str() else {
        return false;
    };
    let Ok(url) = reqwest::Url::parse(base) else {
        return false;
    };
    url.host_str() == Some(CODING_PLAN_HOST) && url.path().contains(CODING_PLAN_PATH)
}

/// Same name rules as the quota projection: the credentials list must line up
/// with the cards the quota tab can render.
fn provider_name(entry: &Value) -> Option<String> {
    let name = entry["name"].as_str()?;
    if name.trim().is_empty()
        || name.len() > MAX_VALUE_LENGTH
        || name.chars().any(char::is_control)
        || name.contains(',')
        || name.trim() != name
    {
        return None;
    }
    Some(name.to_owned())
}

fn field_present(entry: &Value, key: &str) -> bool {
    entry[key]
        .as_str()
        .is_some_and(|value| !value.trim().is_empty())
}

fn status_from(config: &Value) -> CredentialsStatus {
    let mut seen = HashSet::new();
    let providers = config["Providers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|entry| coding_plan_provider(entry))
        .filter_map(|entry| {
            let name = provider_name(entry)?;
            if !seen.insert(name.clone()) {
                return None;
            }
            Some(CredentialsProvider {
                name,
                configured: field_present(entry, ACCESS_KEY_FIELD)
                    && field_present(entry, SECRET_KEY_FIELD),
            })
        })
        .collect();
    CredentialsStatus { providers }
}

/// Locates the first matching Coding Plan entry with this exact name.
fn find_entry<'a>(config: &'a Value, name: &str) -> Option<&'a Value> {
    config["Providers"]
        .as_array()?
        .iter()
        .find(|entry| coding_plan_provider(entry) && provider_name(entry).as_deref() == Some(name))
}

// ============================== Input ==============================

/// One credential field mutation: absent input keeps the saved value.
enum FieldChange {
    Keep,
    Set(String),
    Clear,
}

/// `None` keeps, `Some("")` clears, `Some(value)` sets the trimmed value.
/// Whitespace-only and oversized/control-character values are rejected before
/// any request; submitted values are never echoed back in errors.
fn field_change(input: Option<String>) -> Result<FieldChange, String> {
    match input {
        None => Ok(FieldChange::Keep),
        Some(value) if value.is_empty() => Ok(FieldChange::Clear),
        Some(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty()
                || trimmed.len() > MAX_VALUE_LENGTH
                || trimmed.chars().any(char::is_control)
            {
                return Err(ERR_INPUT.into());
            }
            Ok(FieldChange::Set(trimmed.to_owned()))
        }
    }
}

impl FieldChange {
    fn apply(&self, entry: &mut Value, key: &str) {
        match self {
            FieldChange::Keep => {}
            FieldChange::Set(value) => entry[key] = Value::String(value.clone()),
            FieldChange::Clear => {
                if let Some(map) = entry.as_object_mut() {
                    map.remove(key);
                }
            }
        }
    }

    /// Readback check: a set field must equal the submitted value; a cleared
    /// field must be absent (the gateway may normalize it to null/empty).
    fn confirmed(&self, entry: &Value, key: &str) -> bool {
        match self {
            FieldChange::Keep => true,
            FieldChange::Set(value) => entry[key].as_str() == Some(value.as_str()),
            FieldChange::Clear => match entry.get(key) {
                None | Some(Value::Null) => true,
                Some(Value::String(value)) => value.trim().is_empty(),
                _ => false,
            },
        }
    }
}

// ============================== Service ==============================

pub struct CredentialsService {
    client: Option<AdminClient>,
}

impl CredentialsService {
    pub fn new(client: Option<AdminClient>) -> Self {
        Self { client }
    }

    fn client(&self) -> Result<&AdminClient, String> {
        self.client.as_ref().ok_or_else(|| ERR_OFFLINE.to_string())
    }

    pub(crate) async fn status(&self) -> Result<CredentialsStatus, String> {
        let config = self.client()?.config().await?;
        Ok(status_from(&config))
    }

    pub(crate) async fn save(
        &self,
        name: &str,
        access_key: Option<String>,
        secret_key: Option<String>,
    ) -> Result<CredentialsStatus, String> {
        // Structural validation happens before any request or lock.
        let access = field_change(access_key)?;
        let secret = field_change(secret_key)?;
        let client = self.client()?;
        let _write = client.write_guard().await;
        // Always mutate the freshest config; never a cached snapshot.
        let mut config = client.config().await?;
        let index = config["Providers"]
            .as_array()
            .and_then(|entries| {
                entries.iter().position(|entry| {
                    coding_plan_provider(entry) && provider_name(entry).as_deref() == Some(name)
                })
            })
            .ok_or_else(|| ERR_NOT_FOUND.to_string())?;
        let entry = &config["Providers"][index];
        let mut updated = entry.clone();
        access.apply(&mut updated, ACCESS_KEY_FIELD);
        secret.apply(&mut updated, SECRET_KEY_FIELD);
        if updated == *entry {
            // Nothing to write (both fields kept or identical values): skip
            // the full-config POST so an unchanged save never churns backups.
            return Ok(status_from(&config));
        }
        config["Providers"][index] = updated;
        let verified = client.post_config_and_readback(&config).await?;
        let readback =
            find_entry(&verified, name).ok_or_else(|| ERR_SAVE_NOT_CONFIRMED.to_string())?;
        if !access.confirmed(readback, ACCESS_KEY_FIELD)
            || !secret.confirmed(readback, SECRET_KEY_FIELD)
        {
            return Err(ERR_SAVE_NOT_CONFIRMED.into());
        }
        Ok(status_from(&verified))
    }
}

// ============================== Tauri commands ==============================

#[tauri::command]
pub async fn quota_credentials_status(
    window: WebviewWindow,
    service: tauri::State<'_, CredentialsService>,
) -> Result<CredentialsStatus, String> {
    crate::popup::guard(&window)?;
    service.status().await
}

#[tauri::command]
pub async fn quota_credentials_save(
    window: WebviewWindow,
    service: tauri::State<'_, CredentialsService>,
    name: String,
    access_key: Option<String>,
    secret_key: Option<String>,
) -> Result<CredentialsStatus, String> {
    crate::popup::guard(&window)?;
    service.save(&name, access_key, secret_key).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::mock::{response, Mock};
    use serde_json::json;

    const CODING_URL: &str = "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions";

    fn coding_entry(name: &str) -> Value {
        json!({
            "name": name,
            "api_base_url": CODING_URL,
            "api_key": "UPSTREAM_SECRET",
            "models": ["doubao-seed-code"],
            "custom": {"nested": ["KEEP_ME"]}
        })
    }

    fn config_with(entries: Vec<Value>) -> Value {
        json!({"APIKEY": "ADMIN_SECRET", "Providers": entries, "Router": {"default": "other,model"}})
    }

    fn posted_config(request: &str) -> Value {
        serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap()
    }

    #[test]
    fn coding_path_matches_only_the_ark_coding_endpoint() {
        for url in [
            CODING_URL,
            "https://ark.cn-beijing.volces.com/api/coding/v3",
            "https://ARK.CN-BEIJING.VOLCES.COM/api/coding/v3/chat/completions",
        ] {
            assert!(coding_plan_provider(&json!({"api_base_url": url})), "{url}");
        }
        for url in [
            "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
            "https://ark.cn-beijing.volces.com/api/plan/v1/usage",
            "https://ark.cn-beijing.volces.com/api/coding",
            "https://evil.volces.com/api/coding/v3",
            "https://ark.cn-beijing.volces.com.evil.example/api/coding/v3",
            "https://example.com/api/coding/v3",
            "not a url",
            "",
        ] {
            assert!(
                !coding_plan_provider(&json!({"api_base_url": url})),
                "{url}"
            );
        }
        assert!(!coding_plan_provider(&json!({"name": "no-url"})));
        assert!(!coding_plan_provider(&json!({"api_base_url": 42})));
    }

    #[test]
    fn status_projects_only_coding_providers_and_never_secrets() {
        let mut configured = coding_entry("火山agent plan");
        configured[ACCESS_KEY_FIELD] = json!("AK_VALUE");
        configured[SECRET_KEY_FIELD] = json!("SK_VALUE");
        let mut partial = coding_entry("partial");
        partial[ACCESS_KEY_FIELD] = json!("AK_ONLY");
        let mut blank = coding_entry("blank");
        blank[ACCESS_KEY_FIELD] = json!("AK");
        blank[SECRET_KEY_FIELD] = json!("   ");
        let config = config_with(vec![
            json!({"name": "plain", "api_base_url": "https://example.com/v1", "api_key": "OTHER_SECRET"}),
            configured,
            partial,
            blank,
            coding_entry("火山agent plan"), // duplicate name: first wins
            json!({"name": "bad,name", "api_base_url": CODING_URL}),
            json!({"name": " padded ", "api_base_url": CODING_URL}),
        ]);
        let status = status_from(&config);
        assert_eq!(
            status.providers,
            vec![
                CredentialsProvider {
                    name: "火山agent plan".into(),
                    configured: true
                },
                CredentialsProvider {
                    name: "partial".into(),
                    configured: false
                },
                CredentialsProvider {
                    name: "blank".into(),
                    configured: false
                },
            ]
        );
        let encoded = serde_json::to_string(&status).unwrap();
        for forbidden in [
            "AK_VALUE",
            "SK_VALUE",
            "AK_ONLY",
            "UPSTREAM_SECRET",
            "OTHER_SECRET",
            "ADMIN_SECRET",
            "api_key",
            "api_base_url",
            "quotaAccessKey",
            "quotaSecretKey",
        ] {
            assert!(!encoded.contains(forbidden), "leaked {forbidden}");
        }
    }

    #[tokio::test]
    async fn save_sets_only_the_two_fields_and_verifies_readback() {
        let original = config_with(vec![
            coding_entry("volc"),
            json!({"name": "other", "api_key": "OTHER_SECRET"}),
        ]);
        let mut expected = original.clone();
        expected["Providers"][0][ACCESS_KEY_FIELD] = json!("NEW_AK");
        expected["Providers"][0][SECRET_KEY_FIELD] = json!("NEW_SK");
        let mock = Mock::new(vec![
            response(original.clone()),
            response(json!({"success": true})),
            response(expected.clone()),
        ]);
        let service = CredentialsService::new(Some(mock.client()));
        let status = service
            .save("volc", Some("NEW_AK".into()), Some("NEW_SK".into()))
            .await
            .unwrap();
        assert_eq!(
            status.providers,
            vec![CredentialsProvider {
                name: "volc".into(),
                configured: true
            }]
        );
        let requests = mock.finish().await;
        assert_eq!(requests.len(), 3);
        assert!(requests[0].starts_with("GET /api/config "));
        assert!(requests[1].starts_with("POST /api/config "));
        assert!(requests[2].starts_with("GET /api/config "));
        // Only the two credential fields change; everything else roundtrips.
        assert_eq!(posted_config(&requests[1]), expected);
        assert!(!serde_json::to_string(&status).unwrap().contains("NEW_SK"));
    }

    #[tokio::test]
    async fn empty_string_clears_and_absent_input_preserves() {
        let mut original_entry = coding_entry("volc");
        original_entry[ACCESS_KEY_FIELD] = json!("OLD_AK");
        original_entry[SECRET_KEY_FIELD] = json!("OLD_SK");
        let original = config_with(vec![original_entry]);
        let mut expected = original.clone();
        expected["Providers"][0]
            .as_object_mut()
            .unwrap()
            .remove(ACCESS_KEY_FIELD);
        let mock = Mock::new(vec![
            response(original.clone()),
            response(json!({"success": true})),
            response(expected.clone()),
        ]);
        let service = CredentialsService::new(Some(mock.client()));
        let status = service.save("volc", Some("".into()), None).await.unwrap();
        assert_eq!(
            status.providers,
            vec![CredentialsProvider {
                name: "volc".into(),
                configured: false
            }]
        );
        let requests = mock.finish().await;
        assert_eq!(requests.len(), 3);
        let posted = posted_config(&requests[1]);
        assert_eq!(posted, expected);
        assert_eq!(posted["Providers"][0][SECRET_KEY_FIELD], json!("OLD_SK"));
        assert!(posted["Providers"][0].get(ACCESS_KEY_FIELD).is_none());
    }

    #[tokio::test]
    async fn unchanged_save_never_posts() {
        let mut entry = coding_entry("volc");
        entry[ACCESS_KEY_FIELD] = json!("AK");
        entry[SECRET_KEY_FIELD] = json!("SK");
        let config = config_with(vec![entry]);
        for (access, secret) in [
            (None, None),
            (Some("AK".to_string()), Some("SK".to_string())),
        ] {
            let mock = Mock::new(vec![response(config.clone())]);
            let service = CredentialsService::new(Some(mock.client()));
            let status = service.save("volc", access, secret).await.unwrap();
            assert!(status.providers[0].configured);
            let requests = mock.finish().await;
            assert_eq!(requests.len(), 1, "an unchanged save must not POST");
        }
    }

    #[tokio::test]
    async fn unknown_non_coding_and_invalid_targets_never_post() {
        let config = config_with(vec![
            coding_entry("volc"),
            json!({"name": "plain", "api_base_url": "https://example.com/api/coding/v3"}),
        ]);
        for name in ["missing", "plain"] {
            let mock = Mock::new(vec![response(config.clone())]);
            let service = CredentialsService::new(Some(mock.client()));
            let error = service
                .save(name, Some("AK".into()), None)
                .await
                .unwrap_err();
            assert!(error.contains("no longer configured"));
            assert_eq!(mock.finish().await.len(), 1);
        }
        // Invalid values are rejected before any request or lock.
        for value in ["   ", "a\u{0007}b", &"x".repeat(MAX_VALUE_LENGTH + 1)] {
            let mock = Mock::new(vec![]);
            let service = CredentialsService::new(Some(mock.client()));
            let error = service
                .save("volc", Some(value.to_string()), None)
                .await
                .unwrap_err();
            assert_eq!(error, ERR_INPUT);
            assert!(!error.contains(value));
            assert!(mock.finish().await.is_empty());
        }
        let offline = CredentialsService::new(None);
        assert_eq!(offline.status().await.unwrap_err(), ERR_OFFLINE);
        assert_eq!(
            offline.save("volc", None, None).await.unwrap_err(),
            ERR_OFFLINE
        );
    }

    #[tokio::test]
    async fn readback_mismatch_and_transport_errors_are_not_confirmed_or_leaked() {
        let original = config_with(vec![coding_entry("volc")]);
        // The gateway reports success but the readback lacks the new values.
        let mock = Mock::new(vec![
            response(original.clone()),
            response(json!({"success": true})),
            response(original.clone()),
        ]);
        let service = CredentialsService::new(Some(mock.client()));
        let error = service
            .save("volc", Some("NEW_AK".into()), Some("NEW_SK".into()))
            .await
            .unwrap_err();
        assert!(error.contains("not confirmed"));
        assert!(!error.contains("NEW_AK") && !error.contains("NEW_SK"));
        assert_eq!(mock.finish().await.len(), 3);

        // A failed POST never echoes the upstream body or the submitted keys.
        let mock = Mock::new(vec![
            response(original.clone()),
            (500, "LEAK_SECRET NEW_SK".into()),
        ]);
        let service = CredentialsService::new(Some(mock.client()));
        let error = service
            .save("volc", Some("NEW_AK".into()), Some("NEW_SK".into()))
            .await
            .unwrap_err();
        assert!(
            !error.contains("LEAK_SECRET")
                && !error.contains("NEW_SK")
                && !error.contains("NEW_AK")
        );
        assert_eq!(mock.finish().await.len(), 2);

        // A readback where the provider vanished is also unconfirmed.
        let mock = Mock::new(vec![
            response(original.clone()),
            response(json!({"success": true})),
            response(config_with(vec![])),
        ]);
        let service = CredentialsService::new(Some(mock.client()));
        assert!(service
            .save("volc", Some("AK".into()), None)
            .await
            .unwrap_err()
            .contains("not confirmed"));
        assert_eq!(mock.finish().await.len(), 3);
    }

    #[tokio::test]
    async fn cleared_readback_accepts_gateway_empty_normalization() {
        let mut entry = coding_entry("volc");
        entry[ACCESS_KEY_FIELD] = json!("OLD_AK");
        entry[SECRET_KEY_FIELD] = json!("OLD_SK");
        let original = config_with(vec![entry]);
        let mut readback = original.clone();
        // The gateway may persist cleared fields as empty strings.
        readback["Providers"][0][ACCESS_KEY_FIELD] = json!("");
        readback["Providers"][0][SECRET_KEY_FIELD] = json!("");
        let mock = Mock::new(vec![
            response(original.clone()),
            response(json!({"success": true})),
            response(readback),
        ]);
        let service = CredentialsService::new(Some(mock.client()));
        let status = service
            .save("volc", Some("".into()), Some("".into()))
            .await
            .unwrap();
        assert_eq!(
            status.providers,
            vec![CredentialsProvider {
                name: "volc".into(),
                configured: false
            }]
        );
        assert_eq!(mock.finish().await.len(), 3);
    }

    #[tokio::test]
    async fn status_reads_fresh_config_and_projects_without_secrets() {
        let mut entry = coding_entry("volc");
        entry[ACCESS_KEY_FIELD] = json!("AK_VALUE");
        entry[SECRET_KEY_FIELD] = json!("SK_VALUE");
        let mock = Mock::new(vec![response(config_with(vec![entry]))]);
        let service = CredentialsService::new(Some(mock.client()));
        let status = service.status().await.unwrap();
        assert_eq!(
            status.providers,
            vec![CredentialsProvider {
                name: "volc".into(),
                configured: true
            }]
        );
        let requests = mock.finish().await;
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with("GET /api/config "));
        assert!(!serde_json::to_string(&status).unwrap().contains("SK_VALUE"));
    }
}
