//! Current user's login item. Registration always points directly to this executable.
use std::{io, path::Path};
use tauri::WebviewWindow;

#[tauri::command]
pub async fn login_start_status(window: WebviewWindow) -> Result<bool, String> {
    crate::popup::guard(&window)?;
    registration(None)
}

#[tauri::command]
pub async fn login_start_set(window: WebviewWindow, enabled: bool) -> Result<(), String> {
    crate::popup::guard(&window)?;
    registration(Some(enabled)).map(|_| ())
}

fn registration(change: Option<bool>) -> Result<bool, String> {
    let exe = std::env::current_exe().map_err(|_| "Cannot locate desktop executable")?;
    platform::apply(&exe, change).map_err(|e| e.to_string())
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStrExt;
    use winreg::{
        enums::{HKEY_CURRENT_USER, KEY_SET_VALUE},
        RegKey,
    };

    const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const NAME: &str = "CCR Desktop";

    pub fn apply(exe: &Path, change: Option<bool>) -> io::Result<bool> {
        run_value(&RegKey::predef(HKEY_CURRENT_USER), RUN, exe, change)
    }

    fn quoted_exe(exe: &Path) -> OsString {
        let mut command = OsString::from("\"");
        command.push(exe);
        command.push("\"");
        command
    }

    fn run_value(
        root: &RegKey,
        subkey: &str,
        exe: &Path,
        change: Option<bool>,
    ) -> io::Result<bool> {
        // Use a shell-compatible drive path when current_exe returns a verbatim path.
        let command = quoted_exe(dunce::simplified(exe));
        match change {
            Some(true) => {
                if command.encode_wide().count() > 260 {
                    return Err(io::Error::other("Path exceeds Windows Run command limit"));
                }
                root.create_subkey_with_flags(subkey, KEY_SET_VALUE)?
                    .0
                    .set_value(NAME, &command)?;
                Ok(true)
            }
            Some(false) => match root
                .open_subkey_with_flags(subkey, KEY_SET_VALUE)
                .and_then(|k| k.delete_value(NAME))
            {
                Ok(()) => Ok(false),
                Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
                Err(e) => Err(e),
            },
            None => match root
                .open_subkey(subkey)
                .and_then(|k| k.get_value::<OsString, _>(NAME))
            {
                Ok(value) => Ok(value == command || value == quoted_exe(exe)),
                Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
                Err(e) => Err(e),
            },
        }
    }

    #[test]
    fn isolated_registry_round_trip() {
        let root = RegKey::predef(HKEY_CURRENT_USER);
        let key = format!(r"Software\CCRDesktopLoginTest-{}", std::process::id());
        let exe = Path::new(r"\\?\C:\Programs With Spaces\桌面\ccr-desktop.exe");
        run_value(&root, &key, exe, Some(true)).unwrap();
        let saved: String = root.open_subkey(&key).unwrap().get_value(NAME).unwrap();
        assert_eq!(saved, r#""C:\Programs With Spaces\桌面\ccr-desktop.exe""#);
        assert!(run_value(&root, &key, exe, None).unwrap());
        root.open_subkey_with_flags(&key, KEY_SET_VALUE)
            .unwrap()
            .set_value(NAME, &quoted_exe(exe))
            .unwrap();
        assert!(run_value(&root, &key, exe, None).unwrap());
        run_value(&root, &key, exe, Some(false)).unwrap();
        assert!(!run_value(&root, &key, exe, None).unwrap());
        root.delete_subkey(&key).unwrap();
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use plist::{Dictionary, Value};
    const LABEL: &str = "com.claude-code-router.desktop.login";

    pub fn apply(exe: &Path, change: Option<bool>) -> io::Result<bool> {
        let home = std::env::var_os("HOME")
            .ok_or_else(|| io::Error::other("Home directory unavailable"))?;
        agent(&Path::new(&home).join("Library/LaunchAgents"), exe, change)
    }

    fn agent(dir: &Path, exe: &Path, change: Option<bool>) -> io::Result<bool> {
        let file = dir.join(format!("{LABEL}.plist"));
        let path = exe
            .to_str()
            .ok_or_else(|| io::Error::other("Executable path is not Unicode"))?;
        let mut spec = Dictionary::new();
        spec.insert("Label".into(), LABEL.into());
        spec.insert("ProgramArguments".into(), Value::Array(vec![path.into()]));
        spec.insert("RunAtLoad".into(), true.into());
        let spec = Value::Dictionary(spec);
        match change {
            Some(true) => {
                std::fs::create_dir_all(dir)?;
                let mut temp = tempfile::NamedTempFile::new_in(dir)?;
                spec.to_writer_xml(&mut temp).map_err(io::Error::other)?;
                temp.persist(file)?;
                Ok(true)
            }
            Some(false) => match std::fs::remove_file(file) {
                Ok(()) => Ok(false),
                Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
                Err(e) => Err(e),
            },
            None => match std::fs::File::open(file) {
                Ok(reader) => Ok(Value::from_reader(reader).map_err(io::Error::other)? == spec),
                Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
                Err(e) => Err(e),
            },
        }
    }

    #[test]
    fn escaped_path_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let exe = Path::new("/Tools & Apps/CCR Desktop");
        agent(dir.path(), exe, Some(true)).unwrap();
        assert!(agent(dir.path(), exe, None).unwrap());
        agent(dir.path(), exe, Some(false)).unwrap();
        assert!(!agent(dir.path(), exe, None).unwrap());
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    use super::*;
    pub fn apply(_: &Path, _: Option<bool>) -> io::Result<bool> {
        Err(io::Error::other(
            "Login startup is unavailable on this platform",
        ))
    }
}
