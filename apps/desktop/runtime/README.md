# runtime/ — generated standalone runtime staging

Everything in this directory except this README is **generated** by
[`scripts/prepare-runtime.mjs`](../scripts/prepare-runtime.mjs) and is never
committed to git (see `../.gitignore`).

Layout (fixed paths consumed by the Rust launcher in
`src-tauri/src/lifecycle.rs`):

```
runtime/
  node                       portable Node binary (pinned distro, sha256-verified)
  LICENSE-node               Node license (bundled distribution)
  bin/npm, bin/npx           wrappers into the bundled npm (self-contained)
  lib/node_modules/npm/**    npm package tree (plugin installs without global npm)
  service/entry.cjs          desktop service entry (core runtime, no CLI)
  service/tiktoken_bg.wasm   tokenizer wasm next to the entry
  service/node_modules/**    better-sqlite3 (native) + lru-cache + transitive deps
  MANIFEST.json              pinned versions + sha256, deterministic content
```

Rebuild after a clean CLI/core build:

```sh
pnpm build:shared && pnpm build:core
node apps/desktop/scripts/prepare-runtime.mjs
node apps/desktop/scripts/smoke-bundled-runtime.mjs   # isolated smoke, never port 3456
node apps/desktop/scripts/build-standalone.mjs        # .app with runtime resources
```

Never stage user configuration, credentials, plugins, or databases; the app
uses the user's real HOME/CCR_CONFIG_DIR at runtime and packages none of it.
