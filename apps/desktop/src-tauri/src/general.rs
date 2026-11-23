//! Manual saves use the raw GET /api/config document, which retains literal credentials and
//! environment placeholders. POST may normalize unrelated provider data. Verify the edited
//! leaves on the existing loopback connection. The current gateway trusts loopback admin
//! requests (ccr/auth.ts). A new port or connection key is discovered on desktop relaunch.

use crate::{api::AdminClient, control::revision_of};
use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::WebviewWindow;

const STALE: &str = "Settings draft is stale; refresh the panel and retry";
const FORMAT: &str = "This setting uses an unsupported configuration format";
const UNCONFIRMED: &str = "Settings save could not be confirmed. Check the gateway connection and refresh before retrying.";
const PROXY_KEYS: [&str; 4] = ["HTTPS_PROXY", "https_proxy", "httpsProxy", "PROXY_URL"];
const LOG_LEVELS: [&str; 6] = ["fatal", "error", "warn", "info", "debug", "trace"];

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GeneralSettingsSnapshot {
    revision: String,
    values: Map<String, Value>,
    port_from_env: bool,
    api_key_configured: bool,
    proxy_configured: bool,
}

/// `plugins` takes precedence over `Plugins` in core's plugin-registration.ts. New
/// configs use the Web spelling. Refuse ambiguous duplicate entries for a targeted edit.
fn plugins_key(config: &Value) -> &'static str {
    if config
        .get("plugins")
        .is_some_and(|v| !v.is_null() && v != false && v != "" && v.as_f64() != Some(0.0))
    {
        "plugins"
    } else {
        "Plugins"
    }
}

fn token_speed(entry: &Value) -> bool {
    entry["name"] == "token-speed"
}

fn token_entry(config: &Value) -> Option<&Value> {
    config[plugins_key(config)]
        .as_array()?
        .iter()
        .rfind(|e| token_speed(e))
}

// Defaults match the General tab in packages/ui/src/components/SettingsPage.tsx.
fn defaults() -> Value {
    json!({
        "LOG": false, "LOG_LEVEL": "error", "statusLineEnabled": false,
        "tokenSpeedEnabled": false, "disableAttributionHeader": true,
        "enableConcurrencyPriority": false, "concurrencyThreshold": 3,
        "WAKEUP_ENABLED": false, "WAKEUP_TIME": "06:00", "CLAUDE_PATH": "",
        "HOST": "", "PORT": 3456, "API_TIMEOUT_MS": 600000, "PROBE_TIMEOUT_MS": 15000,
        "PROBE_SLOW_THRESHOLD_MS": 3000, "ContextWindow": 200000,
        "PROXY_GLOBAL_ENABLED": true, "CUSTOM_ROUTER_PATH": ""
    })
}

fn leaf<'a>(config: &'a Value, key: &str) -> Option<&'a Value> {
    match key {
        "statusLineEnabled" => config.pointer("/StatusLine/enabled"),
        "tokenSpeedEnabled" => {
            let entry = token_entry(config)?;
            entry
                .pointer("/options/enabled")
                .or_else(|| entry.get("enabled"))
        }
        "enableConcurrencyPriority" | "concurrencyThreshold" => config["Router"].get(key),
        _ => config.get(key),
    }
}

fn valid_time(text: &str) -> bool {
    matches!(text.as_bytes(), [a @ b'0'..=b'2', b @ b'0'..=b'9', b':', b'0'..=b'5', b'0'..=b'9'] if *a < b'2' || *b <= b'3')
}

fn valid_proxy(text: &str) -> bool {
    // Core permits raw $VAR and ${VAR} placeholders before runtime interpolation.
    text.is_empty()
        || text.split('$').skip(1).any(|tail| {
            tail.starts_with(|c: char| c.is_ascii_uppercase() || c == '_')
                || tail
                    .strip_prefix('{')
                    .and_then(|s| s.split_once('}'))
                    .is_some_and(|(name, _)| !name.is_empty())
        })
        || reqwest::Url::parse(text)
            .is_ok_and(|url| matches!(url.scheme(), "http" | "https") && url.host().is_some())
}

fn valid_host(host: &str) -> bool {
    host.is_empty()
        || host.parse::<std::net::IpAddr>().is_ok()
        || (host.len() <= 253
            && host
                .strip_suffix('.')
                .unwrap_or(host)
                .split('.')
                .all(|part| {
                    !part.is_empty()
                        && part.len() <= 63
                        && !part.starts_with('-')
                        && !part.ends_with('-')
                        && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                }))
}

