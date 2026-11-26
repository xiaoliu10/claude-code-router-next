//! Loopback-only admin transport. GET /api/config returns raw placeholders, not runtime secrets.
use crate::settings::ConnectionSettings;
use reqwest::{header::HeaderValue, redirect::Policy, Client, Method};
use serde_json::{json, Value};
use std::{collections::HashSet, sync::Arc, time::Duration};
use tokio::sync::{Mutex, MutexGuard};

#[derive(Clone, Debug, PartialEq, Hash)]
pub struct TrayProvider {
    pub name: String,
    pub models: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Hash)]
pub struct TraySnapshot {
    pub providers: Vec<TrayProvider>,
    pub current_default: Option<String>,
    pub family_routing: bool,
    pub quota_lines: Vec<String>,
    pub quota_warning: Option<String>,
}

// Deliberately not Debug: the transport holds an authenticated connection.
#[derive(Clone)]
pub struct AdminClient {
    client: Client,
    base_url: String,
    api_key: Option<HeaderValue>,
    writes: Arc<Mutex<()>>,
}

/// Admin request errors contain only the fixed operation and status code.
pub(crate) fn admin_auth_failed(error: &str) -> bool {
    error.ends_with("returned HTTP 401") || error.ends_with("returned HTTP 403")
}

pub(crate) enum ConditionalSaveError {
    Stale,
    Unconfirmed,
}

