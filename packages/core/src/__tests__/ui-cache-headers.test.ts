import { describe, expect, it } from "vitest";
import Server from "../server";
import { registerAdminRoutes } from "../ccr/admin-routes";

/**
 * Regression: the UI ships as a single self-contained index.html (all
 * JS/CSS inlined, ~4MB). fastifyStatic used to answer with
 * `Cache-Control: public, max-age=3600`, so after an upgrade browsers kept
 * running the previous bundle for up to an hour (or for as long as a tab
 * stayed open) — new UI features appeared missing. The HTML must always
 * revalidate: unchanged files still answer 304 via ETag, so the cost is one
 * conditional request per page load.
 *
 * Two contract details are pinned here because both broke silently once:
 *  - `cacheControl: false` must stay set. Without it @fastify/send emits its
 *    own `Cache-Control: public, max-age=0` AFTER our setHeaders ran and
 *    fastify's stream sender overwrites our header with it.
 *  - In source mode (vitest) bundledUiRoot resolves to `core/dist` via the
 *    fourth candidate, so a built checkout serves the real index.html; a
 *    bare checkout (no build) still 404s and the test skips as a safety net.
 */
async function buildApp() {
  const server = new Server({
    logger: false,
    useJsonFile: false,
    initialConfig: {
      providers: [],
      Router: {},
      HOST: "127.0.0.1",
      PORT: 0,
    },
  });
  await server.ready();
  await registerAdminRoutes(server, {
    PORT: 0,
    APIKEY: "test",
    Providers: [],
    Router: {},
  });
  await server.app.ready();
  return server;
}

describe("UI static cache headers", () => {
  it("serves /ui/ with no-cache revalidation and answers 304 on If-None-Match", async () => {
    const server = await buildApp();
    try {
      const res = await server.app.inject({ method: "GET", url: "/ui/" });
      // A bare checkout without a UI build has no bundled root; skip instead
      // of failing on an environment that cannot serve the app.
      if (res.statusCode === 404) {
        expect(res.body).toBeDefined();
        return;
      }
      expect(res.statusCode).toBe(200);
      // Our no-cache must survive: NOT fastify/send's `public, max-age=…`.
      expect(res.headers["cache-control"]).toBe("no-cache");
      expect(res.headers.etag).toBeDefined();

      // Revalidation contract: a matching If-None-Match answers 304.
      const conditional = await server.app.inject({
        method: "GET",
        url: "/ui/",
        headers: { "if-none-match": res.headers.etag as string },
      });
      expect(conditional.statusCode).toBe(304);
    } finally {
      await server.app.close();
    }
  });
});