fn valid_value(key: &str, value: &Value) -> bool {
    match key {
        "LOG"
        | "statusLineEnabled"
        | "tokenSpeedEnabled"
        | "disableAttributionHeader"
        | "enableConcurrencyPriority"
        | "WAKEUP_ENABLED"
        | "PROXY_GLOBAL_ENABLED" => value.is_boolean(),
        "PORT"
        | "API_TIMEOUT_MS"
        | "PROBE_TIMEOUT_MS"
        | "PROBE_SLOW_THRESHOLD_MS"
        | "ContextWindow"
        | "concurrencyThreshold" => value.as_u64().is_some_and(|n| {
            let max = match key {
                "PORT" => u16::MAX as u64,
                _ => i32::MAX as u64,
            };
            (1..=max).contains(&n)
        }),
        _ => value.as_str().is_some_and(|s| {
            s.len() <= 4096
                && !s.chars().any(char::is_control)
                && match key {
                    "CLAUDE_PATH" | "CUSTOM_ROUTER_PATH" => true,
                    "HOST" => valid_host(s),
                    "WAKEUP_TIME" => valid_time(s),
                    "LOG_LEVEL" => LOG_LEVELS.contains(&s),
                    "APIKEY" => s.trim() == s && reqwest::header::HeaderValue::from_str(s).is_ok(),
                    "PROXY_URL" => s.trim() == s && valid_proxy(s),
                    _ => false,
                }
        }),
    }
}

fn effective(config: &Value, key: &str, default: &Value) -> Value {
    let Some(raw) = leaf(config, key) else {
        return default.clone();
    };
    if valid_value(key, raw) {
        return raw.clone();
    }
    if default.is_number() {
        if let Some(n) = raw.as_str().and_then(|s| s.trim().parse::<u64>().ok()) {
            let n = Value::from(n);
            if valid_value(key, &n) {
                return n;
            }
        }
    }
    match key {
        "PROXY_GLOBAL_ENABLED" => json!(raw.as_str().map_or(raw != &json!(0), |s| !matches!(
            s.trim().to_ascii_lowercase().as_str(),
            "false" | "0"
        ))),
        "WAKEUP_ENABLED" => json!(raw == "true" || raw == "1" || raw == &json!(1)),
        _ => default.clone(),
    }
}

// Recognize $NAME and ${NAME} in the raw PORT without resolving or exposing the name.
fn port_from_env(config: &Value) -> bool {
    config["PORT"].as_str().is_some_and(|port| {
        port.match_indices('$').any(|(index, _)| {
            let tail = &port[index + 1..];
            tail.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
                || tail
                    .strip_prefix('{')
                    .and_then(|s| s.split_once('}'))
                    .is_some_and(|(name, _)| !name.is_empty())
        })
    })
}

fn snapshot_from(config: &Value) -> GeneralSettingsSnapshot {
    let mut values = defaults().as_object().unwrap().clone();
    let port_from_env = port_from_env(config);
    if port_from_env {
        values.remove("PORT");
    }
    for (key, value) in &mut values {
        *value = effective(config, key, value);
    }
    let configured = |key: &str| config[key].as_str().is_some_and(|s| !s.trim().is_empty());
    GeneralSettingsSnapshot {
        revision: revision_of(config),
        values,
        port_from_env,
        api_key_configured: configured("APIKEY"),
        proxy_configured: PROXY_KEYS.into_iter().any(configured),
    }
}

fn apply(config: &mut Value, key: &str, value: &Value) -> Result<(), String> {
    let plugin_key = plugins_key(config);
    let root = config.as_object_mut().ok_or(FORMAT)?;
    match key {
        "statusLineEnabled" | "enableConcurrencyPriority" | "concurrencyThreshold" => {
            let (parent, name) = if key == "statusLineEnabled" {
                ("StatusLine", "enabled")
            } else {
                ("Router", key)
            };
            root.entry(parent)
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .ok_or(FORMAT)?
                .insert(name.into(), value.clone());
        }
        "tokenSpeedEnabled" => {
            let entries = root
                .entry(plugin_key)
                .or_insert_with(|| json!([]))
                .as_array_mut()
                .ok_or(FORMAT)?;
            let mut matches = entries.iter_mut().filter(|e| token_speed(e));
            if let Some(entry) = matches.next() {
                if matches.next().is_some() || entry.pointer("/options/enabled").is_some() {
                    return Err(FORMAT.into());
                }
                entry["enabled"] = value.clone();
            } else {
                entries.push(json!({"name":"token-speed", "enabled":value}));
            }
        }
        "PROXY_URL" | "APIKEY" if value == "" => {
            root.remove(key);
        }
        _ => {
            root.insert(key.into(), value.clone());
        }
    }
    Ok(())
}

