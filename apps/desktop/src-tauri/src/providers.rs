//! Add and edit ordinary API providers through the gateway's raw config endpoint.

use crate::api::AdminClient;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use tauri::WebviewWindow;

const ERR_INVALID: &str = "PROVIDER_INVALID";
const ERR_DUPLICATE: &str = "PROVIDER_DUPLICATE";
const ERR_MANAGED: &str = "PROVIDER_MANAGED";
const ERR_UNAVAILABLE: &str = "PROVIDER_UNAVAILABLE";
const ERR_UNCONFIRMED: &str = "PROVIDER_SAVE_UNCONFIRMED";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderInput {
    name: String,
    base_url: String,
    #[serde(default)]
    api_key: String,
    models: Vec<String>,
    #[serde(default, deserialize_with = "TransformerChange::deserialize")]
    transformer: TransformerChange,
}

#[derive(Serialize, Debug)]
pub struct SavedProvider {
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

// Check the raw query: returning the original URL also returns its original bytes.
fn safe_version_query(query: &str) -> bool {
    let Some((key, value)) = query.split_once('=') else {
        return false;
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    match key {
        "version" => {
            value.split('.').count() <= 3
                && value.split('.').all(|part| part.len() <= 3 && digits(part))
        }
        "api-version" => {
            let date = value.strip_suffix("-preview").unwrap_or(value);
            date.len() == 10
                && date.as_bytes()[4] == b'-'
                && date.as_bytes()[7] == b'-'
                && date.split('-').all(digits)
                && time::Date::parse(date, &time::format_description::well_known::Iso8601::DATE)
                    .is_ok()
        }
        _ => false,
    }
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
        || value
            .split_once('?')
            .is_some_and(|(_, query)| !safe_version_query(query))
    {
        return Err(ERR_INVALID);
    }
    Ok(value)
}

const MAX_TRANSFORMER_CHAIN: usize = 8;

fn transformer_name(value: &Value) -> Option<&str> {
    let raw = value.as_str()?;
    let name = raw.trim();
    (!name.is_empty() && name.chars().count() <= 64 && !raw.chars().any(char::is_control))
        .then_some(name)
}

#[derive(Default)]
enum TransformerChange {
    #[default]
    Keep,
    Remove,
    Set(Vec<Value>),
}

impl TransformerChange {
    fn deserialize<'de, D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(de)?;
        if value.is_null() {
            return Ok(Self::Remove);
        }
        Self::parse_chain(value).ok_or_else(|| serde::de::Error::custom(ERR_INVALID))
    }

    fn parse_chain(value: Value) -> Option<Self> {
        let mut object = match value {
            Value::Object(object) if object.len() == 1 => object,
            _ => return None,
        };
        let Value::Array(mut chain) = object.remove("use")? else {
            return None;
        };
        if !(1..=MAX_TRANSFORMER_CHAIN).contains(&chain.len()) {
            return None;
        }
        for element in &mut chain {
            let name = match element {
                Value::String(_) => element,
                Value::Array(tuple)
                    if tuple.len() == 2
                        && tuple[1].is_object()
                        && serde_json::to_vec(&tuple[1]).ok()?.len() <= 2048 =>
                {
                    &mut tuple[0]
                }
                _ => return None,
            };
            *name = json!(transformer_name(name)?);
        }
        Some(Self::Set(chain))
    }

    fn apply(&self, entry: &mut Value) -> Result<(), &'static str> {
        match self {
            Self::Keep => (),
            Self::Set(chain) => {
                if !entry["transformer"].is_object() {
                    entry["transformer"] = json!({});
                }
                entry["transformer"]["use"] = json!(chain);
            }
            Self::Remove => {
                let fields = entry.as_object_mut().ok_or(ERR_UNAVAILABLE)?;
                match fields.get_mut("transformer") {
                    Some(Value::Object(transformer)) => {
                        transformer.remove("use");
                        if transformer.is_empty() {
                            fields.remove("transformer");
                        }
                    }
                    None => (),
                    Some(_) => {
                        fields.remove("transformer");
                    }
                }
            }
        }
        Ok(())
    }
}

#[derive(Serialize)]
struct TransformerSummary {
    #[serde(rename = "use")]
    names: Vec<String>,
}

// Only names cross IPC. Tuple parameters and model-specific chains stay in the config.
fn transformer_summary(entry: &Value) -> (Option<TransformerSummary>, bool) {
    let Some(transformer) = entry.get("transformer").filter(|value| !value.is_null()) else {
        return (None, false);
    };
    let Some(chain) = transformer.get("use") else {
        return (None, !transformer.is_object());
    };
    let Some(chain) = chain.as_array() else {
        return (None, true);
    };
    let mut protected = !(1..=MAX_TRANSFORMER_CHAIN).contains(&chain.len());
    let mut names = Vec::new();
    for element in chain.iter().take(MAX_TRANSFORMER_CHAIN) {
        let name = match element {
            Value::Array(tuple) => {
                protected = true;
                tuple.first().and_then(transformer_name)
            }
            other => transformer_name(other),
        };
        if let Some(name) = name {
            names.push(name.to_owned());
        } else {
            protected = true;
        }
    }
    (Some(TransformerSummary { names }), protected)
}

