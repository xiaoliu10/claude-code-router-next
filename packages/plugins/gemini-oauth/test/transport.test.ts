import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boundedInitForTest, refreshAccessToken, createGeminiOauthTokenState, type GeminiOauthTokenState } from "../src/protocol";

/**
 * Regression context: behind a filtering proxy the Google token endpoint can
 * return a gzip body WITHOUT Content-Encoding, so res.json() fails and the
 * failure used to be classified as "login expired" — demanding a re-auth and
 * discarding a perfectly good account. Every management call therefore pins
 * Accept-Encoding: identity.
 */
beforeEach(() => {
  vi.stubEnv("GEMINI_OAUTH_CLIENT_ID", "fixture-client");
  vi.stubEnv("GEMINI_OAUTH_CLIENT_SECRET", "fixture-secret");
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("management-plane transport", () => {
  it("always requests identity encoding unless the caller pinned one", () => {
    const headers = new Headers(boundedInitForTest({ headers: { "content-type": "application/json" } }).headers);
    expect(headers.get("accept-encoding")).toBe("identity");
    const explicit = new Headers(boundedInitForTest({ headers: { "accept-encoding": "gzip" } }).headers);
    expect(explicit.get("accept-encoding")).toBe("gzip");
  });

  it("sends identity encoding on the token refresh call", async () => {
    const seen: Headers[] = [];
    const state = createGeminiOauthTokenState();
    await refreshAccessToken(
      "refresh-fixture",
      (async (_url: string, init: any) => {
        seen.push(new Headers(init.headers));
        return new Response(JSON.stringify({ access_token: "a", expires_in: 3600 }), { headers: { "content-type": "application/json" } });
      }) as any,
      Date.now(),
      undefined,
      state,
    );
    expect(seen[0].get("accept-encoding")).toBe("identity");
  });

  it("keeps the login when the refresh fails transiently instead of demanding re-auth", async () => {
    const state = createGeminiOauthTokenState();
    const error = await refreshAccessToken(
      "refresh-fixture",
      (async () => new Response("upstream down", { status: 503 })) as any,
      Date.now(),
      undefined,
      state,
    ).catch((e: any) => e);
    expect(error.code).toBe("gemini_oauth_transient");
  });

  it("still requires re-auth when Google explicitly rejects the refresh token", async () => {
    const state = createGeminiOauthTokenState();
    const error = await refreshAccessToken(
      "refresh-fixture",
      (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } })) as any,
      Date.now(),
      undefined,
      state,
    ).catch((e: any) => e);
    expect(error.code).toBe("gemini_oauth_reauth_required");
  });
});