impl AdminClient {
    pub fn new(settings: ConnectionSettings) -> Result<Self, String> {
        // Revalidate public settings so hand-built values cannot send credentials off-host.
        let port = settings
            .base_url
            .strip_prefix("http://127.0.0.1:")
            .and_then(|port| port.parse::<u16>().ok())
            .filter(|port| *port != 0)
            .ok_or_else(|| "Invalid loopback connection settings".to_string())?;
        if settings.base_url != format!("http://127.0.0.1:{port}") {
            return Err("Invalid loopback connection settings".into());
        }
        let api_key = settings
            .api_key
            .map(|key| {
                let mut header = HeaderValue::from_str(&key)
                    .map_err(|_| "Invalid admin authentication settings".to_string())?;
                header.set_sensitive(true);
                Ok::<_, String>(header)
            })
            .transpose()?;
        let client = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|_| "Could not initialize admin HTTP client".to_string())?;
        Ok(Self {
            client,
            base_url: settings.base_url,
            api_key,
            writes: Arc::new(Mutex::new(())),
        })
    }

    pub(crate) async fn write_guard(&self) -> MutexGuard<'_, ()> {
        self.writes.lock().await
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<reqwest::Response, String> {
        self.request_with_timeout(method, path, body, Duration::from_secs(5))
            .await
    }

    pub(crate) async fn request_with_timeout(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        timeout: Duration,
    ) -> Result<reqwest::Response, String> {
        let operation = format!("{method} {path}");
        let response = self.send(method, path, body, timeout).await?;
        if !response.status().is_success() {
            return Err(format!(
                "{operation} returned HTTP {}",
                response.status().as_u16()
            ));
        }
        Ok(response)
    }

    async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        timeout: Duration,
    ) -> Result<reqwest::Response, String> {
        let operation = format!("{method} {path}");
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.base_url));
        if let Some(key) = &self.api_key {
            request = request.header("X-API-Key", key);
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        request
            .timeout(timeout)
            .send()
            .await
            .map_err(|_| format!("{operation} failed"))
    }

    pub(crate) async fn get_json(&self, path: &str) -> Result<Value, String> {
        self.request(Method::GET, path, None)
            .await?
            .json::<Value>()
            .await
            .map_err(|_| format!("GET {path} returned invalid JSON"))
    }

    pub(crate) async fn config(&self) -> Result<Value, String> {
        self.config_with_revision().await.map(|(raw, _)| raw)
    }

    pub(crate) async fn config_with_revision(&self) -> Result<(Value, Option<String>), String> {
        let response = self.request(Method::GET, "/api/config", None).await?;
        let revision = response
            .headers()
            .get("X-CCR-Config-Revision")
            .and_then(|header| header.to_str().ok())
            .filter(|revision| {
                revision.len() == 64
                    && revision
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
            .map(str::to_owned);
        let config = response
            .json::<Value>()
            .await
            .map_err(|_| "GET /api/config returned invalid JSON".to_string())?;
        if !config.is_object() {
            return Err("GET /api/config returned invalid configuration".into());
        }
        Ok((config, revision))
    }

    pub(crate) async fn put_config_and_readback(
        &self,
        config: &Value,
        revision: &str,
    ) -> Result<Value, ConditionalSaveError> {
        let body = json!({ "config": config, "revision": revision });
        let response = self
            .send(
                Method::PUT,
                "/api/config",
                Some(&body),
                Duration::from_secs(20),
            )
            .await
            .map_err(|_| ConditionalSaveError::Unconfirmed)?;
        if response.status() == reqwest::StatusCode::CONFLICT {
            return Err(ConditionalSaveError::Stale);
        }
        if !response.status().is_success()
            || response
                .json::<Value>()
                .await
                .ok()
                .and_then(|v| v["success"].as_bool())
                != Some(true)
        {
            return Err(ConditionalSaveError::Unconfirmed);
        }
        self.config()
            .await
            .map_err(|_| ConditionalSaveError::Unconfirmed)
    }

    /// Only fixed read-only adapter routes call this helper. Never return response bodies as errors.
    pub(crate) async fn quota_json(
        &self,
        method: Method,
        path: &'static str,
        body: Option<&Value>,
    ) -> Result<Value, crate::quota::SourceError> {
        use crate::quota::SourceError;
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.base_url));
        if let Some(key) = &self.api_key {
            request = request.header("X-API-Key", key);
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        let mut response = request.send().await.map_err(|_| SourceError::Unavailable)?;
        let status = response.status();
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| SourceError::Unavailable)?
        {
            if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
                return Err(SourceError::Unavailable);
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| SourceError::Unavailable)?;
        if !status.is_success() {
            return Err(match value.get("error").and_then(Value::as_str) {
                Some(
                    "codex_reauth_required"
                    | "kiro_reauth_required"
                    | "gemini_oauth_reauth_required",
                ) => SourceError::Reauth,
                Some("kiro_account_cooling") => SourceError::Cooling,
                _ => SourceError::Unavailable,
            });
        }
        Ok(value)
    }

    pub async fn health(&self) -> bool {
        self.request(Method::GET, "/health", None).await.is_ok()
    }

    pub async fn snapshot(&self) -> Result<TraySnapshot, String> {
        let config = self.config().await?;
        Ok(self.snapshot_from_config(&config).await)
    }

    /// POST the full config, require success confirmation, then read the
    /// persisted document back. The gateway may normalize the saved config
    /// (managed-provider presets, plugin protectors), so callers verify their
    /// specific mutation on the readback instead of comparing digests.
    pub(crate) async fn post_config_and_readback(&self, config: &Value) -> Result<Value, String> {
        let posted = self
            .request_with_timeout(
                Method::POST,
                "/api/config",
                Some(config),
                Duration::from_secs(20),
            )
            .await?;
        let saved = posted
            .json::<Value>()
            .await
            .map_err(|_| "POST /api/config returned invalid JSON".to_string())?;
        if saved.get("success").and_then(Value::as_bool) != Some(true) {
            return Err("POST /api/config did not confirm success".into());
        }
        self.config().await
    }

    /// POST to an allowlist-built mutation path and parse the JSON response.
    /// Callers must project allowlisted fields only: some responses embed the
    /// raw config.
    pub(crate) async fn post_json_and_parse(&self, path: &str) -> Result<Value, String> {
        self.request_with_timeout(Method::POST, path, None, Duration::from_secs(20))
            .await?
            .json::<Value>()
            .await
            .map_err(|_| format!("POST {path} returned invalid JSON"))
    }

    async fn snapshot_from_config(&self, config: &Value) -> TraySnapshot {
        let current_default = default_value(config);
        let quota = self
            .get_json("/api/providers/quota")
            .await
            .and_then(|response| quota_lines(&response, current_default.as_deref()));
        let (quota_lines, quota_warning) = match quota {
            Ok(lines) => (lines, None),
            Err(warning) => (Vec::new(), Some(warning)),
        };
        TraySnapshot {
            providers: providers(config),
            current_default,
            family_routing: config
                .pointer("/Router/families")
                .and_then(Value::as_object)
                .is_some_and(|families| !families.is_empty()),
            quota_lines,
            quota_warning,
        }
    }

    pub async fn switch_default(
        &self,
        provider: &str,
        model: &str,
    ) -> Result<TraySnapshot, String> {
        if provider.trim().is_empty() || provider.contains(',') || model.trim().is_empty() {
            return Err("Invalid default model selection".into());
        }
        let _write = self.write_guard().await;
        // Never use a snapshot/cached config to write credentials or resurrect removed models.
        let mut config = self.config().await?;
        if !providers(&config)
            .iter()
            .any(|entry| entry.name == provider && entry.models.iter().any(|entry| entry == model))
        {
            return Err("Default model selection is no longer available".into());
        }
        let root = config.as_object_mut().expect("config() validates object");
        let router = root
            .entry("Router")
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or_else(|| "Cannot update malformed Router configuration".to_string())?;
        let target = format!("{provider},{model}");
        router.insert("default".into(), Value::String(target.clone()));
        // Existing API only supports full config writes: concurrent UI saves can race this
        // read/modify/write. This is NOT an atomic patch. Mutate only Router.default locally.
        // Saving runs backup + reload + provider rebuild server-side, so allow far longer
        // than reads before giving up on the response.
        let post = self
            .request_with_timeout(
                Method::POST,
                "/api/config",
                Some(&config),
                Duration::from_secs(20),
            )
            .await;
        let saved = match post {
            Ok(response) => response
                .json::<Value>()
                .await
                .map_err(|_| "POST /api/config returned invalid JSON".to_string())?,
            // The server may have persisted despite an unreadable response (timeout,
            // connection drop). Reconcile via readback instead of reporting a stale menu.
            Err(post_error) => {
                if let Ok(current) = self.config().await {
                    if default_value(&current).as_deref() == Some(target.as_str()) {
                        return Ok(self.snapshot_from_config(&current).await);
                    }
                }
                return Err(post_error);
            }
        };
        if saved.get("success").and_then(Value::as_bool) != Some(true) {
            return Err("POST /api/config did not confirm success".into());
        }
        let verified = self.config().await?;
        if default_value(&verified).as_deref() != Some(target.as_str()) {
            return Err("GET /api/config did not confirm default model update".into());
        }
        Ok(self.snapshot_from_config(&verified).await)
    }
}

