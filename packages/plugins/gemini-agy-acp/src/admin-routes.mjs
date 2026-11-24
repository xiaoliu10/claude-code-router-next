/**
 * Gemini Agy ACP — the local-only, explicit user-action admin routes under the
 * `/api/gemini-agy-acp` namespace, mirroring the codex / gemini-oauth guard
 * shape: the loopback socket address is the only trustworthy identity, plus a
 * Host/Origin allowlist pinned to the actual bound port. A browser Origin must
 * match our authority; an originless loopback request (local CLI) is allowed.
 *
 *  GET  /status          → redacted status shape for the management card
 *  POST /install         {} — kick off the official agy auto-install
 *  POST /connect         {binary?, apiKey?}
 *  POST /disconnect      {}
 *  POST /models/sync     {}
 *  POST /models/visibility {hide?: [ids], restore?: [ids]}
 *
 * Two secrecy rules travel with every route:
 *  - the sidecar apiKey is never serialized, logged or echoed — responses
 *    carry `apiKeyConfigured` only;
 *  - no route ever answers 401: the UI's global fetch layer intercepts every
 *    401 as an expired CCR api key (wipe + redirect), so account-level auth
 *    failures travel as 422 and keep their stable code.
 * Failures are stable code tokens (agy_* / acp_*) with a mapped HTTP status;
 * raw upstream messages, subprocess stderr and binary diagnostics never cross.
 */

export function registerAdminRoutes(app, { getService }) {
  /** Local-only guard, identical in shape to the codex plugin's. */
  function assertLocalAgyRequest(req) {
    const deny = () => {
      const error = new Error('agy_unauthorized');
      error.statusCode = 403;
      throw error;
    };
    const ip = req.ip || req.connection?.remoteAddress || '';
    const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!isLoopback) deny();
    const origin = req.headers?.origin;
    let host = '';
    try {
      if (origin !== undefined && origin !== '') {
        if (typeof origin !== 'string') deny();
        const parsed = new URL(origin);
        if (!['http:', 'https:'].includes(parsed.protocol)) deny();
        host = parsed.host;
      }
    } catch {
      deny();
    }
    const address = app.server?.address?.();
    const port = typeof address?.port === 'number' && address.port > 0 ? address.port : 3456;
    const allowed = new Set([
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `[::1]:${port}`,
    ]);
    const authority = req.headers?.host;
    if (typeof authority === 'string' && !allowed.has(authority)) deny();
    if (host && !allowed.has(host)) deny();
  }

  const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/;

  /** Shared catch: 403 from the socket guard, otherwise the error's own safe
   * code and mapped status (401 deliberately remapped to 422, see header);
   * unknown errors collapse to a constant 500 label with the message dropped. */
  function agyRouteError(error, reply, route) {
    if (error?.statusCode === 403) {
      reply.status(403);
      return { ok: false, success: false, error: 'agy_unauthorized' };
    }
    const code = typeof error?.code === 'string' && SAFE_CODE.test(error.code) ? error.code : 'agy_route_failed';
    const raw = error?.statusCode;
    const status = Number.isInteger(raw) && raw >= 400 && raw <= 599 ? (raw === 401 ? 422 : raw) : 500;
    if (status === 500) {
      app.log?.warn?.({ route: `gemini-agy-acp/${route}`, code }, 'gemini-agy-acp management route failed');
    }
    reply.status(status);
    return { ok: false, success: false, error: code };
  }

  function service(reply) {
    const resolved = getService();
    if (!resolved) {
      reply.status(503);
      return null;
    }
    return resolved;
  }

  app.get('/api/gemini-agy-acp/status', async (req, reply) => {
    try {
      assertLocalAgyRequest(req);
      const resolved = service(reply);
      if (!resolved) return { ok: false, success: false, error: 'agy_route_failed' };
      return await resolved.status();
    } catch (error) {
      return agyRouteError(error, reply, 'status');
    }
  });

  app.post('/api/gemini-agy-acp/install', async (req, reply) => {
    try {
      assertLocalAgyRequest(req);
      const resolved = service(reply);
      if (!resolved) return { ok: false, success: false, error: 'agy_route_failed' };
      // Kicks off the single-flight background install and answers with the
      // current status immediately; the card polls /status for completion.
      return { ok: true, success: true, ...(await resolved.install()) };
    } catch (error) {
      return agyRouteError(error, reply, 'install');
    }
  });

  app.post('/api/gemini-agy-acp/connect', async (req, reply) => {
    try {
      assertLocalAgyRequest(req);
      const resolved = service(reply);
      if (!resolved) return { ok: false, success: false, error: 'agy_route_failed' };
      // {ok,success,...status}: the card refreshes its status line straight
      // from the mutation response; the status shape carries no key material.
      return { ok: true, success: true, ...(await resolved.connect(req.body)) };
    } catch (error) {
      return agyRouteError(error, reply, 'connect');
    }
  });

  app.post('/api/gemini-agy-acp/disconnect', async (req, reply) => {
    try {
      assertLocalAgyRequest(req);
      const resolved = service(reply);
      if (!resolved) return { ok: false, success: false, error: 'agy_route_failed' };
      return { ok: true, success: true, ...(await resolved.disconnect()) };
    } catch (error) {
      return agyRouteError(error, reply, 'disconnect');
    }
  });

  app.post('/api/gemini-agy-acp/models/sync', async (req, reply) => {
    try {
      assertLocalAgyRequest(req);
      const resolved = service(reply);
      if (!resolved) return { ok: false, success: false, error: 'agy_route_failed' };
      const result = await resolved.syncModels();
      return { ok: true, success: true, ...result };
    } catch (error) {
      return agyRouteError(error, reply, 'models/sync');
    }
  });

  app.post('/api/gemini-agy-acp/models/visibility', async (req, reply) => {
    try {
      assertLocalAgyRequest(req);
      const resolved = service(reply);
      if (!resolved) return { ok: false, success: false, error: 'agy_route_failed' };
      // {ok,success,...status}: same envelope as the other mutations, so the
      // card refreshes its model list straight from the response.
      return { ok: true, success: true, ...(await resolved.hideModels(req.body)) };
    } catch (error) {
      return agyRouteError(error, reply, 'models/visibility');
    }
  });
}
