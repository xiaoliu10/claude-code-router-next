/**
 * WorkBuddy managed runtime — the §16 multi-account pool orchestration,
 * MOVED OUT of the former inline `sendRequestToWorkBuddy` branch in
 * `packages/core/src/api/routes.ts` into the plugin-owned dispatch wrapper
 * (docs/design/provider-plugins.md §2.2, contract §1 items 1–5).
 *
 * The core seam stays GENERIC: `ManagedRuntime.dispatchRequest` receives the
 * core's ordinary single-attempt dispatch as `attempt()` and this wrapper owns
 * ONLY the account-pool loop around it. Per attempt the full generic path runs
 * (ensureUsable/lockUpstream/signRequest/classifyError/noteUpstreamError, the
 * 401-once refresh budget and the plugin confidentiality seams are all inside
 * `attempt()`); the generic same-model retry and fallback chains stay in the
 * core — the wrapper never re-implements them.
 *
 * Rotation bound (contract §16 ruling 3): every uid is attempted at most once
 * per request (the attempted-map survives {...req} spreads and retries), the
 * loop runs at most `poolSize` iterations AND at most MAX_ROTATION_ATTEMPTS —
 * a hard constant cap so a pathological store can never loop unbounded.
 * Terminal classified failures (nonRetryable) stop rotation immediately.
 *
 * Moved behaviors (byte-for-byte, contract §1):
 *  - workbuddy_model_hidden 422 site-wide denylist check before any attempt;
 *  - workbuddy_not_connected 409 when no credential is usable;
 *  - sticky selection + cooldown filtering through the auth service;
 *  - per-attempt credential injection + fixed-HTTPS-origin lock (lockUpstream)
 *    and per-attempt credential/conversation header re-injection (signRequest);
 *  - pre-content SSE envelope inspection (rotation happens BEFORE any byte of
 *    content reaches the client — inspectWorkBuddySse never replays later
 *    errors);
 *  - the 2 MiB edge-read guard probing the billing API exactly once per
 *    credential generation when a LARGE request dies as a bare send failure;
 *  - transient (non-rotatable) failures: one same-account outer retry, never
 *    a pool restart; after a rotation a second transient is terminal;
 *  - client aborts are never swallowed: the original classified send error
 *    propagates (the edge probe can only replace it with a 401-confirmed
 *    reauth classification, exactly like the former inline branch).
 */
import type { ManagedRuntime, PluginClassifiedError } from "./core-types";
import type { WorkBuddyAuthService } from "./auth-service";
import {
  classifyWorkBuddyError,
  conversationHeaders,
  credentialHeaders,
  isWorkBuddyRuntime,
  nextWorkBuddyQuotaReset,
  workBuddyChatUrl,
  workBuddyEnvelopeIsError,
  workBuddyPoolExhaustedError,
  workBuddySite,
  workBuddySiteFromProvider,
  type WorkBuddyCooldown,
  type WorkBuddyCredential,
} from "./protocol";

/** Exactly the former core terminal-code list; generic host semantics consume
 * pluginClassified + nonRetryable, never provider-specific field names. */
export const WORKBUDDY_TERMINAL_CODES = new Set([
  "workbuddy_reauth", "workbuddy_protocol_error", "workbuddy_model_hidden",
  "workbuddy_not_connected", "rate_limit", "insufficient_quota", "workbuddy_account_restricted",
]);

/** Numeric upstream codes behind the classified classes that permit rotation. */
export const WORKBUDDY_ROTATE_CLASS_CODES = {
  insufficientQuota: 14018,
  accountRestricted: 11140,
  rateLimit: 6004,
} as const;

/** WorkBuddy's front door resets the connection once a refused sign-in's request body
 * passes EDGE_READS bytes (measured on both builds, magpie P:L1152-1160). Above that
 * size a bare ECONNRESET says nothing about the cause, so the send failure is probed
 * instead of guessed. (Moved verbatim from the former inline branch.) */
const WORKBUDDY_EDGE_READS = 2 * 1024 * 1024;
function exceedsWorkBuddyEdgeReads(body: any): boolean {
  try { return Buffer.byteLength(JSON.stringify(body ?? {})) > WORKBUDDY_EDGE_READS; }
  catch { return false; }
}

/**
 * Hard rotation cap (contract §16 ruling 3 + host requirement): the pool loop
 * never exceeds the site's account count AND never exceeds this constant,
 * whatever a credential store reports. The store itself normalizes pools to
 * ≤ 64 accounts; this cap is the belt to that suspend.
 */
