# Desktop software updates

The Windows x64 `v2.3.2437` release ships `CCR-Desktop-0.1.1-Windows-x64-setup.exe`. A client must compare the desktop version (`0.1.1`, from `apps/desktop/src-tauri/tauri.conf.json`) against the desktop update manifest. A CLI release can advance independently.

## Settings interaction

Place a software update section in Settings that works even when the gateway is offline. Show the installed desktop version, keep the manual check button visible throughout a check, and persist the automatic check switch. Check every six hours by default. When a newer desktop version is available, show a notice on the active main-window tab with the version and an “Update now” action. Put the brief gateway interruption notice beside the action. A single click starts download, signature verification and installation. Keep release notes available in Settings. Show transferred bytes while the content length is unknown, then a percentage if a total is available.

Magpie's upstream interaction tests cover these details in `internal/gui/tests/update-check.test.cjs`, `update-auto.test.cjs`, `update-download-percent.test.cjs` and `update-restart.test.cjs` ([upstream tests](https://github.com/yetone/magpie/tree/main/internal/gui/tests)). The main CCR control center and tray popup load the same frontend. Only the main window should initiate update checks or offer installation.

## Distribution

Use a stable desktop update manifest and Tauri's signed installer mechanism. Verify the payload before handing off installation. The client can retry failed checks and downloads while continuing to serve traffic. The desktop owns its update lifecycle, so a working gateway connection is unnecessary. [Tauri updater](https://v2.tauri.app/plugin/updater/)

The first updater-enabled desktop release needs a normal installer rollout. An installation of `0.1.1` has no code to fetch that first update. Later signed desktop versions can be offered in Settings.
