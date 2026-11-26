use super::*;
use crate::api::mock::Mock;
use serde_json::json;

#[tokio::test]
async fn missing_denied_and_invalid_feeds_never_mean_current() {
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    for (status, body, expected) in [
        (404, "{}", "UPDATE_FEED_UNAVAILABLE"),
        (403, "{}", CHECK_FAILED),
        (500, "{}", CHECK_FAILED),
        (204, "", CHECK_FAILED),
        (200, "not json", CHECK_FAILED),
    ] {
        let mock = Mock::new(vec![(status, body.into())]);
        assert_eq!(
            read_feed(&client, &mock.base_url).await.unwrap_err(),
            expected
        );
        assert_eq!(mock.finish().await.len(), 1);
    }
}

fn mock_updater(pubkey: &str) -> tauri_plugin_updater::Updater {
    use tauri::test::{mock_builder, mock_context, noop_assets};
    let mut ctx = mock_context(noop_assets());
    ctx.package_info_mut().version = semver::Version::new(0, 1, 1);
    ctx.config_mut().plugins.0.insert(
        "updater".into(),
        json!({
            "endpoints": [FEED], "requireSignedVersion": true, "pubkey": pubkey
        }),
    );
    let app = mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(ctx)
        .unwrap();
    app.updater_builder()
        .target(TARGET)
        .no_proxy()
        .build()
        .unwrap()
}

fn manifest(version: &str) -> serde_json::Value {
    json!({
        "version": version,
        "notes": "Desktop notes",
        "platforms": { TARGET: {
            "url": format!("{DOWNLOAD_BASE}v2.3.2437/CCR-Desktop_{version}_x64-setup.exe"),
            "signature": include_str!("fixtures/payload.sig").trim(),
        }}
    })
}

#[test]
fn check_binds_desktop_version_target_signer_and_confirmation() {
    let updater = mock_updater(include_str!("fixtures/test.pub").trim());
    for version in ["0.1.0", "0.1.1"] {
        assert!(checked_update(&updater, manifest(version))
            .unwrap()
            .is_none());
    }
    let service = UpdateService::default();
    let mut slot = service.exclusive().unwrap();
    assert!(matches!(service.exclusive(), Err("UPDATE_BUSY")));
    *slot = checked_update(&updater, manifest("0.1.2")).unwrap();
    assert!(matches!(
        take_confirmed(&mut slot, "2.3.2437"),
        Err(VERSION_CHANGED)
    ));
    let update = take_confirmed(&mut slot, "0.1.2").unwrap();
    assert_eq!(update.body.as_deref(), Some("Desktop notes"));
    assert!(matches!(
        take_confirmed(&mut slot, "0.1.2"),
        Err(VERSION_CHANGED)
    ));
    assert!(update.verify(b"Desktop updater test\n").is_ok());
    assert_eq!(
        update_error(update.verify(b"changed").unwrap_err(), "unexpected"),
        SIGNATURE_INVALID
    );
    let inflated = checked_update(&updater, manifest("0.2.0"))
        .unwrap()
        .unwrap();
    assert_eq!(
        update_error(
            inflated.verify(b"Desktop updater test\n").unwrap_err(),
            "unexpected"
        ),
        SIGNATURE_INVALID
    );
    let mut unsigned = manifest("0.1.2");
    unsigned["platforms"][TARGET]["signature"] = json!("");
    assert!(matches!(
        checked_update(&updater, unsigned),
        Err(SIGNATURE_INVALID)
    ));
    let mut foreign = manifest("0.1.2");
    foreign["platforms"][TARGET]["url"] = json!("https://example.invalid/pkg.exe");
    assert!(matches!(
        checked_update(&updater, foreign),
        Err(CHECK_FAILED)
    ));
}

#[tokio::test]
async fn installation_progress_follows_verified_download_only() {
    let updater = mock_updater(include_str!("fixtures/test.pub").trim());
    for (status, payload, expected) in [
        (200, "Desktop updater test\n", Ok(())),
        (200, "changed bytes", Err(SIGNATURE_INVALID)),
        (403, "denied", Err("UPDATE_DOWNLOAD_FAILED")),
    ] {
        let mock = Mock::new(vec![(status, payload.into())]);
        let mut update = checked_update(&updater, manifest("0.1.2"))
            .unwrap()
            .unwrap();
        update.download_url = mock.base_url.parse().unwrap();
        let mut events = Vec::new();
        let result = download_verified(&update, |event| events.push(event)).await;
        assert_eq!(result.map(|_| ()), expected);
        assert_eq!(
            events.iter().any(|e| e.phase == "installing"),
            expected.is_ok()
        );
        if expected.is_ok() {
            assert_eq!(events[0].phase, "downloading");
            assert_eq!(events.last().unwrap().downloaded, payload.len() as u64);
        }
        mock.finish().await;
    }
}

/// Release CI exercises the same target/URL/version/signature checks against the staged files.
#[test]
#[ignore = "requires a staged signed release"]
fn verify_staged_release() {
    let dir = std::path::Path::new("target/desktop-release");
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join("desktop-update.json")).unwrap()).unwrap();
    let version = env!("CARGO_PKG_VERSION");
    assert_eq!(manifest["version"], version);
    let file = format!("CCR-Desktop_{version}_x64-setup.exe");
    let signature = std::fs::read_to_string(dir.join(format!("{file}.sig"))).unwrap();
    assert_eq!(manifest["platforms"][TARGET]["signature"], signature.trim());
    let release: serde_json::Value =
        serde_json::from_slice(&std::fs::read("target/desktop-signing.conf.json").unwrap())
            .unwrap();
    let updater = mock_updater(release["plugins"]["updater"]["pubkey"].as_str().unwrap());
    let update = checked_update(&updater, manifest).unwrap().unwrap();
    update
        .verify(&std::fs::read(dir.join(file)).unwrap())
        .unwrap();
}
