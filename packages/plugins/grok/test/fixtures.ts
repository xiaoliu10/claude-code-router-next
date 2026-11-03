import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { GrokAuthService } from "../src/auth-service";
import type { PluginHostCapabilities } from "../src/core-types";
export const TOKEN = "fixture-access-secret";
export const ROTATED = "fixture-rotated-secret";
export function auth(key = TOKEN, expires = Date.now() + 3600000, identity: Record<string, any> = { user_id: "user-without-email" }): string {
  return JSON.stringify({ "fixture-scope": { key, expires_at: new Date(expires).toISOString(), email: null, refresh_token: "cli-only-refresh-secret", ...identity } });
}
export function fixture(options: { login?: "success" | "wait" | "hostile" | "identityless"; expires?: number; proxy?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "grok-fixture-"));
  const home = join(root, "user"), cliHome = join(home, ".grok"), bin = join(cliHome, "bin"), configDir = join(root, "ccr");
  mkdirSync(bin, { recursive: true }); mkdirSync(configDir, { mode: 0o700 });
  writeFileSync(join(cliHome, "auth.json"), auth(TOKEN, options.expires), { mode: 0o600 });
  const executable = join(bin, "grok");
  const successAuth = auth(TOKEN, undefined, options.login === "identityless" ? { user_id: null } : undefined);
  const script = `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'grok 1.0.62'; exit 0; fi
if [ "$1" = "models" ]; then
  echo models >> '${root}/calls'
  echo "$GROK_HOME|$GROK_AUTH_PATH|$GROK_AUTH_PROVIDER_COMMAND|$HTTPS_PROXY|$HTTP_PROXY" > '${root}/env'
  if [ -f '${root}/unchanged' ]; then exit 0; fi
  printf '%s' '${auth(ROTATED)}' > "$GROK_HOME/auth.json"
  exit 0
fi
if [ "$1" = "login" ]; then
  echo 'https://${options.login === "hostile" ? "evil.invalid" : "accounts.x.ai"}/oauth2/device?user_code=AB12-CD34'
  ${options.login === "wait" || options.login === "hostile" ? "while :; do :; done" : `printf '%s' '${successAuth}' > "$GROK_HOME/auth.json"`}
  exit 0
fi
exit 19
`;
  writeFileSync(executable, script); chmodSync(executable, 0o700);
  let config: any = { Providers: [{ name: "other", api_key: "$KEEP_SECRET", models: ["other"] }], Router: { default: "other,other" },
    ...(options.proxy ? { SUBSCRIPTION_PROXY_URL: options.proxy } : {}) };
  const direct = { fixture: "direct" }, subscription = { fixture: "subscription" };
  const host: PluginHostCapabilities = {
    configDir, readConfig: vi.fn(async () => { throw new Error("Interpolated config must never be read"); }),
    readRawConfig: vi.fn(async () => structuredClone(config)), writeConfig: vi.fn(async c => { config = structuredClone(c); }),
    reloadRuntime: vi.fn(async () => {}), getDirectDispatcher: () => direct, getSubscriptionDispatcher: () => subscription,
  };
  const env = { HOME: home, GROK_HOME: cliHome, GROK_BIN_DIR: bin, PATH: "", GROK_AUTH_PATH: "/must-be-removed", GROK_AUTH_PROVIDER_COMMAND: "must-be-removed", HTTPS_PROXY: "http://ambient.invalid:1", FIXTURE_PROXY: "http://fixture.invalid:9999" };
  const upstream = vi.fn(async (_url: any, _init?: any): Promise<Response> => { throw new Error("Unexpected fixture fetch"); });
  const service = new GrokAuthService({ host, env, userHome: home, fetch: upstream as typeof fetch, linkTimeoutMs: 15000, loginTimeoutMs: 30000 });
  return { root, home, cliHome, bin, executable, configDir, host, env, service, upstream, direct, subscription,
    config: () => config, read: (name: string) => readFileSync(join(root, name), "utf8"),
    cleanup: async () => { await service.disconnect().catch(() => {}); rmSync(root, { recursive: true, force: true }); } };
}
export function sse(events: any[], done = true): Response {
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : ""), { headers: { "content-type": "text/event-stream" } });
}
export const completed = { type: "response.completed", response: { id: "resp-fixture", object: "response", status: "completed", model: "grok-fixture", output: [
  { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello fixture" }] },
], usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 } } };
