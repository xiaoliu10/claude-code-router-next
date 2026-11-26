use super::{reset, text};
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StepPlan {
    pub(super) state: &'static str,
    family: &'static str,
    name: Option<String>,
    pub(super) observed_at: Option<u64>,
    allowed: Option<bool>,
    windows: Vec<Window>,
    credit_buckets: Vec<CreditBucket>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Window {
    id: &'static str,
    limited: bool,
    used_percent: Option<f64>,
    resets_at: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreditBucket {
    #[serde(rename = "type")]
    kind: &'static str,
    total: String,
    remaining: String,
    used_percent: Option<f64>,
    resets_at: Option<u64>,
    expires_at: Option<u64>,
}

fn choice(value: &Value, values: &[&'static str]) -> Option<&'static str> {
    values.iter().copied().find(|v| value.as_str() == Some(v))
}

fn credit(value: &Value) -> Option<String> {
    let amount = value.as_str()?;
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let valid = match amount.split_once('.') {
        Some((whole, fraction)) => digits(whole) && digits(fraction),
        None => digits(amount),
    };
    valid.then(|| amount.to_owned())
}

fn percent(value: &Value) -> Option<f64> {
    value.as_f64().filter(|p| (0.0..=100.0).contains(p))
}

fn epoch(value: &Value) -> Option<u64> {
    value.as_u64().filter(|_| reset(value).is_some())
}

impl StepPlan {
    pub(super) fn project(value: &Value) -> Self {
        let state =
            choice(&value["state"], &["known", "partial", "stale"]).unwrap_or("unavailable");
        // An unavailable account snapshot is a tombstone, even if accompanied by old fields.
        let data = if state == "unavailable" {
            &Value::Null
        } else {
            value
        };
        let family = choice(&data["family"], &["coding", "token"]).unwrap_or("none");
        let windows = data["windows"]
            .as_array()
            .filter(|_| family == "coding")
            .into_iter()
            .flatten()
            .filter_map(|w| {
                Some(Window {
                    id: choice(&w["id"], &["five_hour", "weekly"])?,
                    limited: w["limited"].as_bool()?,
                    used_percent: percent(&w["usedPercent"]),
                    resets_at: epoch(&w["resetsAt"]),
                })
            })
            .collect();
        let credit_buckets = data["creditBuckets"]
            .as_array()
            .filter(|_| family == "token")
            .into_iter()
            .flatten()
            .filter_map(|b| {
                Some(CreditBucket {
                    kind: choice(&b["type"], &["subscription", "topup"])?,
                    total: credit(&b["total"])?,
                    remaining: credit(&b["remaining"])?,
                    used_percent: percent(&b["usedPercent"]),
                    resets_at: epoch(&b["resetsAt"]),
                    expires_at: epoch(&b["expiresAt"]),
                })
            })
            .collect();
        Self {
            state,
            family,
            name: text(&data["name"]),
            observed_at: epoch(&data["observedAt"]),
            allowed: data["allowed"].as_bool(),
            windows,
            credit_buckets,
        }
    }

    pub(super) fn tray_lines(&self) -> Vec<String> {
        fn used(percent: Option<f64>) -> String {
            percent.map_or_else(|| "used —".into(), |p| format!("used {p}%"))
        }
        fn date(label: &str, ms: Option<u64>) -> String {
            ms.and_then(|ms| reset(&Value::from(ms)))
                .map_or_else(String::new, |date| format!(" · {label} {date}"))
        }
        let name = self.name.as_deref().unwrap_or("Step Plan");
        let allowed = match self.allowed {
            Some(true) => " · allowed",
            Some(false) => " · blocked",
            None => "",
        };
        let mut lines = vec![format!(
            "{name} · {}{allowed}{}",
            self.state,
            date("observed", self.observed_at)
        )];
        for window in &self.windows {
            let label = if window.id == "five_hour" { "5h" } else { "7d" };
            let usage = if window.limited {
                used(window.used_percent)
            } else {
                "unlimited".into()
            };
            lines.push(format!(
                "{label} {usage}{}",
                date("resets", window.resets_at)
            ));
        }
        for bucket in &self.credit_buckets {
            lines.push(format!(
                "{} Credit · {} / {} remaining · {}{}{}",
                bucket.kind,
                bucket.remaining,
                bucket.total,
                used(bucket.used_percent),
                date("resets", bucket.resets_at),
                date("expires", bucket.expires_at)
            ));
        }
        lines
    }
}
