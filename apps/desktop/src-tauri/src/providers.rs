//! Add an ordinary API provider through the gateway's raw config endpoint.

use crate::api::AdminClient;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use tauri::WebviewWindow;

const ERR_INVALID: &str = "PROVIDER_INVALID";
const ERR_DUPLICATE: &str = "PROVIDER_DUPLICATE";
const ERR_UNAVAILABLE: &str = "PROVIDER_UNAVAILABLE";
const ERR_UNCONFIRMED: &str = "PROVIDER_SAVE_UNCONFIRMED";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderInput {
    name: String,
    base_url: String,
    api_key: String,
    models: Vec<String>,
}

#[derive(Serialize, Debug)]
pub struct AddedProvider {
    name: String,
}

fn bounded_text(value: &str, max_bytes: usize) -> Result<&str, &'static str> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > max_bytes || value.chars().any(char::is_control) {
        return Err(ERR_INVALID);
    }
    Ok(trimmed)
}

fn identifier(value: &str) -> Result<&str, &'static str> {
    let value = bounded_text(value, 256)?;
    if value.contains(',') {
        return Err(ERR_INVALID);
    }
    Ok(value)
}

fn endpoint(value: &str) -> Result<&str, &'static str> {
    let value = bounded_text(value, 2048)?;
    // The URL parser repairs missing slashes, empty authorities and backslashes.
    // Require an explicit authority and reject even an empty userinfo component.
    let (scheme, remainder) = value.split_once("://").ok_or(ERR_INVALID)?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return Err(ERR_INVALID);
    }
    let authority = remainder.split(['/', '?', '#']).next().unwrap_or_default();
    let url = reqwest::Url::parse(value).map_err(|_| ERR_INVALID)?;
    if !url.has_host()
        || authority.is_empty()
        || authority.contains('@')
        || value.contains('\\')
        || value.chars().any(char::is_whitespace)
        || url.fragment().is_some()
    {
        return Err(ERR_INVALID);
    }
    Ok(value)
}

impl ProviderInput {
    fn entry(&self) -> Result<Value, &'static str> {
        let name = identifier(&self.name)?;
        let base_url = endpoint(&self.base_url)?;
        let api_key = bounded_text(&self.api_key, 4096)?;
        if self.models.is_empty() || self.models.len() > 256 {
            return Err(ERR_INVALID);
        }
        let mut models = Vec::new();
        let mut seen = HashSet::new();
        for model in &self.models {
            let model = identifier(model)?;
            if !seen.insert(model) {
                return Err(ERR_INVALID);
            }
            models.push(model);
        }
        Ok(json!({"name":name, "api_base_url":base_url, "api_key":api_key, "models":models}))
    }
}

pub struct ProvidersService {
    client: Option<AdminClient>,
}

impl ProvidersService {
    pub fn new(client: Option<AdminClient>) -> Self {
        Self { client }
    }

    async fn add(&self, provider: Option<Value>) -> Result<AddedProvider, &'static str> {
        // Deserialize here so malformed IPC values never surface in framework errors.
        let provider: ProviderInput =
            serde_json::from_value(provider.ok_or(ERR_INVALID)?).map_err(|_| ERR_INVALID)?;
        let entry = provider.entry()?;
        let name = provider.name.trim();
        let folded = name.to_lowercase();
        let same_name = |p: &Value| {
            p["name"]
                .as_str()
                .is_some_and(|n| n.trim().to_lowercase() == folded)
        };
        let client = self.client.as_ref().ok_or(ERR_UNAVAILABLE)?;
        let _write = client.write_guard().await;
        let mut config = client.config().await.map_err(|_| ERR_UNAVAILABLE)?;
        let key = crate::api::provider_list_key(&config);
        let root = config.as_object_mut().ok_or(ERR_UNAVAILABLE)?;
        // The gateway also accepts legacy `providers`. Creating a parallel
        // `Providers` array would shadow the existing list on runtime reload.
        let entries = root
            .entry(key)
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or(ERR_UNAVAILABLE)?;
        if entries.iter().any(same_name) {
            return Err(ERR_DUPLICATE);
        }
        entries.push(entry.clone());
        let verified = client
            .post_config_and_readback(&config)
            .await
            .map_err(|_| ERR_UNCONFIRMED)?;
        let mut matching = verified[key]
            .as_array()
            .ok_or(ERR_UNCONFIRMED)?
            .iter()
            .filter(|p| same_name(p));
        let saved = matching.next().ok_or(ERR_UNCONFIRMED)?;
        if matching.next().is_some()
            || ["name", "api_base_url", "api_key", "models"]
                .iter()
                .any(|key| saved[key] != entry[key])
        {
            return Err(ERR_UNCONFIRMED);
        }
        Ok(AddedProvider {
            name: name.to_owned(),
        })
    }
}