impl ProviderInput {
    fn parse(input: Option<Value>) -> Result<Self, &'static str> {
        // Deserialize here so malformed IPC values never surface in framework errors.
        let mut provider: Self =
            serde_json::from_value(input.ok_or(ERR_INVALID)?).map_err(|_| ERR_INVALID)?;
        provider.name = identifier(&provider.name)?.to_owned();
        provider.base_url = endpoint(&provider.base_url)?.to_owned();
        if !provider.api_key.is_empty() {
            provider.api_key = bounded_text(&provider.api_key, 4096)?.to_owned();
        }
        if provider.models.is_empty() || provider.models.len() > 256 {
            return Err(ERR_INVALID);
        }
        let mut seen = HashSet::new();
        for model in &mut provider.models {
            *model = identifier(model)?.to_owned();
            if !seen.insert(model.as_str()) {
                return Err(ERR_INVALID);
            }
        }
        Ok(provider)
    }

    fn apply(&self, entry: &mut Value) -> Result<(), &'static str> {
        entry["api_base_url"] = json!(self.base_url);
        entry["models"] = json!(self.models);
        if !self.api_key.is_empty() {
            entry["api_key"] = json!(self.api_key);
        }
        self.transformer.apply(entry)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDetails {
    name: String,
    base_url: String,
    models: Vec<String>,
    managed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    transformer: Option<TransformerSummary>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    transformer_protected: bool,
}

// The runtime also treats aliases on a plugin's fixed origin and chain as managed.
fn has_managed_transport(entry: &Value) -> bool {
    let Some(chain) = entry["transformer"]["use"].as_array() else {
        return false;
    };
    ["api_base_url", "baseUrl"]
        .iter()
        .filter_map(|field| entry[*field].as_str())
        .filter_map(|base| reqwest::Url::parse(base).ok())
        .any(|url| {
            let plugin = match url.host_str() {
                Some("chatgpt.com")
                    if url.path() == "/backend-api/codex"
                        || url.path().starts_with("/backend-api/codex/") =>
                {
                    "codex"
                }
                Some("daily-cloudcode-pa.googleapis.com") => "gemini-oauth",
                Some("copilot.tencent.com" | "www.workbuddy.ai" | "www.codebuddy.ai") => {
                    "workbuddy"
                }
                _ => return false,
            };
            chain.iter().any(|item| {
                item == plugin
                    || item["name"] == plugin
                    || item.get(0).is_some_and(|name| name == plugin)
            })
        })
}

fn is_managed(entry: &Value) -> bool {
    // Plugin config flags exist in both raw (snake_case) and legacy camelCase forms.
    const FLAGS: &[&str] = &[
        "ccr_managed",
        "pluginManaged",
        "workbuddyManaged",
        "codex_managed",
        "codexManaged",
        "gemini_oauth_managed",
        "geminiOauthManaged",
        "grok_managed",
        "grokManaged",
        "kiro_managed",
        "kiroManaged",
        "qoder_managed",
        "qoderManaged",
        "cursor_managed",
        "cursorManaged",
    ];
    let workbuddy_site =
        |key: &str| matches!(entry[key].as_str(), Some("workbuddy" | "workbuddy-ai"));
    entry["name"] == "ccr"
        || FLAGS.iter().any(|key| entry[*key] == true)
        || ["api_key", "apiKey"].iter().any(|key| {
            entry[*key]
                .as_str()
                .is_some_and(|key| key.starts_with("ccr-managed-"))
        })
        || (workbuddy_site("name") && workbuddy_site("workbuddy_kind"))
        || (entry["name"] == "gemini-oauth"
            && ["gemini_oauth_kind", "geminiOauthKind"]
                .iter()
                .any(|field| entry[*field] == "antigravity"))
        || has_managed_transport(entry)
}

fn selector(name: &Option<Value>) -> Result<&str, &'static str> {
    identifier(name.as_ref().and_then(Value::as_str).ok_or(ERR_INVALID)?)
}

fn entry_index(entries: &[Value], name: &str) -> Result<usize, &'static str> {
    let mut matching = entries
        .iter()
        .enumerate()
        .filter(|(_, p)| p["name"].as_str().map(str::trim) == Some(name));
    let (index, _) = matching.next().ok_or(ERR_UNAVAILABLE)?;
    if matching.next().is_some() {
        return Err(ERR_UNAVAILABLE);
    }
    Ok(index)
}

