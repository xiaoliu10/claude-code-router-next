//! Local connection discovery. Never print config contents, environment values, or API keys.
use serde_json::Value;
use std::{fs, path::PathBuf};

// Deliberately not Debug: this object contains the admin credential.
#[derive(Clone)]
pub struct ConnectionSettings {
    pub base_url: String,
    pub api_key: Option<String>,
}

impl ConnectionSettings {
    pub fn from_environment() -> Result<Self, String> {
        let resolver = |name: &str| std::env::var(name).ok();
        let path = config_path(&resolver)?;
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                initialize_config(&path, &resolver)?
            }
            Err(_) => return Err("Could not read local CCR configuration".into()),
        };
        Self::from_config_text(&text, &resolver)
    }

    /// Pure discovery helper; the resolver supplies env overrides and placeholder values.
    pub fn from_config_text<F>(text: &str, resolver: &F) -> Result<Self, String>
    where
        F: Fn(&str) -> Option<String>,
    {
        let config: Value =
            json5::from_str(text).map_err(|_| "Invalid local CCR configuration".to_string())?;
        if !config.is_object() {
            return Err("Local CCR configuration must be an object".into());
        }
        let port_text = match resolver("CCR_DESKTOP_PORT") {
            Some(port) => port,
            None => match config.get("PORT") {
                None => "3456".into(),
                Some(Value::String(port)) => interpolate(port, resolver)?,
                Some(Value::Number(port)) => port.to_string(),
                _ => return Err("Invalid CCR port".into()),
            },
        };
        let port = port_text
            .parse::<u16>()
            .ok()
            .filter(|port| *port != 0)
            .ok_or_else(|| "Invalid CCR port".to_string())?;
        let api_key = match resolver("CCR_DESKTOP_API_KEY") {
            Some(key) => key,
            None => match config.get("APIKEY") {
                None | Some(Value::Null) => String::new(),
                Some(Value::String(key)) => interpolate(key, resolver)?,
                _ => return Err("Invalid CCR API key configuration".into()),
            },
        };
        Ok(Self {
            base_url: format!("http://127.0.0.1:{port}"),
            api_key: (!api_key.is_empty()).then_some(api_key),
        })
    }
}
fn initialize_config<F: Fn(&str) -> Option<String>>(
    path: &std::path::Path,
    resolver: &F,
) -> Result<String, String> {
    use std::io::Write;
    let settings = ConnectionSettings::from_config_text("{}", resolver)?;
    let port: u16 = settings
        .base_url
        .rsplit(':')
        .next()
        .unwrap()
        .parse()
        .unwrap();
    let api_key = match resolver("CCR_DESKTOP_API_KEY") {
        Some(key) => key,
        None => generate_local_api_key()?,
    };
    let text = serde_json::to_string_pretty(&serde_json::json!({
        "PORT": port, "HOST": "127.0.0.1", "APIKEY": api_key,
        "Providers": [], "Router": {}, "Clients": {}
    }))
    .map_err(|_| "Could not initialize desktop configuration".to_string())?;
    fs::create_dir_all(path.parent().ok_or("Invalid configuration directory")?)
        .map_err(|_| "Could not create desktop configuration directory".to_string())?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(path) {
        Ok(mut file) => {
            file.write_all(text.as_bytes())
                .map_err(|_| "Could not initialize desktop configuration".to_string())?;
            Ok(text)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => fs::read_to_string(path)
            .map_err(|_| "Could not read local CCR configuration".to_string()),
        Err(_) => Err("Could not initialize desktop configuration".into()),
    }
}

fn generate_local_api_key() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "Could not generate a local API key".to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn config_path<F: Fn(&str) -> Option<String>>(resolver: &F) -> Result<PathBuf, String> {
    let nonempty = |name| resolver(name).filter(|value| !value.is_empty());
    let directory = match nonempty("CCR_CONFIG_DIR") {
        Some(directory) => PathBuf::from(directory),
        None => PathBuf::from(
            nonempty("HOME")
                .or_else(|| nonempty("USERPROFILE"))
                .ok_or_else(|| "Cannot locate local CCR configuration directory".to_string())?,
        )
        .join(".claude-code-router"),
    };
    Ok(directory.join("config.json"))
}

/// Match $NAME and ${NAME} without recursively expanding the resolved secret.
pub(crate) fn interpolate<F: Fn(&str) -> Option<String>>(
    text: &str,
    resolver: &F,
) -> Result<String, String> {
    let invalid = || "Unresolved CCR environment placeholder".to_string();
    let mut result = String::new();
    let mut rest = text;
    while let Some(dollar) = rest.find('$') {
        result.push_str(&rest[..dollar]);
        rest = &rest[dollar + 1..];
        let (name, remaining) = if let Some(braced) = rest.strip_prefix('{') {
            let end = braced.find('}').ok_or_else(invalid)?;
            (&braced[..end], &braced[end + 1..])
        } else {
            let end = rest
                .find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_'))
                .unwrap_or(rest.len());
            (&rest[..end], &rest[end..])
        };
        if name.is_empty()
            || !name.starts_with(|ch: char| ch.is_ascii_alphabetic() || ch == '_')
            || !name
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        {
            return Err(invalid());
        }
        result.push_str(&resolver(name).ok_or_else(invalid)?);
        rest = remaining;
    }
    result.push_str(rest);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |key| {
            pairs
                .iter()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| value.to_string())
        }
    }

    #[test]
    fn first_launch_initializes_private_config_without_overwriting_existing() {
        let dir = std::env::temp_dir().join(format!("ccr-first-launch-{}", std::process::id()));
        let file = dir.join("config.json");
        let _ = fs::remove_dir_all(&dir);
        let text = initialize_config(&file, &env(&[("CCR_DESKTOP_PORT", "51234")])).unwrap();
        let cfg: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(cfg["PORT"], 51234);
        assert_eq!(cfg["HOST"], "127.0.0.1");
        let key = cfg["APIKEY"].as_str().unwrap();
        assert_eq!(key.len(), 64);
        assert!(key.bytes().all(|ch| ch.is_ascii_hexdigit()));
        assert!(cfg["Clients"].as_object().unwrap().is_empty());
        fs::write(&file, "{PORT:5001}").unwrap();
        assert_eq!(initialize_config(&file, &env(&[])).unwrap(), "{PORT:5001}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn first_launch_preserves_explicit_empty_key_override() {
        let dir = std::env::temp_dir().join(format!("ccr-empty-key-{}", std::process::id()));
        let file = dir.join("config.json");
        let _ = fs::remove_dir_all(&dir);
        let resolver = env(&[("CCR_DESKTOP_API_KEY", "")]);
        let text = initialize_config(&file, &resolver).unwrap();
        let cfg: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(cfg["APIKEY"], "");
        assert!(ConnectionSettings::from_config_text(&text, &resolver)
            .unwrap()
            .api_key
            .is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn defaults_and_json5_config() {
        let settings = ConnectionSettings::from_config_text("{}", &env(&[])).unwrap();
        assert_eq!(settings.base_url, "http://127.0.0.1:3456");
        assert!(settings.api_key.is_none());
        let settings = ConnectionSettings::from_config_text(
            "// comment\n{PORT: 4001, APIKEY: '${SECRET}', HOST: 'remote.example',}",
            &env(&[("SECRET", "sensitive")]),
        )
        .unwrap();
        assert_eq!(settings.base_url, "http://127.0.0.1:4001");
        assert_eq!(settings.api_key.as_deref(), Some("sensitive"));
    }

    #[test]
    fn overrides_take_precedence_and_empty_key_disables_auth() {
        let settings = ConnectionSettings::from_config_text(
            "{PORT: 'invalid', APIKEY: '$UNSET'}",
            &env(&[("CCR_DESKTOP_PORT", "5000"), ("CCR_DESKTOP_API_KEY", "")]),
        )
        .unwrap();
        assert_eq!(settings.base_url, "http://127.0.0.1:5000");
        assert!(settings.api_key.is_none());
    }

    #[test]
    fn interpolates_plain_and_braced_placeholders() {
        let settings = ConnectionSettings::from_config_text(
            "{PORT: '$PORT_ENV', APIKEY: 'prefix-$KEY/${OTHER}'}",
            &env(&[("PORT_ENV", "65535"), ("KEY", "one"), ("OTHER", "two")]),
        )
        .unwrap();
        assert_eq!(settings.base_url, "http://127.0.0.1:65535");
        assert_eq!(settings.api_key.as_deref(), Some("prefix-one/two"));
    }

    #[test]
    fn rejects_bad_ports_and_config_without_exposing_values() {
        for text in [
            "{PORT:0}",
            "{PORT:65536}",
            "{PORT:-1}",
            "{PORT:3.5}",
            "{PORT:null}",
            "{PORT:'remote-secret'}",
            "{APIKEY:'$missing_secret'}",
            "{APIKEY:'${broken_secret'}",
            "{APIKEY: {secret:1}}",
            "[]",
            "{secret: ???}",
        ] {
            let error = ConnectionSettings::from_config_text(text, &env(&[]))
                .err()
                .unwrap();
            assert!(!error.contains("secret"), "{error}");
            assert!(!error.contains(text), "{error}");
        }
    }

    #[test]
    fn config_path_is_resolved_without_accessing_the_real_home() {
        assert_eq!(
            config_path(&env(&[("CCR_CONFIG_DIR", "/isolated")])).unwrap(),
            PathBuf::from("/isolated/config.json")
        );
        assert_eq!(
            config_path(&env(&[("HOME", "/fake-home")])).unwrap(),
            PathBuf::from("/fake-home/.claude-code-router/config.json")
        );
        assert_eq!(
            config_path(&env(&[("HOME", ""), ("USERPROFILE", "/fake-profile")])).unwrap(),
            PathBuf::from("/fake-profile/.claude-code-router/config.json")
        );
        assert!(config_path(&env(&[])).is_err());
    }
}