fn confirmed(config: &Value, key: &str, value: &Value) -> bool {
    let stored = leaf(config, key);
    if matches!(key, "PROXY_URL" | "APIKEY") && value == "" {
        stored.is_none_or(|raw| raw.is_null() || raw == "")
    } else {
        stored == Some(value)
    }
}

pub struct GeneralService {
    client: Option<AdminClient>,
}

impl GeneralService {
    pub fn new(client: Option<AdminClient>) -> Self {
        Self { client }
    }
    fn client(&self) -> Result<&AdminClient, String> {
        self.client
            .as_ref()
            .ok_or_else(|| "Gateway connection is unavailable".into())
    }
    async fn save(
        &self,
        revision: &str,
        changes: &Value,
    ) -> Result<GeneralSettingsSnapshot, String> {
        let changes = changes
            .as_object()
            .ok_or("Invalid general settings changes")?;
        if !changes.iter().all(|(k, v)| valid_value(k, v)) {
            return Err("Invalid general settings changes".into());
        }
        let client = self.client()?;
        let _write = client.write_guard().await;
        let mut config = client.config().await?;
        if revision != revision_of(&config) {
            return Err(STALE.into());
        }
        if changes.iter().all(|(k, v)| confirmed(&config, k, v)) {
            return Ok(snapshot_from(&config));
        }
        for (key, value) in changes {
            if !confirmed(&config, key, value) {
                apply(&mut config, key, value)?;
            }
        }
        let verified = client
            .post_config_and_readback(&config)
            .await
            .map_err(|_| UNCONFIRMED)?;
        if !changes.iter().all(|(k, v)| confirmed(&verified, k, v)) {
            return Err(UNCONFIRMED.into());
        }
        Ok(snapshot_from(&verified))
    }
}

#[tauri::command]
pub async fn general_settings_snapshot(
    window: WebviewWindow,
    service: tauri::State<'_, GeneralService>,
) -> Result<GeneralSettingsSnapshot, String> {
    crate::popup::guard(&window)?;
    Ok(snapshot_from(&service.client()?.config().await?))
}