fn default_value(config: &Value) -> Option<String> {
    config
        .pointer("/Router/default")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
}

pub(crate) fn provider_list_key(config: &Value) -> &'static str {
    if config.get("Providers").is_none() && config.get("providers").is_some() {
        "providers"
    } else {
        "Providers"
    }
}

pub(crate) fn providers(config: &Value) -> Vec<TrayProvider> {
    let mut result = Vec::new();
    let mut names = HashSet::new();
    if let Some(entries) = config
        .get(provider_list_key(config))
        .and_then(Value::as_array)
    {
        for entry in entries {
            if !entry.is_object() || !matches!(entry.get("enabled"), None | Some(Value::Bool(true)))
            {
                continue;
            }
            let Some(name) = entry
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| !name.trim().is_empty() && !name.contains(','))
            else {
                continue;
            };
            if name == "ccr" && entry.get("ccr_managed").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let mut seen = HashSet::new();
            // The server's Provider schema uses string model identifiers.
            let models: Vec<String> = entry
                .get("models")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter(|model| !model.trim().is_empty() && seen.insert(*model))
                .map(str::to_owned)
                .collect();
            if !models.is_empty() && names.insert(name) {
                result.push(TrayProvider {
                    name: name.into(),
                    models,
                });
            }
        }
    }
    result
}