fn same_name(entry: &Value, folded: &str) -> bool {
    entry["name"]
        .as_str()
        .is_some_and(|name| name.trim().to_lowercase() == folded)
}

fn confirm_saved(verified: &Value, expected: &Value, name: &str) -> Result<(), &'static str> {
    let entries = verified[crate::api::provider_list_key(verified)]
        .as_array()
        .ok_or(ERR_UNCONFIRMED)?;
    let folded = name.to_lowercase();
    let mut matching = entries.iter().filter(|entry| same_name(entry, &folded));
    let saved = matching.next().ok_or(ERR_UNCONFIRMED)?;
    if matching.next().is_some()
        || ["name", "api_base_url", "models", "api_key", "transformer"]
            .iter()
            .any(|field| saved.get(field) != expected.get(field))
    {
        return Err(ERR_UNCONFIRMED);
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTransformers {
    names: Vec<String>,
    parameterized_names: Vec<String>,
}

pub struct ProvidersService {
    client: Option<AdminClient>,
}

impl ProvidersService {
    pub fn new(client: Option<AdminClient>) -> Self {
        Self { client }
    }

    async fn add(&self, provider: Option<Value>) -> Result<SavedProvider, &'static str> {
        let provider = ProviderInput::parse(provider)?;
        if provider.api_key.is_empty() || matches!(provider.transformer, TransformerChange::Remove)
        {
            return Err(ERR_INVALID);
        }
        let folded = provider.name.to_lowercase();
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
        if entries.iter().any(|entry| same_name(entry, &folded)) {
            return Err(ERR_DUPLICATE);
        }
        self.validate_transformer_parameters(&provider.transformer)
            .await?;
        let mut entry = json!({"name": provider.name});
        provider.apply(&mut entry)?;
        entries.push(entry.clone());
        let verified = client
            .post_config_and_readback(&config)
            .await
            .map_err(|_| ERR_UNCONFIRMED)?;
        confirm_saved(&verified, &entry, &provider.name)?;
        Ok(SavedProvider {
            name: provider.name,
        })
    }

    async fn transformers(&self) -> Result<ProviderTransformers, &'static str> {
        let client = self.client.as_ref().ok_or(ERR_UNAVAILABLE)?;
        let response = client
            .get_json("/api/transformers")
            .await
            .map_err(|_| ERR_UNAVAILABLE)?;
        let mut seen = HashSet::new();
        let mut catalog = ProviderTransformers {
            names: Vec::new(),
            parameterized_names: Vec::new(),
        };
        for item in response["transformers"].as_array().ok_or(ERR_UNAVAILABLE)? {
            let Some(name) = transformer_name(&item["name"]) else {
                continue;
            };
            if !seen.insert(name) {
                continue;
            }
            catalog.names.push(name.to_owned());
            if item["name"] == name && item["supportsParameters"] == true {
                catalog.parameterized_names.push(name.to_owned());
            }
            if catalog.names.len() == 64 {
                break;
            }
        }
        Ok(catalog)
    }

    async fn validate_transformer_parameters(
        &self,
        change: &TransformerChange,
    ) -> Result<(), &'static str> {
        let TransformerChange::Set(chain) = change else {
            return Ok(());
        };
        let mut tuples = chain.iter().filter_map(Value::as_array).peekable();
        if tuples.peek().is_some() {
            let catalog = self.transformers().await?;
            if !tuples.all(|tuple| {
                catalog
                    .parameterized_names
                    .iter()
                    .any(|name| tuple[0] == name.as_str())
            }) {
                return Err(ERR_INVALID);
            }
        }
        Ok(())
    }

    async fn get(&self, name: Option<Value>) -> Result<ProviderDetails, &'static str> {
        let name = selector(&name)?;
        let client = self.client.as_ref().ok_or(ERR_UNAVAILABLE)?;
        let config = client.config().await.map_err(|_| ERR_UNAVAILABLE)?;
        let entries = config[crate::api::provider_list_key(&config)]
            .as_array()
            .ok_or(ERR_UNAVAILABLE)?;
        let entry = &entries[entry_index(entries, name)?];
        if is_managed(entry) {
            return Err(ERR_MANAGED);
        }
        let base_url = endpoint(entry["api_base_url"].as_str().ok_or(ERR_UNAVAILABLE)?)
            .map_err(|_| ERR_UNAVAILABLE)?;
        let models =
            serde_json::from_value(entry["models"].clone()).map_err(|_| ERR_UNAVAILABLE)?;
        let (transformer, transformer_protected) = transformer_summary(entry);
        Ok(ProviderDetails {
            transformer,
            transformer_protected,
            name: name.to_owned(),
            base_url: base_url.to_owned(),
            models,
            managed: false,
        })
    }

    async fn update(
        &self,
        name: Option<Value>,
        provider: Option<Value>,
    ) -> Result<SavedProvider, &'static str> {
        let name = selector(&name)?;
        let provider = ProviderInput::parse(provider)?;
        let client = self.client.as_ref().ok_or(ERR_UNAVAILABLE)?;
        let _write = client.write_guard().await;
        let mut config = client.config().await.map_err(|_| ERR_UNAVAILABLE)?;
        let key = crate::api::provider_list_key(&config);
        let entries = config[key].as_array_mut().ok_or(ERR_UNAVAILABLE)?;
        let index = entry_index(entries, name)?;
        if is_managed(&entries[index]) {
            return Err(ERR_MANAGED);
        }
        if provider.name != name {
            return Err(ERR_INVALID);
        }
        let folded = provider.name.to_lowercase();
        if entries
            .iter()
            .enumerate()
            .any(|(other, p)| other != index && same_name(p, &folded))
        {
            return Err(ERR_DUPLICATE);
        }
        self.validate_transformer_parameters(&provider.transformer)
            .await?;
        provider.apply(&mut entries[index])?;
        let verified = client
            .post_config_and_readback(&config)
            .await
            .map_err(|_| ERR_UNCONFIRMED)?;
        confirm_saved(&verified, &config[key][index], &provider.name)?;
        Ok(SavedProvider {
            name: provider.name,
        })
    }
}

