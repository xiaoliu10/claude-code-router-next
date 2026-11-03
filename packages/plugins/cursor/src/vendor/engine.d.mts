/**
 * Type declarations for the vendored Cursor engine (src/vendor/engine.mjs).
 *
 * The implementation is owned upstream: magpie-community/plugins
 * `packages/cursor/index.mjs` @ bace91473b4f113a719a49b7d8ce81fe1f5b5760 (MIT),
 * vendored with the small DI patches listed in ./PATCHES.md. The CCR adapter
 * drives the engine through the seams below; the OpenCode plugin surface
 * (`CursorAuthPlugin`) stays untouched for the vendored tests.
 *
 * All network access flows through the `fetch` the host injects at
 * `configureCursorEngine` time (no ambient fetch when configured, no config
 * reads, no credential storage — the auth service owns persistence).
 */

/**
 * Credential object the engine resolves per request (`_internal.tokenOf`).
 * `oauth` covers both the browser sign-in (access token + refresh marker the
 * engine NEVER uses to renew — an expired browser token requires re-login)
 * and the cursor-agent CLI import (`refresh === "cursor-agent"`; the token is
 * re-read from the CLI's own storage each request). `api` is a Cursor API key
 * exchanged for a token as the CLI does with CURSOR_API_KEY.
 */
export interface CursorAuthOAuth {
  type: "oauth";
  /** Bearer access token ("" for the CLI import; the CLI's own token is used). */
  access: string;
  /** Browser refresh token, "none", or the CLI mark "cursor-agent". */
  refresh: string;
  /** Epoch ms the access token lapses; 0 = unknown/CLI-managed. */
  expires: number;
  accountId?: string;
  plan?: string;
}
export interface CursorAuthApiKey {
  type: "api";
  key: string;
}
export type CursorAuth = CursorAuthOAuth | CursorAuthApiKey;

/** Sign-in outcome of the browser PKCE poll or the CLI import. */
export type CursorSignInResult =
  | { type: "success"; access: string; refresh: string; expires: number; accountId?: string; plan?: string }
  | { type: "failed"; error: string };

export interface CursorSignInMethod {
  url: string;
  instructions: string;
  method: "auto";
  callback(): Promise<CursorSignInResult>;
}

/** One model of the account's usable list (upstream `modelsOf`/`usable`). */
export interface CursorModelInfo {
  id: string;
  name: string;
  /** Context window tokens (DEFAULT_CONTEXT when Cursor says none). */
  context: number;
  run: string;
  title: string;
}

/** Quota window as the dashboard usage read reports it. UNKNOWN-tolerant: a
 *  missing/malformed body yields `{ error }` and the adapter shows "unknown". */
export interface CursorUsageWindow {
  name: string;
  used: number;
  display?: string;
  resetsAt?: string;
  aside?: boolean;
  models?: string[];
  notModels?: string[];
  span?: number;
}
export interface CursorUsageResult {
  windows: CursorUsageWindow[];
  error?: string;
}

export interface CursorChatOptions {
  /** Session name for the conversation_id (upstream `sessionOf` seam). */
  session?: string;
  signal?: AbortSignal;
}

/** Options for configureCursorEngine (PATCHES.md §1). */
export interface CursorEngineOptions {
  /** Host dispatcher fetch; every outbound request rides it when set. */
  fetch?: typeof fetch;
  /** false pins the whole data plane — region retry included — to HTTP/1.1. */
  h2?: boolean;
}

export interface CursorEngineInternal {
  answer(auth: CursorAuth, chat: any, signal?: AbortSignal, session?: string): Promise<Response>;
  answerOf(auth: CursorAuth, chat: any, signal?: AbortSignal, session?: string): Promise<Response>;
  browserSignIn(signal?: AbortSignal): Promise<CursorSignInMethod>;
  cliSignIn(): Promise<CursorSignInMethod>;
  keyToken(key: string): Promise<string>;
  tokenOf(auth: CursorAuth | undefined): Promise<string>;
  usable(tok: string): Promise<CursorModelInfo[]>;
  whoIs(tok: string): Promise<{ email: string; plan: string }>;
  planOf(tok: string): Promise<string>;
  botUsage(tok: string): Promise<CursorUsageWindow[]>;
  usage(tok: string, ids: string[]): Promise<CursorUsageResult>;
  runtimeModel(m: CursorModelInfo): any;
  agentURL(tok: string, fresh?: boolean): Promise<string>;
  unary(base: string, path: string, tok: string, body?: unknown, timeout?: number): Promise<any>;
  clientVersion(): Promise<string>;
  readonly AuthError: ErrorConstructor;
  readonly CLI_MARK: string;
  readonly API: string;
  readonly WEBSITE: string;
  readonly AGENT: string;
  readonly ID: string;
  resetCaches(): void;
  [key: string]: unknown;
}

/** Configure the injected transport (process-wide; call once at activation). */
export function configureCursorEngine(options: CursorEngineOptions): void;
/** The OpenCode plugin surface, kept verbatim for the vendored tests. */
export function CursorAuthPlugin(): Promise<any>;
export const _internal: CursorEngineInternal;