#[tauri::command]
pub async fn provider_add(
    window: WebviewWindow,
    service: tauri::State<'_, ProvidersService>,
    provider: Option<Value>,
) -> Result<AddedProvider, String> {
    crate::popup::guard(&window)?;
    service.add(provider).await.map_err(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::mock::{response, Mock};

    fn input() -> Value {
        json!({"name":" Example ", "baseUrl":" https://example.com/v1/chat/completions?version=1 ", "apiKey":" test-key ", "models":[" model-a ", "model-b"]})
    }

    fn entry() -> Value {
        json!({"name":"Example", "api_base_url":"https://example.com/v1/chat/completions?version=1", "api_key":"test-key", "models":["model-a", "model-b"]})
    }

    #[tokio::test]
    async fn add_appends_to_fresh_config_preserves_unknowns_and_returns_only_name() {
        let original = json!({
            "Providers":[{"name":"existing", "models":["abc"], "custom":{"nested":[true,null,1]}}],
            "Router":{"default":"existing,abc"}, "custom":{"unexpanded":"${PLACEHOLDER}"}
        });
        let mut expected = original.clone();
        expected["Providers"].as_array_mut().unwrap().push(entry());
        let mut verified = expected.clone();
        verified["Providers"][1]["enabled"] = json!(true);
        let mock = Mock::new(vec![
            response(original),
            response(json!({"success":true})),
            response(verified),
        ]);
        let service = ProvidersService::new(Some(mock.client()));
        let result = service.add(Some(input())).await.unwrap();
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({"name":"Example"})
        );
        let requests = mock.finish().await;
        assert_eq!(requests.len(), 3);
        assert!(requests[0].starts_with("GET /api/config "));
        assert!(requests[1].starts_with("POST /api/config "));
        assert!(requests[2].starts_with("GET /api/config "));
        let body = requests[1].split_once("\r\n\r\n").unwrap().1;
        assert_eq!(serde_json::from_str::<Value>(body).unwrap(), expected);
    }

    #[tokio::test]
    async fn add_uses_shared_write_guard_and_checks_all_names_on_fresh_read() {
        let mock = Mock::new(vec![response(
            json!({"Providers":[{"name":" eXamPle ","enabled":false}]}),
        )]);
        let client = mock.client();
        let service = ProvidersService::new(Some(client.clone()));
        let guard = client.write_guard().await;
        let add = service.add(Some(input()));
        tokio::pin!(add);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), &mut add)
                .await
                .is_err()
        );
        drop(guard);
        assert_eq!(add.await.unwrap_err(), ERR_DUPLICATE);
        assert_eq!(mock.finish().await.len(), 1);
    }

    #[tokio::test]
    async fn malformed_or_legacy_provider_lists_are_never_overwritten() {
        for malformed in [Value::Null, json!({}), json!("unexpected")] {
            let mock = Mock::new(vec![response(json!({"Providers": malformed}))]);
            let service = ProvidersService::new(Some(mock.client()));
            assert_eq!(
                service.add(Some(input())).await.unwrap_err(),
                ERR_UNAVAILABLE
            );
            assert_eq!(mock.finish().await.len(), 1);
        }
        let mock = Mock::new(vec![response(json!({"providers":[entry()]}))]);
        let service = ProvidersService::new(Some(mock.client()));
        assert_eq!(service.add(Some(input())).await.unwrap_err(), ERR_DUPLICATE);
        assert_eq!(mock.finish().await.len(), 1);
    }

    #[tokio::test]
    async fn legacy_add_is_visible_to_quota_and_routing_choices() {
        let verified = json!({"providers":[entry()]});
        let mock = Mock::new(vec![
            response(json!({"providers":[]})),
            response(json!({"success":true})),
            response(verified.clone()),
            response(verified.clone()),
            response(json!({"quotas":[]})),
        ]);
        let client = mock.client();
        ProvidersService::new(Some(client.clone()))
            .add(Some(input()))
            .await
            .unwrap();
        let quota = crate::quota::QuotaService::new(Some(client))
            .snapshot(Some("Example".into()))
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(quota).unwrap()["providers"][0]["name"],
            "Example"
        );
        assert_eq!(
            crate::api::providers(&verified)[0].models,
            ["model-a", "model-b"]
        );
        mock.finish().await;
    }

    #[test]
    fn endpoint_accepts_absolute_http_and_https_rejects_userinfo_and_fragments() {
        for url in [
            "http://example.com:8080/v1",
            "HTTPS://example.com",
            "https://example.com/v1?version=1",
        ] {
            assert_eq!(endpoint(url), Ok(url));
        }
        for url in [
            "example.com",
            "ftp://example.com",
            "http:example.com",
            "https:///example.com",
            "http:/example.com/path://example.com",
            "https://example.com/#",
            "https://@example.com",
            "https://user:test-key@example.com/",
            "https://example.com/has space",
            "https://example.com\\path",
            "https://",
            "https://example.com:bad",
        ] {
            assert_eq!(endpoint(url), Err(ERR_INVALID));
        }
    }

    #[tokio::test]
    async fn malformed_or_invalid_input_returns_fixed_error_before_request() {
        let mock = Mock::new(vec![]);
        let service = ProvidersService::new(Some(mock.client()));
        for invalid in [
            None,
            Some(json!("test-key")),
            Some(json!({})),
            Some(json!(["test-key"])),
        ] {
            assert_eq!(service.add(invalid).await.unwrap_err(), ERR_INVALID);
        }
        for (field, value) in [
            ("name", json!("  ")),
            ("name", json!("a,b")),
            ("name", json!("a\nb")),
            ("name", json!("a".repeat(257))),
            (
                "baseUrl",
                json!(format!("https://example.com/{}", "a".repeat(2048))),
            ),
            ("apiKey", json!(" ")),
            ("apiKey", json!("test-key\n")),
            ("apiKey", json!("test-key".repeat(513))),
            ("models", json!([])),
            ("models", json!(["  "])),
            ("models", json!(["model-a", " model-a "])),
            ("models", json!(["a,b"])),
            ("models", json!(["a\tb"])),
            ("models", json!(["a".repeat(257)])),
            ("models", json!(vec!["a"; 257])),
            ("models", json!("test-key")),
            ("unexpected", json!("test-key")),
        ] {
            let mut invalid = input();
            invalid[field] = value;
            assert_eq!(service.add(Some(invalid)).await.unwrap_err(), ERR_INVALID);
        }
        assert!(mock.finish().await.is_empty());
    }

    #[tokio::test]
    async fn add_requires_successful_post_and_verified_readback_with_fixed_errors() {
        assert_eq!(
            ProvidersService::new(None)
                .add(Some(input()))
                .await
                .unwrap_err(),
            ERR_UNAVAILABLE
        );
        let original = || response(json!({"Providers":[]}));
        let success = || response(json!({"success": true}));
        for (responses, error) in [
            (vec![(500, "test-key".into())], ERR_UNAVAILABLE),
            (vec![original(), (500, "test-key".into())], ERR_UNCONFIRMED),
            (
                vec![
                    original(),
                    response(json!({"success":false,"message":"test-key"})),
                ],
                ERR_UNCONFIRMED,
            ),
            (
                vec![original(), success(), (500, "test-key".into())],
                ERR_UNCONFIRMED,
            ),
            (vec![original(), success(), original()], ERR_UNCONFIRMED),
            (
                vec![
                    original(),
                    success(),
                    response(json!({"Providers":[entry(),entry()]})),
                ],
                ERR_UNCONFIRMED,
            ),
        ] {
            let count = responses.len();
            let mock = Mock::new(responses);
            let service = ProvidersService::new(Some(mock.client()));
            assert_eq!(service.add(Some(input())).await.unwrap_err(), error);
            assert_eq!(mock.finish().await.len(), count);
        }
        for field in ["name", "api_key", "api_base_url", "models"] {
            let mut changed = entry();
            changed.as_object_mut().unwrap().remove(field);
            let mock = Mock::new(vec![
                original(),
                success(),
                response(json!({"Providers":[changed]})),
            ]);
            let service = ProvidersService::new(Some(mock.client()));
            assert_eq!(
                service.add(Some(input())).await.unwrap_err(),
                ERR_UNCONFIRMED
            );
            assert_eq!(mock.finish().await.len(), 3);
        }
    }
}