#[tauri::command]
pub async fn provider_add(
    window: WebviewWindow,
    service: tauri::State<'_, ProvidersService>,
    provider: Option<Value>,
) -> Result<SavedProvider, String> {
    crate::popup::guard(&window)?;
    service.add(provider).await.map_err(str::to_owned)
}

#[tauri::command]
pub async fn provider_get(
    window: WebviewWindow,
    service: tauri::State<'_, ProvidersService>,
    name: Option<Value>,
) -> Result<ProviderDetails, String> {
    crate::popup::guard(&window).map_err(|_| ERR_UNAVAILABLE.to_owned())?;
    service.get(name).await.map_err(str::to_owned)
}

#[tauri::command]
pub async fn provider_update(
    window: WebviewWindow,
    service: tauri::State<'_, ProvidersService>,
    name: Option<Value>,
    provider: Option<Value>,
) -> Result<SavedProvider, String> {
    crate::popup::guard(&window).map_err(|_| ERR_UNAVAILABLE.to_owned())?;
    service.update(name, provider).await.map_err(str::to_owned)
}

#[tauri::command]
pub async fn provider_transformers(
    window: WebviewWindow,
    service: tauri::State<'_, ProvidersService>,
) -> Result<ProviderTransformers, String> {
    crate::popup::guard(&window).map_err(|_| ERR_UNAVAILABLE.to_owned())?;
    service.transformers().await.map_err(str::to_owned)
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
    async fn provider_transformers_projects_unique_bounded_names_and_handles_failures() {
        let mut entries = vec![
            json!({"name":" Example ", "endpoint":"https://example.com"}),
            json!({"name":"Example"}),
            json!({"name":"\n"}),
            json!({"name":"a".repeat(65)}),
            json!({"endpoint":"https://example.com"}),
        ];
        entries.extend((1..70).map(|n| json!({"name":n.to_string()})));
        let mock = Mock::new(vec![
            response(json!({"transformers":entries})),
            response(json!({})),
            (500, "test-key".into()),
        ]);
        let service = ProvidersService::new(Some(mock.client()));
        let mut expected = vec!["Example".to_owned()];
        expected.extend((1..64).map(|n| n.to_string()));
        let result = serde_json::to_value(service.transformers().await.unwrap()).unwrap();
        assert_eq!(result, json!({"names":expected,"parameterizedNames":[]}));
        for _ in 0..2 {
            assert_eq!(service.transformers().await.err(), Some(ERR_UNAVAILABLE));
        }
        let requests = mock.finish().await;
        assert!(requests
            .iter()
            .all(|request| request.starts_with("GET /api/transformers ")));
    }

    #[tokio::test]
    async fn add_writes_validated_transformer_tuples_and_get_returns_only_names() {
        let mut provider = input();
        provider["transformer"] =
            json!({"use":[" first ",[" second ",{"token":"test-key","nested":[1,true]}]]});
        let mut expected = entry();
        expected["transformer"] =
            json!({"use":["first",["second",{"token":"test-key","nested":[1,true]}]]});
        let verified = json!({"Providers":[expected]});
        let mock = Mock::new(vec![
            response(json!({"Providers":[]})),
            response(json!({"transformers":[{"name":"second","supportsParameters":true}]})),
            response(json!({"success":true})),
            response(verified.clone()),
            response(verified.clone()),
        ]);
        let service = ProvidersService::new(Some(mock.client()));
        service.add(Some(provider)).await.unwrap();
        let details =
            serde_json::to_value(service.get(Some(json!("Example"))).await.unwrap()).unwrap();
        assert_eq!(
            details,
            json!({"name":"Example", "models":expected["models"], "baseUrl":expected["api_base_url"], "managed":false, "transformer":{"use":["first","second"]}, "transformerProtected":true})
        );
        let requests = mock.finish().await;
        let posted: Value =
            serde_json::from_str(requests[2].split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(posted, verified);
    }

    #[test]
    fn get_protects_unrecognized_transformer_chains_and_projects_simple_names() {
        for (transformer, names, protected) in [
            (
                json!({"use":["plain","other"]}),
                Some(json!({"use":["plain","other"]})),
                false,
            ),
            (
                json!({"use":["plain",{"value":"test-key"}]}),
                Some(json!({"use":["plain"]})),
                true,
            ),
            (json!({"use":{"token":"test-key"}}), None, true),
            (
                json!({"model":{"use":[["plain",{"value":"test-key"}]]}}),
                None,
                false,
            ),
            (json!("test-key"), None, true),
        ] {
            let (summary, actual_protected) =
                transformer_summary(&json!({"transformer":transformer}));
            assert_eq!(
                summary.map(|summary| serde_json::to_value(summary).unwrap()),
                names
            );
            assert_eq!(actual_protected, protected);
        }
    }

    #[tokio::test]
    async fn update_only_changes_provider_use_and_verifies_the_full_transformer() {
        let new_use = json!({"use":[["new",{"token":"test-key"}],"plain"]});
        let old_use = json!(["old"]);
        let per_model = json!({"model-a":{"use":[["per-model",{"value":"test-key"}]]}});
        for (change, has_per_model) in [
            (None, true),
            (Some(new_use.clone()), true),
            (Some(Value::Null), true),
            (Some(Value::Null), false),
        ] {
            let mut prior = entry();
            prior["transformer"] = if has_per_model {
                per_model.clone()
            } else {
                json!({})
            };
            prior["transformer"]["use"] = old_use.clone();
            let mut expected = prior.clone();
            let mut provider = input();
            if let Some(change) = change {
                provider["transformer"] = change.clone();
                if change.is_null() {
                    if has_per_model {
                        expected["transformer"] = per_model.clone();
                    } else {
                        expected.as_object_mut().unwrap().remove("transformer");
                    }
                } else {
                    expected["transformer"]["use"] = change["use"].clone();
                }
            }
            let mut mismatch = expected.clone();
            mismatch["transformer"] = json!({"use":["different"]});
            for (readback, confirmed) in [(expected.clone(), true), (mismatch, false)] {
                let mut responses = vec![response(json!({"providers":[prior]}))];
                if provider["transformer"] == new_use {
                    responses.push(response(
                        json!({"transformers":[{"name":"new","supportsParameters":true}]}),
                    ));
                }
                responses.extend([
                    response(json!({"success":true})),
                    response(json!({"providers":[readback]})),
                ]);
                let mock = Mock::new(responses);
                let service = ProvidersService::new(Some(mock.client()));
                let result = service
                    .update(Some(json!("Example")), Some(provider.clone()))
                    .await;
                assert_eq!(
                    result.err(),
                    if confirmed {
                        None
                    } else {
                        Some(ERR_UNCONFIRMED)
                    }
                );
                let requests = mock.finish().await;
                let posted: Value = serde_json::from_str(
                    requests[requests.len() - 2]
                        .split_once("\r\n\r\n")
                        .unwrap()
                        .1,
                )
                .unwrap();
                assert_eq!(posted, json!({"providers":[expected]}));
            }
        }
    }

    #[tokio::test]
    async fn tuples_require_positive_current_catalog_capability_before_post() {
        for catalog in [
            response(json!({"transformers":[{"name":"OpenAI","supportsParameters":false}]})),
            response(json!({"transformers":[{"name":"OpenAI"}]})),
            response(json!({"transformers":[{"name":"OpenAI","supportsParameters":"true"}]})),
            response(json!({"transformers":[]})),
            (500, "test-secret".into()),
        ] {
            for editing in [false, true] {
                let mut provider = input();
                provider["transformer"] = json!({"use":[["OpenAI",{}]]});
                let mock = Mock::new(vec![
                    response(json!({"Providers":if editing {vec![entry()]} else {vec![]}})),
                    catalog.clone(),
                ]);
                let service = ProvidersService::new(Some(mock.client()));
                let result = if editing {
                    service.update(Some(json!("Example")), Some(provider)).await
                } else {
                    service.add(Some(provider)).await
                };
                assert_eq!(
                    result.unwrap_err(),
                    if catalog.0 == 500 {
                        ERR_UNAVAILABLE
                    } else {
                        ERR_INVALID
                    }
                );
                assert!(mock
                    .finish()
                    .await
                    .iter()
                    .all(|req| req.starts_with("GET ")));
            }
        }
    }

    #[tokio::test]
    async fn untouched_chain_keeps_parameters_saved_after_get() {
        for old in [None, Some(json!({"use":["custom"]}))] {
            let mut original = entry();
            if let Some(transformer) = old {
                original["transformer"] = transformer;
            }
            let mut fresh = original.clone();
            fresh["transformer"] = json!({"use":[["custom",{"key":"test-secret"}]]});
            let mut expected = fresh.clone();
            expected["models"] = json!(["changed"]);
            let mock = Mock::new(vec![
                response(json!({"Providers":[original]})),
                response(json!({"Providers":[fresh]})),
                response(json!({"success":true})),
                response(json!({"Providers":[expected]})),
            ]);
            let service = ProvidersService::new(Some(mock.client()));
            let mut provider = input();
            service.get(Some(json!("Example"))).await.unwrap();
            provider["models"] = json!(["changed"]);
            service
                .update(Some(json!("Example")), Some(provider))
                .await
                .unwrap();
            let requests = mock.finish().await;
            let posted: Value =
                serde_json::from_str(requests[2].split_once("\r\n\r\n").unwrap().1).unwrap();
            assert_eq!(posted["Providers"][0], expected);
        }
    }

    #[tokio::test]
    async fn get_protects_malformed_transformer_until_explicit_replacement_or_removal() {
        for replacement in [json!({"use":["OpenAI"]}), Value::Null] {
            let mut prior = entry();
            prior["transformer"] = json!("test-secret");
            let mut expected = entry();
            if !replacement.is_null() {
                expected["transformer"] = replacement.clone();
            }
            let config = json!({"Providers":[prior]});
            let mock = Mock::new(vec![
                response(config.clone()),
                response(config),
                response(json!({"success":true})),
                response(json!({"Providers":[expected]})),
            ]);
            let service = ProvidersService::new(Some(mock.client()));
            let summary =
                serde_json::to_value(service.get(Some(json!("Example"))).await.unwrap()).unwrap();
            assert_eq!(summary["transformerProtected"], true);
            assert!(!summary.to_string().contains("test-secret"));
            let mut provider = input();
            provider["transformer"] = replacement;
            service
                .update(Some(json!("Example")), Some(provider))
                .await
                .unwrap();
            let requests = mock.finish().await;
            let posted: Value =
                serde_json::from_str(requests[2].split_once("\r\n\r\n").unwrap().1).unwrap();
            assert_eq!(posted["Providers"][0], expected);
        }
    }

    #[tokio::test]
    async fn invalid_transformer_input_fails_before_any_request() {
        let mock = Mock::new(vec![]);
        let service = ProvidersService::new(Some(mock.client()));
        let mut provider = input();
        provider["transformer"] = Value::Null;
        assert_eq!(
            service.add(Some(provider.clone())).await.unwrap_err(),
            ERR_INVALID
        );
        for invalid in [
            json!({}),
            json!({"use":[]}),
            json!({"use":"a"}),
            json!({"use":["a"],"model-a":{}}),
            json!({"use":vec!["a";9]}),
            json!({"use":["  "]}),
            json!({"use":["a\tb"]}),
            json!({"use":["a".repeat(65)]}),
            json!({"use":[["a"]]}),
            json!({"use":[["a",{},{}]]}),
            json!({"use":[["a",[]]]}),
            json!({"use":[[1,{}]]}),
            json!({"use":[["a",{"value":"é".repeat(1020)}]]}),
        ] {
            provider["transformer"] = invalid;
            assert_eq!(
                service.add(Some(provider.clone())).await.unwrap_err(),
                ERR_INVALID
            );
            assert_eq!(
                service
                    .update(Some(json!("Example")), Some(provider.clone()))
                    .await
                    .unwrap_err(),
                ERR_INVALID
            );
        }
        assert!(mock.finish().await.is_empty());
    }

    #[tokio::test]
    async fn get_projects_only_edit_fields_and_detects_all_managed_markers() {
        for (field, value) in [
            ("name", json!("ccr")),
            ("api_key", json!("ccr-managed-test")),
            ("apiKey", json!("ccr-managed-test")),
            ("ccr_managed", json!(true)),
            ("pluginManaged", json!(true)),
            ("workbuddyManaged", json!(true)),
            ("gemini_oauth_managed", json!(true)),
            ("geminiOauthManaged", json!(true)),
            ("kiro_managed", json!(true)),
            ("kiroManaged", json!(true)),
            ("codex_managed", json!(true)),
            ("codexManaged", json!(true)),
            ("qoder_managed", json!(true)),
            ("qoderManaged", json!(true)),
            ("cursor_managed", json!(true)),
            ("cursorManaged", json!(true)),
            ("grok_managed", json!(true)),
            ("grokManaged", json!(true)),
            ("workbuddy_kind", json!("workbuddy-ai")),
        ] {
            let mut original = entry();
            if field == "workbuddy_kind" {
                original["name"] = json!("workbuddy");
            }
            original[field] = value;
            original["api_base_url"] = json!("https://example.com/?api_key=test-secret");
            let name = original["name"].clone();
            let config = json!({"providers":[original]});
            let mock = Mock::new(vec![response(config.clone()), response(config)]);
            let service = ProvidersService::new(Some(mock.client()));
            assert_eq!(
                service.get(Some(name.clone())).await.err(),
                Some(ERR_MANAGED)
            );
            assert_eq!(
                service.update(Some(name), Some(input())).await.unwrap_err(),
                ERR_MANAGED
            );
            assert!(mock
                .finish()
                .await
                .iter()
                .all(|req| req.starts_with("GET /api/config ")));
        }
    }

    #[test]
    fn legacy_managed_kinds_and_runtime_transport_aliases_are_read_only() {
        for field in ["gemini_oauth_kind", "geminiOauthKind"] {
            assert!(is_managed(
                &json!({"name":"gemini-oauth", field:"antigravity"})
            ));
        }
        for (base, plugin) in [
            ("https://chatgpt.com/backend-api/codex/responses", "codex"),
            ("https://daily-cloudcode-pa.googleapis.com/", "gemini-oauth"),
            ("https://www.workbuddy.ai/", "workbuddy"),
        ] {
            assert!(is_managed(
                &json!({"name":"alias","api_base_url":base,"transformer":{"use":[plugin]}})
            ));
            assert!(!is_managed(
                &json!({"name":"alias","api_base_url":base,"transformer":{"use":["OpenAI"]}})
            ));
        }
        assert!(!is_managed(
            &json!({"name":"gemini-oauth","api_key":"ordinary"})
        ));
    }

    #[tokio::test]
    async fn get_never_serializes_opaque_query_values() {
        for (query, allowed) in [
            ("version=1", true),
            ("api-version=2024-10-21-preview", true),
            ("api_key=test-secret", false),
            ("version=test-secret", false),
            ("version=1&token=test-secret", false),
            ("api-version=2024-02-30", false),
            ("version=%74est-secret", false),
            ("unknown=1", false),
        ] {
            let mut original = entry();
            original["api_base_url"] = json!(format!("https://example.com/v1?{query}"));
            let mock = Mock::new(vec![response(json!({"Providers":[original]}))]);
            let service = ProvidersService::new(Some(mock.client()));
            let result = service.get(Some(json!("Example"))).await;
            if allowed {
                assert_eq!(
                    serde_json::to_value(result.unwrap()).unwrap()["baseUrl"],
                    original["api_base_url"]
                );
            } else {
                assert_eq!(
                    serde_json::to_value(result).unwrap(),
                    json!({"Err":ERR_UNAVAILABLE})
                );
            }
            mock.finish().await;
        }
    }

    #[tokio::test]
    async fn update_preserves_saved_fields_and_applies_only_requested_changes() {
        for key in [None, Some(""), Some(" test-key ")] {
            let mut provider = input();
            provider.as_object_mut().unwrap().remove("apiKey");
            let mut original = json!({"providers":[{
                "name":"Example", "api_base_url":"https://example.com/v1", "models":["original-model"],
                "api_key":"test-key", "quota_token":"test-key", "quota_sec_token":"test-key",
                "quotaAccessKey":"test-key", "quotaSecretKey":"test-key", "enabled":false,
                "proxy":{"port":8080}, "transformer":{"original-model":{"use":[["custom",{"key":"test-key"}]]}}
            }, {"name":"other"}], "Router":{"default":"Example,original-model"}});
            if let Some(key) = key {
                provider["apiKey"] = json!(key);
                if !key.is_empty() {
                    original["providers"][0]["api_key"] = json!("");
                }
            }
            let mut expected = original.clone();
            for (field, value) in entry().as_object().unwrap() {
                expected["providers"][0][field] = value.clone();
            }
            let mock = Mock::new(vec![
                response(original),
                response(json!({"success":true})),
                response(expected.clone()),
            ]);
            let client = mock.client();
            let service = ProvidersService::new(Some(client.clone()));
            let guard = client.write_guard().await;
            let update = service.update(Some(json!(" Example ")), Some(provider));
            tokio::pin!(update);
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(20), &mut update)
                    .await
                    .is_err()
            );
            drop(guard);
            assert_eq!(
                serde_json::to_value(update.await.unwrap()).unwrap(),
                json!({"name":"Example"})
            );
            let requests = mock.finish().await;
            assert_eq!(requests.len(), 3);
            assert!(requests[0].starts_with("GET /api/config "));
            assert!(requests[1].starts_with("POST /api/config "));
            assert!(requests[2].starts_with("GET /api/config "));
            let posted: Value =
                serde_json::from_str(requests[1].split_once("\r\n\r\n").unwrap().1).unwrap();
            assert_eq!(posted, expected);
        }
    }

    #[tokio::test]
    async fn update_checks_duplicate_names_excluding_the_located_entry() {
        for name in ["Renamed", "EXAMPLE"] {
            let original = json!({"Providers":[entry()], "Router":{"default":"Example,model-a"}});
            let mut provider = input();
            provider["name"] = json!(name);
            let mock = Mock::new(vec![response(original)]);
            let service = ProvidersService::new(Some(mock.client()));
            assert_eq!(
                service
                    .update(Some(json!("Example")), Some(provider))
                    .await
                    .unwrap_err(),
                ERR_INVALID
            );
            assert!(mock.finish().await[0].starts_with("GET /api/config "));
        }
        let mock = Mock::new(vec![response(
            json!({"Providers":[entry(), {"name":" eXamPle ", "enabled":false}]}),
        )]);
        let service = ProvidersService::new(Some(mock.client()));
        assert_eq!(
            service
                .update(Some(json!("Example")), Some(input()))
                .await
                .unwrap_err(),
            ERR_DUPLICATE
        );
        assert_eq!(mock.finish().await.len(), 1);
    }

    #[tokio::test]
    async fn update_requires_the_expected_fields_and_one_matching_entry() {
        let original = entry();
        let mut changed_key = entry();
        changed_key["api_key"] = json!("");
        let mut changed_models = entry();
        changed_models["models"] = json!([]);
        let mut changed_url = entry();
        changed_url["api_base_url"] = json!("https://example.com");
        for verified in [
            json!([entry(), entry()]),
            json!([]),
            json!([changed_key]),
            json!([changed_models]),
            json!([changed_url]),
        ] {
            for key in [None, Some("test-key")] {
                let mut provider = input();
                let mut prior = original.clone();
                if let Some(key) = key {
                    provider["apiKey"] = json!(key);
                    prior["api_key"] = json!("");
                } else {
                    provider.as_object_mut().unwrap().remove("apiKey");
                }
                let mock = Mock::new(vec![
                    response(json!({"Providers":[prior]})),
                    response(json!({"success":true})),
                    response(json!({"Providers":verified})),
                ]);
                let service = ProvidersService::new(Some(mock.client()));
                assert_eq!(
                    service
                        .update(Some(json!("Example")), Some(provider))
                        .await
                        .unwrap_err(),
                    ERR_UNCONFIRMED
                );
                assert_eq!(mock.finish().await.len(), 3);
            }
        }
    }

    #[tokio::test]
    async fn get_and_update_reject_invalid_ipc_before_request() {
        let mock = Mock::new(vec![]);
        let service = ProvidersService::new(Some(mock.client()));
        for invalid in [
            None,
            Some(json!(42)),
            Some(json!("invalid,name")),
            Some(json!("")),
        ] {
            assert_eq!(service.get(invalid.clone()).await.err(), Some(ERR_INVALID));
            assert_eq!(
                service.update(invalid, Some(input())).await.unwrap_err(),
                ERR_INVALID
            );
        }
        for invalid in [None, Some(json!({})), Some(json!([]))] {
            assert_eq!(
                service
                    .update(Some(json!("Example")), invalid)
                    .await
                    .unwrap_err(),
                ERR_INVALID
            );
        }
        for (field, value) in [
            ("apiKey", Value::Null),
            ("apiKey", json!(" ")),
            ("apiKey", json!("test-key".repeat(513))),
            ("name", json!("a,b")),
            ("baseUrl", json!("https://example.com/#")),
            ("baseUrl", json!("https://user:test-key@example.com/")),
            ("models", json!(["a", " a "])),
            ("models", json!([])),
            ("transformer", json!({})),
        ] {
            let mut invalid = input();
            invalid[field] = value;
            assert_eq!(
                service
                    .update(Some(json!("Example")), Some(invalid))
                    .await
                    .unwrap_err(),
                ERR_INVALID
            );
        }
        assert!(mock.finish().await.is_empty());
    }

    #[tokio::test]
    async fn get_and_update_require_a_unique_exact_target_on_the_fresh_config() {
        for config in [
            json!({}),
            json!({"providers": {}}),
            json!({"Providers": [entry(), entry()]}),
            json!({"Providers":[{"name":"EXAMPLE"}]}),
        ] {
            let mock = Mock::new(vec![response(config.clone()), response(config)]);
            let service = ProvidersService::new(Some(mock.client()));
            assert_eq!(
                service.get(Some(json!("Example"))).await.err(),
                Some(ERR_UNAVAILABLE)
            );
            assert_eq!(
                service
                    .update(Some(json!("Example")), Some(input()))
                    .await
                    .unwrap_err(),
                ERR_UNAVAILABLE
            );
            assert_eq!(mock.finish().await.len(), 2);
        }
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
