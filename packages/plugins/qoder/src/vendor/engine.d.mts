/**
 * Type declarations for the vendored Qoder engine (src/vendor/engine.mjs).
 *
 * The implementation is owned by the engine lane and is extracted from
 * magpie-community/plugins `packages/qoder/index.mjs` (see the engine file's
 * provenance header). Tests exercise the real engine directly; the host
 * service additionally accepts an injected engine for isolated unit tests.
 *
 * Scope: qoder.com (international) and qoder.cn (Qoder CN), PAT sign-in. Every
 * host (openapi, api, web) resolves from the selected `site`; the protocol
 * paths are identical on both. All network access flows through the `fetch`
 * the host injects at factory time (no ambient fetch, no env, no home
 * directory, no network at import).
 */

/** Credential the engine derives from a PAT exchange (L362-413 of upstream). */
export interface QoderCredential {
  /** Job token used as the Bearer for api3/openapi calls. */
  access: string;
  /** Job-token refresh token; spent once per exchange upstream. */
  refresh: string;
  /** Epoch ms when the job token lapses. */
  expires: number;
  /** Qoder user id (required by the engine at sign-in). */
  uid: string;
  email: string;
  name: string;
  /** email when present, else uid. */
  accountId: string;
  machineId: string;
  /** The personal access token itself; kept for re-exchange when refresh lapses. */
  pat: string;
}

/** One model of the api3 listing, normalized from upstream modelInfo (L543-584). */
export interface QoderModelInfo {
  key: string;
  name: string;
  context: number;
  images: boolean;
  efforts: string[];
  thinks: boolean;
  free: boolean;
  rate: number;
  rateWas: number;
  source: string;
}

/** Usage reading: parsed quota windows plus the sign-in marker. */
export interface QoderUsageResult {
  windows: Array<{ name: string; used: number; display: string }>;
  plan?: string;
  until?: string;
  /** Set when the upstream payload was missing or malformed. */
  error?: string;
  signIn: "kept";
}

/** Options for createQoderEngine — `fetch` is REQUIRED and host-supplied. */
export interface QoderEngineOptions {
  /** Host dispatcher fetch (redirect: "error" is the caller's duty). */
  fetch: typeof fetch;
  /**
   * Subscription site whose hosts the engine talks to (default "qoder", the
   * international qoder.com endpoints). The host always passes it; an engine
   * that predates the option simply ignores it.
   */
  site?: "qoder" | "qoder-cn";
  /** Lifetime signal: governs in-flight work; dispose() aborts nothing. */
  signal?: AbortSignal;
  /** Injectable clock for expiry/lead math (tests). */
  now?: () => number;
  /**
   * Fired after each SUCCESSFUL INTERNAL auto-renewal (never after an explicit
   * refresh(cred)). The host persists the rotated pair through its own chain;
   * fire-and-forget — it must not turn a successful renewal into a failure.
   */
  onRefresh?: (next: QoderCredential) => void;
}

export interface QoderChatOptions {
  /** Stable session id (drives Qoder's session/task naming). */
  session?: string;
  signal?: AbortSignal;
}

export interface QoderEngine {
  /** Validate a `pt-` PAT, exchange it for a job token and read userinfo. */
  connectPAT(pat: string): Promise<QoderCredential>;
  /**
   * Single-flight job-token refresh. 401/403 upstream marks the sign-in gone;
   * when the PAT itself is refused the thrown Error carries `expired: true`.
   */
  refresh(cred: QoderCredential): Promise<QoderCredential>;
  /** api3 model listing (cached per uid; `again` forces a refetch). */
  models(cred: QoderCredential, again?: boolean): Promise<QoderModelInfo[]>;
  /** Full ask()/queue/SSE chat transaction; resolves to an SSE or error Response. */
  chat(cred: QoderCredential, chatBody: any, options?: QoderChatOptions): Promise<Response>;
  /** openapi usage reading for the credential's PAT path. */
  usage(cred: QoderCredential): Promise<QoderUsageResult>;
  /** Clear listing/spent/task caches; aborts nothing (lifetime signal governs). */
  dispose(): void;
  /** Test seams (cosyHeaders, encodeBody, failure, parseUsage, ...). */
  _internal: Record<string, unknown>;
}

export function createQoderEngine(options: QoderEngineOptions): QoderEngine;