fn quota_lines(response: &Value, current_default: Option<&str>) -> Result<Vec<String>, String> {
    let entries = response
        .get("quotas")
        .and_then(Value::as_array)
        .ok_or_else(|| "GET /api/providers/quota returned invalid quota data".to_string())?;
    let Some((provider, _)) = current_default.and_then(|value| value.split_once(',')) else {
        return Ok(Vec::new());
    };
    let Some(quota) = entries
        .iter()
        .find(|entry| entry.get("provider").and_then(Value::as_str) == Some(provider))
    else {
        return Ok(Vec::new());
    };
    if let Some(plan) = quota.get("stepPlan") {
        return Ok(crate::quota::step_plan_tray_lines(plan));
    }
    let number = |name: &str| {
        quota
            .get(name)
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite() && *n >= 0.0)
    };
    let mut lines = Vec::new();
    for window in ["5h", "7d", "30d"] {
        let (Some(used), Some(limit)) = (
            number(&format!("used{window}")),
            number(&format!("limit{window}")),
        ) else {
            continue;
        };
        match quota.get(format!("type{window}")).and_then(Value::as_str) {
            Some("balance") => {
                let Some(currency) = quota
                    .get("currency")
                    .and_then(Value::as_str)
                    .filter(|c| c.len() == 3 && c.bytes().all(|ch| ch.is_ascii_uppercase()))
                else {
                    continue;
                };
                lines.push(format!(
                    "{window} remaining {currency}{:.2}",
                    (limit - used).max(0.0)
                ));
            }
            None | Some("rateLimit") if limit > 0.0 => {
                let percent = used / limit * 100.0;
                if percent.is_finite() {
                    lines.push(format!(
                        "{window} {}/{} ({:.1}%)",
                        compact(used),
                        compact(limit),
                        percent
                    ));
                }
            }
            _ => {}
        }
    }
    Ok(lines)
}

fn compact(value: f64) -> String {
    format!("{value:.2}")
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_string()
}

/// Shared test transport: real ephemeral loopback sockets answering a fixed
/// reply sequence. Never reaches the user's CCR port or config directory.
#[cfg(test)]
pub(crate) mod mock {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::{Arc, Mutex},
        thread,
    };

    pub(crate) const MOCK_TIMEOUT: Duration = Duration::from_secs(10);

    pub(crate) struct Mock {
        pub(crate) base_url: String,
        requests: Arc<Mutex<Vec<String>>>,
        worker: Option<thread::JoinHandle<()>>,
    }

    impl Mock {
        pub(crate) fn new(replies: Vec<(u16, String)>) -> Self {
            Self::delayed(replies, Duration::ZERO)
        }

        pub(crate) fn delayed(replies: Vec<(u16, String)>, delay: Duration) -> Self {
            Self::with_options(replies, delay, None)
        }

        pub(crate) fn with_config_revision(
            replies: Vec<(u16, String)>,
            revision: Option<&str>,
        ) -> Self {
            Self::with_options(replies, Duration::ZERO, revision)
        }

        fn with_options(
            replies: Vec<(u16, String)>,
            delay: Duration,
            revision: Option<&str>,
        ) -> Self {
            let revision_header = revision.map_or(String::new(), |revision| {
                format!("X-CCR-Config-Revision: {revision}\r\n")
            });
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let base_url = format!("http://{}", listener.local_addr().unwrap());
            let requests = Arc::new(Mutex::new(Vec::new()));
            let recorded = requests.clone();
            let worker = thread::spawn(move || {
                for (status, body) in replies {
                    let deadline = std::time::Instant::now() + MOCK_TIMEOUT;
                    let mut socket = loop {
                        match listener.accept() {
                            Ok((socket, _)) => break socket,
                            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                                assert!(
                                    std::time::Instant::now() < deadline,
                                    "mock did not receive expected request"
                                );
                                thread::sleep(Duration::from_millis(5));
                            }
                            Err(error) => panic!("mock accept failed: {error}"),
                        }
                    };
                    // macOS inherits O_NONBLOCK from the listener; a read timeout does not
                    // make such a socket blocking. Wait for the client to send its request.
                    socket.set_nonblocking(false).unwrap();
                    socket.set_read_timeout(Some(MOCK_TIMEOUT)).unwrap();
                    socket.set_write_timeout(Some(MOCK_TIMEOUT)).unwrap();
                    let mut bytes = Vec::new();
                    loop {
                        let mut chunk = [0; 4096];
                        let size = match socket.read(&mut chunk) {
                            Ok(size) => size,
                            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
                                continue
                            }
                            Err(error) => panic!("mock request read failed: {error}"),
                        };
                        assert!(size > 0, "request ended before complete body");
                        bytes.extend_from_slice(&chunk[..size]);
                        if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                            let headers = String::from_utf8_lossy(&bytes[..end]);
                            assert!(
                                !headers.lines().any(|line| line.split_once(':').is_some_and(
                                    |(name, _)| name.eq_ignore_ascii_case("transfer-encoding")
                                )),
                                "mock expects Content-Length framing, not chunked requests"
                            );
                            let length = headers
                                .lines()
                                .find_map(|line| {
                                    let (name, value) = line.split_once(':')?;
                                    name.eq_ignore_ascii_case("content-length")
                                        .then(|| value.trim().parse::<usize>().unwrap())
                                })
                                .unwrap_or(0);
                            if bytes.len() >= end + 4 + length {
                                assert_eq!(
                                    bytes.len(),
                                    end + 4 + length,
                                    "unexpected request bytes"
                                );
                                break;
                            }
                        }
                    }
                    recorded
                        .lock()
                        .unwrap()
                        .push(String::from_utf8(bytes).unwrap());
                    thread::sleep(delay);
                    let redirect = if status == 302 {
                        format!(
                            "Location: http://{}/unexpected\r\n",
                            socket.local_addr().unwrap()
                        )
                    } else {
                        String::new()
                    };
                    write!(socket, "HTTP/1.1 {status} Mock\r\n{redirect}{revision_header}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                }
            });
            Self {
                base_url,
                requests,
                worker: Some(worker),
            }
        }
        pub(crate) fn client(&self) -> AdminClient {
            AdminClient::new(ConnectionSettings {
                base_url: self.base_url.clone(),
                api_key: Some("test-admin-key".into()),
            })
            .unwrap()
        }
        pub(crate) async fn finish(mut self) -> Vec<String> {
            // Tokio tests use a current-thread runtime. Never block its reactor while a
            // client task may still need to send bytes or receive the final response.
            let worker = self.worker.take().unwrap();
            tokio::task::spawn_blocking(move || worker.join().unwrap())
                .await
                .unwrap();
            Arc::try_unwrap(self.requests)
                .unwrap()
                .into_inner()
                .unwrap()
        }
    }

    pub(crate) fn response(value: Value) -> (u16, String) {
        (200, value.to_string())
    }

    pub(crate) fn config() -> Value {
        json!({"APIKEY":"$ADMIN", "Providers":[{"name":"alpha", "models":["one","two"], "api_key":"${UPSTREAM}", "custom":{"nested":[1,{"key":"$SECRET"}]}}], "Router":{"default":"alpha,one", "families":{"claude":{"default":"other,model"}}}, "Clients":{"pi":{"key":"$PI"}}, "unknown":{"deep":[true,null,2]}})
    }
}