const MAX_ROTATION_ATTEMPTS = 8;

/**
 * The SSE prefix inspector throws the PROTOCOL classification directly
 * (outside the runtime classifier bridge), so it carries `cooldownSeconds`
 * rather than the seam's `cooldownMs`. Normalize at the throw site so the
 * wrapper's cooldown mapper sees the upstream "resets at …" window exactly
 * like the HTTP/hidden-JSON path; class codes stay untouched.
 */
function normalizeSseProtocolError(error: any): any {
  if (error?.workbuddy === true && !error.pluginClassified) {
    withManagedMarkers(error);
    error.nonRetryable = WORKBUDDY_TERMINAL_CODES.has(error.code);
    const seconds = Number(error.cooldownSeconds);
    if (Number.isFinite(seconds) && seconds > 0 && !Number.isFinite(Number(error.cooldownMs))) {
      error.cooldownMs = seconds * 1000;
    }
  }
  return error;
}

/**
 * Inspect only the pre-content SSE prefix. No bytes have reached the client at
 * this point: a classified error may safely rotate accounts. After any useful
 * content/tool/reasoning delta (or the bounded inspection budget) we return a
 * byte-identical replay stream and NEVER inspect/replay a later error.
 * (Moved verbatim from the former inline branch; classification and the
 * envelope predicate come from the plugin's protocol module.)
 */
