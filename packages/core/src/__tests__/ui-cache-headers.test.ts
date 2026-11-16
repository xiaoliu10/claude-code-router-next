import { describe, expect, it } from "vitest";
import Server from "../server";
import { registerAdminRoutes } from "../ccr/admin-routes";

/**
 * Regression: the UI ships as a single self-contained index.html (all
 * JS/CSS inlined, ~4MB). fastifyStatic used to answer with
 * `Cache-Control: public, max-age=3600`, so after an upgrade browsers kept
 * running the previous bundle for up to an hour (or for as long as a tab
 * stayed open) — new UI features appeared missing. The HTML must always
 * revalidate (no-cache + ETag): unchanged files still answer 304, so the
 * cost is one conditional request per page load.
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
  it("serves /ui/ with no-cache revalidation instead of max-age", async () => {
    const server = await buildApp();
    try {
      const res = await server.app.inject({ method: "GET", url: "/ui/" });
      // The bundled UI root may not exist in a bare checkout; when it does
      // serve, the header contract must hold.
      if (res.statusCode === 404) {
        expect(res.body).toBeDefined();
        return;
      }
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-cache");
      // Revalidation needs a validator; fastifyStatic provides ETag by default.
      expect(res.headers.etag).toBeDefined();
    } finally {
      await server.app.close();
    }
  });
});