#[cfg(test)]
mod tests {
    use super::mock::{config, response, Mock, MOCK_TIMEOUT};
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpStream,
        thread,
    };

    #[tokio::test]
    async fn cloned_clients_share_the_write_gate() {
        let client = AdminClient::new(ConnectionSettings {
            base_url: "http://127.0.0.1:1".into(),
            api_key: None,
        })
        .unwrap();
        let sibling = client.clone();
        let held = client.write_guard().await;
        assert!(sibling.writes.try_lock().is_err());
        drop(held);
        assert!(sibling.writes.try_lock().is_ok());
    }

    #[tokio::test]
    async fn mock_finish_keeps_reactor_running() {
        let mock = Mock::new(vec![response(json!({"status":"ok"}))]);
        let client = mock.client();
        let health = tokio::spawn(async move { client.health().await });
        let requests = mock.finish().await;
        assert!(health.await.unwrap());
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with("GET /health "));
    }

    #[tokio::test]
    async fn mock_waits_for_delayed_and_fragmented_request_body() {
        let mock = Mock::new(vec![response(json!({"success":true}))]);
        let address = mock.base_url.strip_prefix("http://").unwrap().to_owned();
        let expected = "POST /api/config HTTP/1.1\r\nHost: localhost\r\nContent-Length: 13\r\nConnection: close\r\n\r\n{\"test\":true}";
        let sender = tokio::task::spawn_blocking(move || {
            let mut socket = TcpStream::connect(address).unwrap();
            socket.set_read_timeout(Some(MOCK_TIMEOUT)).unwrap();
            socket.set_write_timeout(Some(MOCK_TIMEOUT)).unwrap();
            // The accepted socket must wait even when no request bytes are ready yet.
            thread::sleep(Duration::from_millis(50));
            for part in [
                "POST /api/config HTTP/1.1\r\nHost: localhost\r\nContent-Len",
                "gth: 13\r\nConnection: close\r\n\r",
                "\n{\"test\":",
                "true}",
            ] {
                socket.write_all(part.as_bytes()).unwrap();
                thread::sleep(Duration::from_millis(10));
            }
            let mut response = String::new();
            socket.read_to_string(&mut response).unwrap();
            assert!(response.starts_with("HTTP/1.1 200 "));
            assert!(response.ends_with("{\"success\":true}"));
        });
        let requests = mock.finish().await;
        sender.await.unwrap();
        assert_eq!(requests, [expected]);
    }

    #[tokio::test]
    async fn health_and_snapshot_auth_quota_and_family_routing() {
        let mock = Mock::new(vec![
            response(json!({"status":"ok"})),
            response(config()),
            response(json!({"quotas":[
                {"provider":"other","used5h":99,"limit5h":100},
                {"provider":"alpha","used5h":66,"limit5h":100,"type5h":"rateLimit","used7d":9.06,"limit7d":100,"type7d":"balance","currency":"CNY"}
            ]})),
        ]);
        let client = mock.client();
        assert!(client.health().await);
        let snapshot = client.snapshot().await.unwrap();
        assert!(snapshot.family_routing);
        assert_eq!(snapshot.current_default.as_deref(), Some("alpha,one"));
        assert_eq!(
            snapshot.quota_lines,
            ["5h 66/100 (66.0%)", "7d remaining CNY90.94"]
        );
        assert!(snapshot.quota_warning.is_none());
        let requests = mock.finish().await;
        assert!(requests[0].starts_with("GET /health "));
        assert!(requests.iter().all(|request| request
            .to_lowercase()
            .contains("x-api-key: test-admin-key\r\n")));
    }

    #[tokio::test]
    async fn switch_preserves_raw_nested_config_and_verifies_readback() {
        let original = config();
        let mut expected = original.clone();
        expected["Router"]["default"] = json!("alpha,two");
        let mock = Mock::new(vec![
            response(original.clone()),
            response(json!({"success":true})),
            response(expected.clone()),
            response(json!({"quotas":[]})),
        ]);
        let result = mock.client().switch_default("alpha", "two").await.unwrap();
        assert_eq!(result.current_default.as_deref(), Some("alpha,two"));
        let requests = mock.finish().await;
        assert_eq!(requests.len(), 4);
        assert!(requests[1].starts_with("POST /api/config "));
        let posted: Value =
            serde_json::from_str(requests[1].split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(posted, expected);
        let mut restored = posted;
        restored["Router"]["default"] = original["Router"]["default"].clone();
        assert_eq!(
            serde_json::to_vec(&restored).unwrap(),
            serde_json::to_vec(&original).unwrap()
        );
        assert!(requests.iter().all(|request| request
            .to_lowercase()
            .contains("x-api-key: test-admin-key\r\n")));
    }

    #[tokio::test]
    async fn creates_only_missing_router_and_rejects_malformed_router() {
        let cfg = json!({"Providers":[{"name":"alpha","models":["one"]}], "extra":"$SECRET"});
        let mut expected = cfg.clone();
        expected["Router"] = json!({"default":"alpha,one"});
        let mock = Mock::new(vec![
            response(cfg),
            response(json!({"success":true})),
            response(expected.clone()),
            response(json!({"quotas":[]})),
        ]);
        mock.client().switch_default("alpha", "one").await.unwrap();
        let requests = mock.finish().await;
        assert_eq!(
            serde_json::from_str::<Value>(requests[1].split_once("\r\n\r\n").unwrap().1).unwrap(),
            expected
        );
        for router in [json!(null), json!([]), json!("secret")] {
            let mut cfg = config();
            cfg["Router"] = router;
            let mock = Mock::new(vec![response(cfg)]);
            assert!(mock.client().switch_default("alpha", "one").await.is_err());
            assert_eq!(mock.finish().await.len(), 1);
        }
    }

    #[tokio::test]
    async fn stale_disabled_removed_and_invalid_targets_never_post() {
        for cfg in [
            json!({"Providers":[]}),
            json!({"Providers":[{"name":"alpha","enabled":false,"models":["one"]}]}),
            json!({"Providers":[{"name":"alpha","models":["new"]}]}),
            json!({"Providers":[{"name":"ccr","ccr_managed":true,"models":["one"]}]}),
        ] {
            let provider = if cfg["Providers"][0]["name"] == "ccr" {
                "ccr"
            } else {
                "alpha"
            };
            let mock = Mock::new(vec![response(cfg)]);
            assert!(mock.client().switch_default(provider, "one").await.is_err());
            assert_eq!(mock.finish().await.len(), 1);
        }
        let mock = Mock::new(vec![]);
        assert!(mock
            .client()
            .switch_default("bad,name", "one")
            .await
            .is_err());
        assert!(mock.client().switch_default("alpha", " ").await.is_err());
        assert!(mock.finish().await.is_empty());
    }

    #[tokio::test]
    async fn false_success_and_bad_readback_are_failures_without_secret_errors() {
        for saved in [
            json!({"success":false,"error":"LEAK_SECRET"}),
            json!({"message":"LEAK_SECRET"}),
            json!({"success":"true"}),
        ] {
            let mock = Mock::new(vec![response(config()), response(saved)]);
            let error = mock
                .client()
                .switch_default("alpha", "two")
                .await
                .unwrap_err();
            assert!(!error.contains("LEAK_SECRET"));
            assert_eq!(mock.finish().await.len(), 2);
        }
        let mock = Mock::new(vec![
            response(config()),
            response(json!({"success":true})),
            response(config()),
        ]);
        assert!(mock
            .client()
            .switch_default("alpha", "two")
            .await
            .unwrap_err()
            .contains("did not confirm"));
        assert_eq!(mock.finish().await.len(), 3);
    }

    #[tokio::test]
    async fn config_failures_are_not_empty_snapshots_and_errors_are_safe() {
        for reply in [
            (401, "LEAK_SECRET".into()),
            (200, "{invalid LEAK_SECRET".into()),
            response(json!([])),
        ] {
            let mock = Mock::new(vec![reply]);
            let error = mock.client().snapshot().await.unwrap_err();
            assert!(!error.contains("LEAK_SECRET"));
            let requests = mock.finish().await;
            assert_eq!(requests.len(), 1);
        }
    }

    #[tokio::test]
    async fn quota_errors_are_optional_and_sanitized() {
        for reply in [
            (401, "LEAK_SECRET".into()),
            (500, "LEAK_SECRET".into()),
            (200, "bad LEAK_SECRET".into()),
            response(json!({"secret":"LEAK_SECRET"})),
        ] {
            let mock = Mock::new(vec![response(config()), reply]);
            let snapshot = mock.client().snapshot().await.unwrap();
            assert!(!snapshot.providers.is_empty());
            assert!(snapshot.quota_lines.is_empty());
            assert!(!snapshot.quota_warning.unwrap().contains("LEAK_SECRET"));
            assert_eq!(mock.finish().await.len(), 2);
        }
    }

    #[test]
    fn filters_malformed_disabled_managed_and_duplicate_providers_and_models() {
        let cfg = json!({"Providers":[null, {}, {"name":" ","models":["one"]},
            {"name":"disabled","enabled":false,"models":["one"]}, {"name":"malformed","enabled":"true","models":["one"]},
            {"name":"ccr","ccr_managed":true,"models":["one"]}, {"name":"bad,name","models":["one"]},
            {"name":"alpha","models":["one","one","", " ",null, {}, "two"]}, {"name":"alpha","models":["three"]},
            {"name":"ccr","models":["custom"]}]});
        assert_eq!(
            providers(&cfg),
            vec![
                TrayProvider {
                    name: "alpha".into(),
                    models: vec!["one".into(), "two".into()]
                },
                TrayProvider {
                    name: "ccr".into(),
                    models: vec!["custom".into()]
                }
            ]
        );
    }

    #[test]
    fn step_plan_tray_preserves_coding_and_credit_semantics() {
        let lines = |plan| {
            quota_lines(
                &json!({"quotas":[{"provider":"alpha","stepPlan":plan,"used5h":55,"limit5h":100}]}),
                Some("alpha,one"),
            )
            .unwrap()
        };
        assert_eq!(
            lines(
                json!({"state":"stale","family":"coding","name":"Legacy","allowed":false,"windows":[{"id":"five_hour","limited":true,"usedPercent":0}, {"id":"weekly","limited":false}]})
            ),
            ["Legacy · stale · blocked", "5h used 0%", "7d unlimited"]
        );
        assert_eq!(
            lines(
                json!({"state":"partial","family":"coding","windows":[{"id":"weekly","limited":true}]})
            ),
            ["Step Plan · partial", "7d used —"]
        );
        assert_eq!(lines(json!({"state":"partial","family":"token","creditBuckets":[{"type":"topup","total":"12345678901234567890","remaining":"1.2300","expiresAt":1000}]})), ["Step Plan · partial", "topup Credit · 1.2300 / 12345678901234567890 remaining · used — · expires 1970-01-01T00:00:01Z"]);
    }
    #[test]
    fn monthly_only_quota_is_shown_in_tray() {
        let response = json!({"quotas":[{"provider":"volcengine","used30d":75,"limit30d":300}]});
        assert_eq!(
            quota_lines(&response, Some("volcengine,model")).unwrap(),
            ["30d 75/300 (25.0%)"]
        );
    }

    #[test]
    fn quota_unknown_zero_invalid_and_other_provider_values_are_not_fabricated() {
        let lines = |quota| quota_lines(&json!({"quotas":[quota]}), Some("alpha,one")).unwrap();
        for quota in [
            json!({"provider":"alpha","used5h":0}),
            json!({"provider":"alpha","used5h":0,"limit5h":0}),
            json!({"provider":"alpha","used5h":-1,"limit5h":100}),
            json!({"provider":"alpha","used5h":"secret","limit5h":100}),
            json!({"provider":"other","used5h":66,"limit5h":100}),
            json!({"provider":"alpha","used7d":0,"limit7d":100,"type7d":"balance"}),
        ] {
            assert!(lines(quota).is_empty());
        }
        assert_eq!(
            lines(json!({"provider":"alpha","used7d":10,"limit7d":100,"type7d":"rateLimit"})),
            ["7d 10/100 (10.0%)"]
        );
        assert_eq!(
            lines(
                json!({"provider":"alpha","used7d":0,"limit7d":0,"type7d":"balance","currency":"USD"})
            ),
            ["7d remaining USD0.00"]
        );
        assert!(quota_lines(&json!({"quotas":[]}), None).unwrap().is_empty());
    }

    #[test]
    fn rejects_remote_urls_and_invalid_headers_without_exposing_secrets() {
        for url in [
            "https://example.com",
            "http://127.0.0.1:3456/path",
            "http://127.0.0.1:0",
            "http://127.0.0.1:3456@evil.example",
            "http://127.0.0.1:03456",
        ] {
            assert!(AdminClient::new(ConnectionSettings {
                base_url: url.into(),
                api_key: None
            })
            .is_err());
        }
        let error = AdminClient::new(ConnectionSettings {
            base_url: "http://127.0.0.1:3456".into(),
            api_key: Some("LEAK_SECRET\r\n".into()),
        })
        .err()
        .unwrap();
        assert!(!error.contains("LEAK_SECRET"));
    }

    #[tokio::test]
    async fn post_failures_are_safe_and_failed_fresh_get_never_posts() {
        for reply in [(401, "LEAK_SECRET".into()), (200, "bad LEAK_SECRET".into())] {
            let mock = Mock::new(vec![response(config()), reply]);
            let error = mock
                .client()
                .switch_default("alpha", "two")
                .await
                .unwrap_err();
            assert!(!error.contains("LEAK_SECRET"));
            assert_eq!(mock.finish().await.len(), 2);
        }
        let mock = Mock::new(vec![(500, "LEAK_SECRET".into())]);
        assert!(mock.client().switch_default("alpha", "two").await.is_err());
        assert_eq!(mock.finish().await.len(), 1);
    }

    #[tokio::test]
    async fn optional_auth_health_failure_and_no_family_routing() {
        let mock = Mock::new(vec![
            (401, "LEAK_SECRET".into()),
            response(json!({"Router":{"families":{}}})),
            response(json!({"quotas":[]})),
        ]);
        let client = AdminClient::new(ConnectionSettings {
            base_url: mock.base_url.clone(),
            api_key: None,
        })
        .unwrap();
        assert!(!client.health().await);
        let snapshot = client.snapshot().await.unwrap();
        assert!(!snapshot.family_routing);
        assert!(snapshot.current_default.is_none());
        let requests = mock.finish().await;
        assert!(requests
            .iter()
            .all(|request| !request.to_lowercase().contains("x-api-key:")));
    }

    #[tokio::test]
    async fn redirect_is_not_followed() {
        // A 302 is rejected before any response body or follow-up request is consumed.
        let mock = Mock::new(vec![(302, "LEAK_SECRET".into())]);
        let error = mock.client().snapshot().await.unwrap_err();
        assert!(error.contains("HTTP 302"));
        assert!(!error.contains("LEAK_SECRET"));
        assert_eq!(mock.finish().await.len(), 1);
    }
}
