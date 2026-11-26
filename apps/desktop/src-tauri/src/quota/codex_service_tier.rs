use super::{codex_managed, provider_credential, QuotaService};
use crate::api::{provider_list_key, AdminClient};
use reqwest::{Method, StatusCode, Url};
use serde::{
    de::{self, IntoDeserializer, MapAccess, Visitor},
    Deserialize, Deserializer, Serialize,
};
use serde_json::{json, Value};
use std::{fmt, time::Duration};
use tauri::{ipc::InvokeBody, WebviewWindow};

const UNAVAILABLE: &str = "codex_tier_unavailable";
const UPGRADE_REQUIRED: &str = "codex_tier_upgrade_required";
const PATH: &str = "/api/codex/service-tier";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Tier {
    Follow,
    Standard,
    Priority,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct ServiceTier {
    tier: Tier,
}

// Derived deserializers also accept positional structs and object-form unit enums.
// Both the IPC body and the plugin receipt must be exactly {"tier":"..."}.
impl<'de> Deserialize<'de> for ServiceTier {
    fn deserialize<D: Deserializer<'de>>(input: D) -> Result<Self, D::Error> {
        struct TierObject;
        impl<'de> Visitor<'de> for TierObject {
            type Value = ServiceTier;

            fn expecting(&self, fmt: &mut fmt::Formatter<'_>) -> fmt::Result {
                fmt.write_str("an object with a single tier string")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut fields: A) -> Result<ServiceTier, A::Error> {
                let Some((key, value)) = fields.next_entry::<String, String>()? else {
                    return Err(de::Error::missing_field("tier"));
                };
                if key != "tier" || fields.next_key::<de::IgnoredAny>()?.is_some() {
                    return Err(de::Error::custom("expected only the tier field"));
                }
                Ok(ServiceTier {
                    tier: Tier::deserialize(value.into_deserializer())?,
                })
            }
        }
        input.deserialize_map(TierObject)
    }
}

fn main_quota_page(label: &str, url: &Url) -> bool {
    label == "main" && crate::popup::trusted_url(url)
}

fn guard(window: &WebviewWindow) -> Result<(), &'static str> {
    if window
        .url()
        .is_ok_and(|url| main_quota_page(window.label(), &url))
    {
        Ok(())
    } else {
        Err("This command is restricted to the local main window")
    }
}

async fn applicable(client: &AdminClient) -> Result<bool, &'static str> {
    let config = client.config().await.map_err(|_| UNAVAILABLE)?;
    let mut matches = config[provider_list_key(&config)]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|entry| entry["name"] == "codex-subscription");
    let Some(entry) = matches.next() else {
        return Ok(false);
    };
    Ok(matches.next().is_none()
        && matches!(entry.get("enabled"), None | Some(Value::Bool(true)))
        && codex_managed(entry, provider_credential(entry)))
}

async fn plugin_tier(
    client: &AdminClient,
    requested: Option<ServiceTier>,
) -> Result<ServiceTier, &'static str> {
    let method = if requested.is_some() {
        Method::PUT
    } else {
        Method::GET
    };
    let body = requested.map(|value| json!(value));
    let reply = client
        .send(method, PATH, body.as_ref(), Duration::from_secs(5))
        .await
        .map_err(|_| UNAVAILABLE)?;
    if reply.status() == StatusCode::NOT_FOUND {
        return Err(UPGRADE_REQUIRED);
    }
    if !reply.status().is_success() {
        return Err(UNAVAILABLE);
    }
    let confirmed: ServiceTier = reply.json().await.map_err(|_| UNAVAILABLE)?;
    if requested.is_some_and(|tier| tier != confirmed) {
        return Err(UNAVAILABLE);
    }
    Ok(confirmed)
}