#[tauri::command]
pub async fn general_settings_save(
    window: WebviewWindow,
    service: tauri::State<'_, GeneralService>,
    revision: String,
    changes: Value,
) -> Result<GeneralSettingsSnapshot, String> {
    crate::popup::guard(&window)?;
    service.save(&revision, &changes).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::mock::{response, Mock};

    #[test]
    fn web_defaults_and_legacy_projection_expose_only_public_scalars() {
        let raw = json!({
            "APIKEY": "private-admin", "HTTPS_PROXY": "http://user:private-proxy@proxy.invalid",
            "PORT": "$PRIVATE_PORT_NAME", "Router": {"concurrencyThreshold": "9"}, "API_TIMEOUT_MS": "7000",
            "WAKEUP_ENABLED": "1", "PROXY_GLOBAL_ENABLED": "False", "StatusLine": ["private-status"],
            "Plugins": [{"name":"token-speed", "enabled":true, "options":{"token":"private-plugin"}}],
            "Providers": [{"api_key":"private-provider"}]
        });
        let snapshot = serde_json::to_value(snapshot_from(&raw)).unwrap();
        assert_eq!(
            snapshot,
            json!({
                "revision": revision_of(&raw), "portFromEnv":true, "apiKeyConfigured":true, "proxyConfigured":true,
                "values": {
                    "LOG":false, "LOG_LEVEL":"error", "statusLineEnabled":false, "tokenSpeedEnabled":true,
                    "disableAttributionHeader":true, "enableConcurrencyPriority":false, "concurrencyThreshold":9,
                    "WAKEUP_ENABLED":true, "WAKEUP_TIME":"06:00", "CLAUDE_PATH":"", "HOST":"",
                    "API_TIMEOUT_MS":7000, "PROBE_TIMEOUT_MS":15000, "PROBE_SLOW_THRESHOLD_MS":3000,
                    "ContextWindow":200000, "PROXY_GLOBAL_ENABLED":false, "CUSTOM_ROUTER_PATH":""
                }
            })
        );
        assert!(!snapshot.to_string().contains("private-"));
        for port in ["${PRIVATE_PORT_NAME}", "$private_port", "34$PORT_SUFFIX"] {
            let projection = snapshot_from(&json!({"PORT":port}));
            assert!(projection.port_from_env);
            assert!(!projection.values.contains_key("PORT"));
        }
        let numeric = snapshot_from(&json!({"PORT":"4000"}));
        assert!(!numeric.port_from_env);
        assert_eq!(numeric.values["PORT"], 4000);
        let empty = snapshot_from(&json!({}));
        assert!(!empty.port_from_env);
        assert_eq!(empty.values["PORT"], 3456);
        assert_eq!(empty.values["API_TIMEOUT_MS"], 600000);
        assert_eq!(empty.values["concurrencyThreshold"], 3);
        assert_eq!(empty.values["PROXY_GLOBAL_ENABLED"], true);
        assert_eq!(empty.values["WAKEUP_ENABLED"], false);
        assert!(!empty.api_key_configured && !empty.proxy_configured);
    }

    #[tokio::test]
    async fn fresh_save_merges_only_submitted_leaves_and_verifies_on_same_connection() {
        let original = json!({
            "StatusLine":{"enabled":true,"custom":{"modules":["other"]}},
            "plugins":[{"name":"other"},{"name":"token-speed","options":{"keep":true}}],
            "Plugins":["legacy-shadowed"], "Router":{"default":"provider,model","families":{}},
            "APIKEY":"$OLD", "PROXY_URL":"$PROXY", "PORT":"${PRIVATE_PORT_NAME}", "Providers":[{"api_key":"$TOKEN"}]
        });
        let edits = json!({"statusLineEnabled":false,"tokenSpeedEnabled":true,"enableConcurrencyPriority":true,
            "concurrencyThreshold":4,"APIKEY":"new-test-key","PORT":3456});
        assert!(snapshot_from(&original).port_from_env);
        let mut expected = original.clone();
        expected["StatusLine"]["enabled"] = json!(false);
        expected["plugins"][1]["enabled"] = json!(true);
        expected["Router"]["enableConcurrencyPriority"] = json!(true);
        expected["Router"]["concurrencyThreshold"] = json!(4);
        expected["APIKEY"] = json!("new-test-key");
        expected["PORT"] = json!(3456);
        let mut readback = expected.clone();
        readback["Providers"][0]["normalized"] = json!(true);
        let mock = Mock::new(vec![
            response(original.clone()),
            response(json!({"success":true})),
            response(readback.clone()),
        ]);
        let result = GeneralService::new(Some(mock.client()))
            .save(&revision_of(&original), &edits)
            .await
            .unwrap();
        assert!(!result.port_from_env);
        assert_eq!(result.values["PORT"], 3456);
        assert_eq!(result.revision, revision_of(&readback));
        assert!(result.api_key_configured && result.proxy_configured);
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains("new-test-key"));
        let requests = mock.finish().await;
        assert_eq!(requests.len(), 3);
        for (request, method) in requests.iter().zip(["GET", "POST", "GET"]) {
            assert!(request.starts_with(&format!("{method} /api/config ")));
            assert!(request
                .to_lowercase()
                .contains("x-api-key: test-admin-key\r\n"));
        }
        let body = requests[1].split_once("\r\n\r\n").unwrap().1;
        assert_eq!(serde_json::from_str::<Value>(body).unwrap(), expected);
    }

    #[tokio::test]
    async fn explicit_secret_clear_preserves_aliases_and_legacy_fields() {
        let original = json!({"APIKEY":"test-key", "PROXY_URL":"http://test.invalid", "HTTPS_PROXY":"$ALIAS",
            "PORT":"$PORT", "Plugins":{"custom":true}, "StatusLine":[1], "Router":"$ROUTES"});
        let mut expected = original.clone();
        for key in ["APIKEY", "PROXY_URL"] {
            expected.as_object_mut().unwrap().remove(key);
        }
        let mut readback = expected.clone();
        readback["APIKEY"] = json!("");
        let mock = Mock::new(vec![
            response(original.clone()),
            response(json!({"success":true})),
            response(readback),
        ]);
        let result = GeneralService::new(Some(mock.client()))
            .save(
                &revision_of(&original),
                &json!({"APIKEY":"", "PROXY_URL":""}),
            )
            .await
            .unwrap();
        assert!(result.port_from_env);
        assert!(!result.values.contains_key("PORT"));
        assert!(!result.api_key_configured && result.proxy_configured);
        let requests = mock.finish().await;
        let body = requests[1].split_once("\r\n\r\n").unwrap().1;
        assert_eq!(serde_json::from_str::<Value>(body).unwrap(), expected);
    }

    #[tokio::test]
    async fn stale_unsupported_and_invalid_drafts_do_not_write() {
        let raw = json!({"Plugins":{}, "StatusLine":[1], "Router":"legacy"});
        let revision = revision_of(&raw);
        for (edits, rev, err) in [
            (json!({"LOG":true}), "stale", STALE),
            (json!({"tokenSpeedEnabled":true}), revision.as_str(), FORMAT),
            (json!({"statusLineEnabled":true}), revision.as_str(), FORMAT),
            (json!({"concurrencyThreshold":5}), revision.as_str(), FORMAT),
        ] {
            let mock = Mock::new(vec![response(raw.clone())]);
            assert_eq!(
                GeneralService::new(Some(mock.client()))
                    .save(rev, &edits)
                    .await
                    .unwrap_err(),
                err
            );
            assert_eq!(mock.finish().await.len(), 1);
        }
        let mock = Mock::new(vec![]);
        let service = GeneralService::new(Some(mock.client()));
        for edits in [
            json!("secret"),
            json!({"Providers":[]}),
            json!({"LOG":"true"}),
            json!({"PORT":"3456"}),
            json!({"PORT":65536}),
            json!({"PROBE_TIMEOUT_MS":0}),
            json!({"ContextWindow":1.5}),
            json!({"concurrencyThreshold":-1}),
            json!({"LOG_LEVEL":"silent"}),
            json!({"WAKEUP_TIME":"23:60"}),
            json!({"APIKEY":null}),
            json!({"APIKEY":"secret\n"}),
            json!({"PROXY_URL":"ftp://secret"}),
            json!({"PROXY_URL":" "}),
            json!({"HOST":"x:1234/path"}),
        ] {
            assert_eq!(
                service.save(&revision, &edits).await.unwrap_err(),
                "Invalid general settings changes"
            );
        }
        assert!(mock.finish().await.is_empty());
    }

    #[tokio::test]
    async fn gateway_failure_and_readback_mismatch_have_safe_recovery_message() {
        let raw = json!({"APIKEY":"old-key"});
        for replies in [
            vec![response(raw.clone()), (400, "secret backend detail".into())],
            vec![
                response(raw.clone()),
                response(json!({"success":false,"message":"secret"})),
            ],
            vec![
                response(raw.clone()),
                response(json!({"success":true})),
                (401, "secret".into()),
            ],
            vec![
                response(raw.clone()),
                response(json!({"success":true})),
                response(raw.clone()),
            ],
        ] {
            let len = replies.len();
            let mock = Mock::new(replies);
            assert_eq!(
                GeneralService::new(Some(mock.client()))
                    .save(&revision_of(&raw), &json!({"APIKEY":"new-key"}))
                    .await
                    .unwrap_err(),
                UNCONFIRMED
            );
            assert_eq!(mock.finish().await.len(), len);
        }
    }

    #[test]
    fn creates_missing_structures_and_supports_all_fields() {
        let mut config = json!({});
        let edits = json!({
            "APIKEY":"", "PROXY_URL":"${CORP_PROXY}", "LOG":true, "LOG_LEVEL":"warn",
            "statusLineEnabled":true, "tokenSpeedEnabled":true, "enableConcurrencyPriority":true,
            "disableAttributionHeader":false, "concurrencyThreshold":5,"WAKEUP_ENABLED":true,
            "WAKEUP_TIME":"23:59", "CLAUDE_PATH":"/opt/custom claude", "HOST":"127.0.0.1", "PORT":65535,
            "API_TIMEOUT_MS":3600000, "PROBE_TIMEOUT_MS":9000, "PROBE_SLOW_THRESHOLD_MS":700,
            "ContextWindow":1000000, "PROXY_GLOBAL_ENABLED":false, "CUSTOM_ROUTER_PATH":"/opt/router.js"
        });
        for (key, value) in edits.as_object().unwrap() {
            assert!(valid_value(key, value), "{key}");
            apply(&mut config, key, value).unwrap();
            assert!(confirmed(&config, key, value), "{key}");
        }
        let snapshot = snapshot_from(&config);
        for (key, value) in snapshot.values {
            assert_eq!(value, edits[key.as_str()]);
        }
        assert_eq!(
            config["Plugins"],
            json!([{"name":"token-speed","enabled":true}])
        );
        assert_eq!(config["StatusLine"], json!({"enabled":true}));
        assert_eq!(
            config["Router"],
            json!({"enableConcurrencyPriority":true,"concurrencyThreshold":5})
        );
    }
}