async function inspectWorkBuddySse(response: Response): Promise<Response> {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let pending = "", bytes = 0, done = false, committed = false;
  try {
    while (!done && !committed && bytes < 256 * 1024) {
      const next = await reader.read();
      done = next.done;
      if (next.value) {
        chunks.push(next.value);
        bytes += next.value.byteLength;
        pending += decoder.decode(next.value, { stream: true });
      }
      // SSE permits an unterminated final event; inspect it on EOF as well.
      if (done) pending += decoder.decode() + "\n\n";
      const events = pending.split(/\r\n\r\n|\n\n|\r\r/);
      pending = events.pop() ?? "";
      for (const event of events) {
        const data = event.split(/\r\n|\r|\n/).filter(line => line.startsWith("data:"))
          .map(line => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        if (data === "[DONE]") { committed = true; break; }
        let value: any;
        try { value = JSON.parse(data); } catch { committed = true; break; }
        if (workBuddyEnvelopeIsError(value)) throw normalizeSseProtocolError(classifyWorkBuddyError(response.status, value));
        committed = value?.choices?.some((choice: any) => {
          const delta = choice.delta ?? choice.message;
          return delta && Object.entries(delta).some(([key, v]) => key !== "role" && v != null && v !== "" && (!Array.isArray(v) || v.length > 0));
        }) || false;
        if (committed) break;
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < chunks.length) { controller.enqueue(chunks[index++]); return; }
      if (done) { controller.close(); reader.releaseLock(); return; }
      try {
        const next = await reader.read();
        if (next.done) { done = true; controller.close(); reader.releaseLock(); }
        else controller.enqueue(next.value);
      } catch (error) { controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/**
 * Wrapper-owned classified errors carry TODAY'S exact code/status/message
 * surface plus the generic plugin markers, so the core's generic terminal
 * semantics (nonRetryable → rememberPluginFailure budget) engage while the
 * client-visible payload stays identical to the former inline branch.
 */
function managedError(code: string, message: string, statusCode: number, extra: Record<string, any> = {}): Error & Record<string, any> {
  return Object.assign(new Error(message), {
    code, statusCode, workbuddy: true as const, nonRetryable: true,
    plugin: "workbuddy", pluginClassified: true, ...extra,
  });
}

const workbuddyModelHiddenError = () =>
  managedError("workbuddy_model_hidden", "WorkBuddy 模型已隐藏，请在管理页恢复后重试", 422);
const workbuddyNotConnectedError = () =>
  managedError("workbuddy_not_connected", "WorkBuddy 未导入登录态，请先在管理页导入", 409);

/** Attach the generic plugin markers to a protocol-built terminal error. */
function withManagedMarkers(error: Error & Record<string, any>): Error & Record<string, any> {
  error.plugin = "workbuddy";
  error.pluginClassified = true;
  return error;
}

/**
 * §16 failover cooldown for a CLASSIFIED upstream error (the plugin-seam
 * counterpart of the protocol's `workBuddyFailoverCooldown`, which reads the
 * inline error surface with numeric upstream codes). The classifier produces a
 * fixed class code per upstream code, so the mapping is exact:
 *  - insufficient_quota (14018) → account-scoped until the next local 00:05
 *    (daily slice reset), capped at 24h;
 *  - workbuddy_account_restricted (11140) → account-scoped 7200s;
 *  - rate_limit (6004 / HTTP 429) → model-scoped for THIS model using the
 *    classifier's parsed reset time (cooldownMs), else 15 minutes;
 *  - everything else (reauth, protocol 10085, permission/invalid request,
 *    network) → null: terminal or transient classes never rotate.
 * `test/managed-runtime.test.ts` pins the class-by-class equivalence against
 * the protocol's original mapper.
 */
export function workBuddyFailoverCooldownFromInfo(
  error: { code?: string; cooldownMs?: number; statusCode?: number; httpStatus?: number },
  model?: string,
  now = Date.now(),
): WorkBuddyCooldown | null {
  switch (error?.code) {
    case "insufficient_quota":
      return { scope: "account", until: nextWorkBuddyQuotaReset(now), code: WORKBUDDY_ROTATE_CLASS_CODES.insufficientQuota };
    case "workbuddy_account_restricted":
      return { scope: "account", until: now + 7200 * 1000, code: WORKBUDDY_ROTATE_CLASS_CODES.accountRestricted };
    case "rate_limit": {
      const ms = Number(error.cooldownMs);
      const until = now + (Number.isFinite(ms) && ms > 0 ? ms : 900_000);
      return model && model.trim()
        ? { scope: "model", model: model.trim(), until, code: WORKBUDDY_ROTATE_CLASS_CODES.rateLimit }
        : { scope: "account", until, code: WORKBUDDY_ROTATE_CLASS_CODES.rateLimit };
    }
    default:
      return null;
  }
}

/** Dispatch input provided by the core's generic seam (mirror of PluginDispatchInput). */
export interface WorkBuddyDispatchInput {
  attempt(): Promise<Response>;
  requestBody: any;
  config: any;
  provider: any;
  req?: any;
}

export interface WorkBuddyRuntimeOptions {
  service: WorkBuddyAuthService;
  /** ctx.host.getDirectDispatcher — fixed origins bypass CCR/proxy env routing. */
  getDirectDispatcher: () => unknown;
  /** Activation logger (PluginContext.log). Classifications only, never credentials. */
  log?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
}

/**
 * Build the WorkBuddy ManagedRuntime. Every activation creates a fresh
 * instance (Node may reuse the plugin module; runtime state must never be a
 * module singleton).
 */
export function createWorkBuddyManagedRuntime(options: WorkBuddyRuntimeOptions): ManagedRuntime {
  const { service } = options;
  // lockUpstream records the credential it locked per config object so a host
  // that does not pass `config` to signRequest (older coreApi hosts) can still
  // resolve it; the current host passes config, which always wins.
  const lockedCredentials = new WeakMap<object, WorkBuddyCredential>();

  const requireCredential = async (config: any, provider: any, requestBody: any): Promise<WorkBuddyCredential> => {
    const direct = config?.workbuddyCredential
      ?? (config ? lockedCredentials.get(config) : undefined);
    if (direct) return direct;
    // Degraded old-host path: sticky selection, no rotation awareness.
    const sticky = await service.currentCredential(workBuddySiteFromProvider(provider), requestBody?.model);
    if (!sticky) throw new Error("WorkBuddy 未导入登录态，请先在管理页导入");
    return sticky;
  };

  /**
   * Edge guard (contract §1 item 3, semantics moved verbatim): when a LARGE
   * request dies as a bare send-level failure (plugin seam marks those with
   * upstreamStatus 0; aborts/timeouts keep their error name), probe the
   * billing API once per credential generation. A 401 becomes the terminal
   * reauth classification; anything else keeps the original error. The
   * original request is never re-sent and an abort is never swallowed.
   */
  const probeEdgeReset = async (error: any, credential: WorkBuddyCredential, requestBody: any): Promise<void> => {
    if (error?.pluginClassified !== true || error?.upstreamStatus !== 0) return;
    if (["AbortError", "TimeoutError"].includes(error?.upstreamErrorName)) return;
    if (!exceedsWorkBuddyEdgeReads(requestBody)) return;
    const reauth = await service.diagnoseReset(credential);
    if (reauth) throw withManagedMarkers(reauth);
  };

  const runtime: ManagedRuntime = {
    name: "workbuddy",
    isManaged: (provider) => isWorkBuddyRuntime(provider),
    // No ensureUsable breaker: the §16 pool performs its own usability checks
    // (hidden denylist, credential selection with cooldown filtering) inside
    // the wrapper at the exact pipeline position the former inline branch
    // used — after the transformer chain, before the first upstream byte.
    lockUpstream: async (config: any, provider: any) => {
      const credential = await requireCredential(config, provider, undefined);
      if (config) lockedCredentials.set(config, credential);
      const fixed = new URL(workBuddyChatUrl(workBuddySite(credential.kind)));
      if (fixed.protocol !== "https:") throw new Error("WorkBuddy 上游地址不合法");
      // A config-supplied base_url can never win; never follow a redirect away
      // from the fixed origin; fixed origins ignore CCR/proxy env routing.
      config.url = fixed.toString();
      config.redirect = "error";
      config.dispatcher = options.getDirectDispatcher();
    },
    signRequest: async ({ headers, requestBody, provider, config }: { headers: Record<string, string>; requestBody: any; provider: any; config?: any }) => {
      const credential = await requireCredential(config, provider, requestBody);
      const next: Record<string, string> = { ...headers };
      // The marker api_key and every stale credential/conversation identity
      // are stripped, then re-injected from THIS attempt's credential — a
      // rotated account can never inherit the previous account's (or the
      // client's) auth material, and conversation ids are minted per attempt
      // exactly like the former per-attempt transformer auth() call.
      for (const key of Object.keys(next)) {
        if ([
          "authorization", "x-api-key", "host", "proxy-authorization",
          "x-user-id", "x-domain", "x-enterprise-id", "x-tenant-id",
          "x-conversation-id", "x-conversation-request-id", "x-conversation-message-id", "x-request-id",
        ].includes(key.toLowerCase())) delete next[key];
      }
      Object.assign(next, credentialHeaders(credential));
      Object.assign(next, conversationHeaders(requestBody));
      return next;
    },
    classifyError: (status: number, body: unknown, _systemText: string): PluginClassifiedError | null => {
      // Send-level failures (status 0) stay unclassified: the core's safe
      // default is retryable, which preserves the generic one-shot same-model
      // retry for transient network faults (former inline behavior: raw
      // error, generic retry). The edge guard probes these separately.
      if (status === 0) return null;
      let parsed: any = body;
      if (typeof parsed === "string") { try { parsed = JSON.parse(parsed); } catch { /* keep raw */ } }
      const error = classifyWorkBuddyError(status, parsed ?? body);
      // Retryability mirrors the former inline terminal semantics
      // (isTerminalWorkBuddyError): only the account-terminal classes stop the
      // generic same-model retry and fallback chains. Unmapped upstream codes,
      // permission and request-shape classes keep the generic one-shot retry,
      // exactly like the inline branch did.
      const terminal = WORKBUDDY_TERMINAL_CODES.has(error.code);
      return {
        code: error.code,
        // The core replaces the message with its fixed safe client text; the
        // classifier's sanitized hint never carries upstream strings anyway.
        message: error.message,
        httpStatus: error.statusCode,
        ...(error.cooldownSeconds ? { cooldownMs: error.cooldownSeconds * 1000 } : {}),
        retryable: !terminal,
      } as PluginClassifiedError;
    },
    // HTTP-200 {code,msg,data} envelope predicate (contract §5.4): the core's
    // SECONDARY net for bodies the wrapper already returned; rotation on such
    // envelopes normally happens inside attempt() (pinned by tests both ways).
    isErrorEnvelope: (body: unknown): boolean => workBuddyEnvelopeIsError(body),
    // noteUpstreamError stays unset: cooldown bookkeeping belongs to the pool
    // loop (markAccountCooldown), which knows the attempted account.
    // No authRefresh: §14/§15 renewal is pull-based inside currentCredential
    // (desktop re-read / browser single-flight refresh), never 401-triggered.
    suppressDebugLog: true,

    // ---------------------------------------------------------------
    // §16 pool orchestration (the moved sendRequestToWorkBuddy body).
    // ---------------------------------------------------------------
    dispatchRequest: async (input: WorkBuddyDispatchInput): Promise<Response> => {
      const { attempt, requestBody, config, provider } = input;
      const site = workBuddySiteFromProvider(provider);
      const model = requestBody?.model;
      if (await service.isModelHidden(site, model)) throw workbuddyModelHiddenError();
      // Hard rotation bound: pool size AND the constant cap (see above).
      const poolSize = Math.min(await service.poolAccountCount(site), MAX_ROTATION_ATTEMPTS);
      // One request may retry (generic same-model retry, fallback's {...req}
      // spread); the ROTATION budget must survive those, so it lives on the
      // request object. A transient (non-rotatable) failure may still retry
      // the SAME account once via the outer retry — that is not an account
      // rotation and stays within the contract's per-request upstream-attempt
      // bound (retry is one-shot).
      const reqState: any = input.req ?? {};
      const state: any = (reqState.__workbuddyState ??= { attempted: new Map(), transient: new Set() });
      const attempted = state.attempted.get(site) ?? new Set<string>();
      state.attempted.set(site, attempted);
      let lastError: any;
      while (attempted.size < poolSize) {
        const credential = await service.currentCredential(site, model, [...attempted]);
        if (!credential || attempted.has(credential.uid)) break;
        attempted.add(credential.uid);
        try {
          // The per-attempt credential rides on the shared config object: the
          // loop is strictly sequential, lockUpstream/signRequest read it per
          // attempt, and the former per-attempt config copy is not needed
          // because nothing on the seam mutates config.headers any more.
          if (config) config.workbuddyCredential = credential;
          const response = await attempt();
          return await inspectWorkBuddySse(response);
        } catch (error: any) {
          // SSE inspection throws the protocol surface directly (outside the
          // core classifier); attach the SAME generic terminal semantics and
          // cooldown surface as the classifier bridge (see normalize above).
          normalizeSseProtocolError(error);
          await probeEdgeReset(error, credential, requestBody);
          const cooldown = workBuddyFailoverCooldownFromInfo(error, model);
          if (!cooldown) {
            // A transient failure after a prior rotation must not restart the
            // pool through the outer generic retry and exceed this request's
            // budget. Terminality is forced exactly like the former inline
            // branch's workbuddyPoolAttempted marker: the next generic layer
            // must never re-dispatch this request.
            if (lastError) {
              const terminal = error;
              terminal.nonRetryable = true;
              throw terminal;
            }
            // Transient: the outer same-model retry may re-attempt this account.
            state.transient.add(site);
            throw error;
          }
          state.transient.delete(site);
          lastError = error;
          // Persist even for the last account: future requests must not hammer it.
          try { await service.markAccountCooldown(site, credential.uid, cooldown); }
          catch { throw error; } // preserve sanitized upstream error, never a raw filesystem error
          // Classifications only: no uid, body, token, or thrown store diagnostic.
          options.log?.info(`WorkBuddy account cooldown recorded (code=${String(error?.code)})`);
        }
      }
      if (lastError) { state.transient.delete(site); throw lastError; }
      if (attempted.size >= poolSize && poolSize > 0) {
        // Budget exhausted by earlier attempts of this same request. A pending
        // transient failure gets exactly one same-account retry (not a
        // rotation); anything else is the §16 terminal pool-exhausted error.
        if (state.transient.has(site)) {
          state.transient.delete(site);
          const credential = await service.currentCredential(site, model);
          if (credential) {
            try {
              if (config) config.workbuddyCredential = credential;
              const response = await attempt();
              return await inspectWorkBuddySse(response);
            } catch (retryError: any) {
              normalizeSseProtocolError(retryError);
              await probeEdgeReset(retryError, credential, requestBody);
              // Same cooldown bookkeeping as an in-loop attempt, so this
              // account cannot escape its cooldown for one later request.
              const cooldown = workBuddyFailoverCooldownFromInfo(retryError, model);
              if (cooldown) {
                try { await service.markAccountCooldown(site, credential.uid, cooldown); }
                catch { throw retryError; }
              }
              throw retryError;
            }
          }
        }
        throw withManagedMarkers(workBuddyPoolExhaustedError(await service.poolCooldownRemainingMs(site, model)));
      }
      if (poolSize) throw withManagedMarkers(workBuddyPoolExhaustedError(await service.poolCooldownRemainingMs(site, model)));
      throw workbuddyNotConnectedError();
    },
  };
  return runtime;
}