impl QuotaService {
    async fn get_codex_tier(&self) -> Result<Option<ServiceTier>, &'static str> {
        let client = self.client.as_ref().ok_or(UNAVAILABLE)?;
        if !applicable(client).await? {
            return Ok(None);
        }
        plugin_tier(client, None).await.map(Some)
    }

    async fn set_codex_tier(&self, body: &InvokeBody) -> Result<ServiceTier, &'static str> {
        let InvokeBody::Json(value) = body else {
            return Err(UNAVAILABLE);
        };
        let tier = ServiceTier::deserialize(value).map_err(|_| UNAVAILABLE)?;
        let client = self.client.as_ref().ok_or(UNAVAILABLE)?;
        let _write = client.write_guard().await;
        if !applicable(client).await? {
            return Err(UNAVAILABLE);
        }
        plugin_tier(client, Some(tier)).await
    }
}

#[tauri::command]
pub(crate) async fn codex_service_tier_get(
    window: WebviewWindow,
    service: tauri::State<'_, QuotaService>,
) -> Result<Option<ServiceTier>, &'static str> {
    guard(&window)?;
    service.get_codex_tier().await
}

#[tauri::command]
pub(crate) async fn codex_service_tier_set(
    window: WebviewWindow,
    service: tauri::State<'_, QuotaService>,
    request: tauri::ipc::Request<'_>,
) -> Result<ServiceTier, &'static str> {
    guard(&window)?;
    service.set_codex_tier(request.body()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::mock::{response, Mock};

    fn config() -> Value {
        json!({"Providers":[{"name":"codex-subscription","codex_managed":true}]})
    }

    #[test]
    fn requires_main_label_and_exact_local_quota_url() {
        let url: Url = if cfg!(windows) {
            "http://tauri.localhost/quota.html"
        } else {
            "tauri://localhost/quota.html"
        }
        .parse()
        .unwrap();
        assert!(main_quota_page("main", &url));
        assert!(!main_quota_page("quota", &url));
        for other in [
            url.join("?x").unwrap(),
            url.join("#x").unwrap(),
            url.join("index.html").unwrap(),
            "https://example.com/quota.html".parse().unwrap(),
        ] {
            assert!(!main_quota_page("main", &other));
        }
    }

    #[tokio::test]
    async fn reads_and_saves_only_the_tier_with_fixed_authenticated_routes() {
        for (marker, name) in [
            (json!({"codex_managed":true}), "follow"),
            (json!({"codexManaged":true}), "standard"),
            (json!({"api_key":"ccr-managed-codex"}), "priority"),
            (json!({"apiKey":"ccr-managed-codex"}), "follow"),
        ] {
            let mut entry = marker;
            entry["name"] = json!("codex-subscription");
            entry["enabled"] = json!(true);
            let config = response(json!({"providers":[entry]}));
            let tier = json!({"tier":name});
            let reply = response(tier.clone());
            let mock = Mock::new(vec![config.clone(), reply.clone(), config, reply]);
            let service = QuotaService::new(Some(mock.client()));
            assert_eq!(json!(service.get_codex_tier().await.unwrap()), tier);
            assert_eq!(
                json!(service.set_codex_tier(&tier.clone().into()).await.unwrap()),
                tier
            );
            let requests = mock.finish().await;
            for (request, line) in requests.iter().zip([
                "GET /api/config ",
                "GET /api/codex/service-tier ",
                "GET /api/config ",
                "PUT /api/codex/service-tier ",
            ]) {
                assert!(request.starts_with(line));
                assert!(request
                    .to_lowercase()
                    .contains("x-api-key: test-admin-key\r\n"));
            }
            assert!(requests[1].ends_with("\r\n\r\n"));
            assert_eq!(
                requests[3].split_once("\r\n\r\n").unwrap().1,
                tier.to_string()
            );
        }
    }

    #[tokio::test]
    async fn config_must_contain_exactly_one_enabled_managed_codex() {
        let managed = config()["Providers"][0].clone();
        let plain = json!({"name":"codex-subscription","ccr_managed":true});
        for entries in [
            json!([]),
            json!([plain]),
            json!([{"name":"other","codexManaged":true}]),
            json!([managed, plain]),
            json!([plain, managed]),
            json!([managed, managed]),
            json!([{"name":"codex-subscription","codexManaged":true,"enabled":false}]),
            json!([{"name":"codex-subscription","codexManaged":true,"enabled":"true"}]),
        ] {
            let config = response(json!({"Providers":entries}));
            let mock = Mock::new(vec![config.clone(), config]);
            let service = QuotaService::new(Some(mock.client()));
            assert_eq!(service.get_codex_tier().await, Ok(None));
            assert_eq!(
                service
                    .set_codex_tier(&json!({"tier":"priority"}).into())
                    .await,
                Err(UNAVAILABLE)
            );
            assert!(mock
                .finish()
                .await
                .iter()
                .all(|r| r.starts_with("GET /api/config ")));
        }
    }

    #[tokio::test]
    async fn invalid_ipc_arguments_never_reach_transport() {
        // If validation accidentally reaches the transport, the config sentinel will be consumed.
        let mock = Mock::new(vec![response(config()), response(json!({"tier":"follow"}))]);
        let service = QuotaService::new(Some(mock.client()));
        for body in [
            json!("priority").into(),
            json!(["priority"]).into(),
            json!({}).into(),
            json!({"tier":null}).into(),
            json!({"tier":0}).into(),
            json!({"tier":"fast"}).into(),
            json!({"tier":{"priority":null}}).into(),
            json!({"tier":"priority","extra":true}).into(),
            InvokeBody::Raw(vec![]),
        ] {
            assert_eq!(service.set_codex_tier(&body).await, Err(UNAVAILABLE));
        }
        assert_eq!(
            json!(service.get_codex_tier().await.unwrap()),
            json!({"tier":"follow"})
        );
        assert_eq!(mock.finish().await.len(), 2);
    }

    #[tokio::test]
    async fn only_plugin_404_requires_upgrade_and_save_must_confirm_requested_tier() {
        let body = json!({"tier":"priority"}).into();
        for (reply, expected) in [
            ((404, "old route".into()), UPGRADE_REQUIRED),
            ((401, "secret".into()), UNAVAILABLE),
            ((500, "secret".into()), UNAVAILABLE),
            ((200, "invalid json".into()), UNAVAILABLE),
            (response(json!({"tier":"other"})), UNAVAILABLE),
            (response(json!(["priority"])), UNAVAILABLE),
            (
                response(json!({"tier":"follow","secret":true})),
                UNAVAILABLE,
            ),
            (
                (200, r#"{"tier":"follow","tier":"priority"}"#.into()),
                UNAVAILABLE,
            ),
        ] {
            let mock = Mock::new(vec![
                response(config()),
                reply.clone(),
                response(config()),
                reply,
            ]);
            let service = QuotaService::new(Some(mock.client()));
            assert_eq!(service.get_codex_tier().await, Err(expected));
            assert_eq!(service.set_codex_tier(&body).await, Err(expected));
            assert_eq!(mock.finish().await.len(), 4);
        }
        let mock = Mock::new(vec![
            response(config()),
            response(json!({"tier":"standard"})),
            (404, "secret".into()),
            (404, "secret".into()),
        ]);
        let service = QuotaService::new(Some(mock.client()));
        assert_eq!(service.set_codex_tier(&body).await, Err(UNAVAILABLE));
        assert_eq!(service.get_codex_tier().await, Err(UNAVAILABLE));
        assert_eq!(service.set_codex_tier(&body).await, Err(UNAVAILABLE));
        let requests = mock.finish().await;
        assert!(requests[2..]
            .iter()
            .all(|r| r.starts_with("GET /api/config ")));
    }

    #[tokio::test]
    async fn save_waits_for_shared_write_guard_before_reading_current_config() {
        let mock = Mock::new(vec![response(json!({"Providers":[]}))]);
        let client = mock.client();
        let service = QuotaService::new(Some(client.clone()));
        let held = client.write_guard().await;
        let body = json!({"tier":"standard"}).into();
        let save = service.set_codex_tier(&body);
        tokio::pin!(save);
        assert!(tokio::time::timeout(Duration::from_millis(50), &mut save)
            .await
            .is_err());
        drop(held);
        assert_eq!(save.await, Err(UNAVAILABLE));
        assert_eq!(mock.finish().await.len(), 1);
    }
}
