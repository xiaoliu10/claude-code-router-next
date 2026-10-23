# Protocol provenance / third-party notices

**Physical account UNTESTED.** Protocol compatibility is based on source research and fixture tests, not a real subscription/account exercise.

This plugin is an independent CCR integration. It is not affiliated with or endorsed by OpenAI. OpenAI, ChatGPT and Codex names identify the upstream service and client protocol.

The browser OAuth wire contract was researched from the official `openai/codex` login-server implementation (Apache License 2.0): issuer/client identity, loopback callback ports 1455/1457, redirect path, PKCE S256 and form-encoded authorization-code exchange. CLI-style originator/client-version/User-Agent identifiers are compatibility metadata, not a claim that this plugin is the official CLI. No Codex executable or CLI credential-store code is bundled.

Additional protocol behavior was researched from the `yetone/magpie` Codex provider: refresh encoding/scopes, account claims, model discovery/instructions, wham usage, body finalization and quota observations. See source module headers and the implementation research contract for provenance. The plugin implements these wire contracts independently in TypeScript; no upstream source file is distributed verbatim.

The remainder of this package is licensed under the repository's MIT license. Any future direct adaptation of upstream source must retain its applicable copyright/license notices.
