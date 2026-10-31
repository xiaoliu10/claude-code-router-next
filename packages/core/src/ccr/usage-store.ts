import { existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { openSqliteDatabase, type SqliteDatabase, type SqliteStatement } from "@wengine-ai/claude-code-router-shared";
import {
  HOME_DIR,
  sanitizeTempFileKey,
  TOKEN_SPEED_TEMP_SUBDIRECTORY,
} from "@wengine-ai/claude-code-router-shared";

// HOME_DIR already honors CCR_CONFIG_DIR, so tests that point it at a temp dir
// cannot write usage into the real ~/.claude-code-router database.
const DATA_DIR = join(HOME_DIR, "data");
const USAGE_DB_FILE = join(DATA_DIR, "usage.sqlite");
const LEGACY_USAGE_FILE = join(DATA_DIR, "usage.jsonl");
const MIN_DECODE_DURATION_SECONDS = 1;
const USAGE_RETENTION_DAYS = 180;
const RETENTION_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const LEGACY_MIGRATION_META_KEY = "legacy_usage_jsonl_migrated_at";

type UsageStatus = "success" | "error";

type UsageRecordRow = {
  id: string;
  timestamp: string;
  session_id: string;
  provider: string;
  original_model: string;
  model: string;
  upstream_model: string | null;
  model_family: string;
  scenario_type: string;
  client_type: string | null;
  stream: number;
  usage_estimated: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  ttft: number | null;
  tokens_per_second: number | null;
  duration_ms: number;
  status: UsageStatus;
  error_message: string | null;
  response_body: string | null;
};

interface QueryWhereClause {
  sql: string;
  params: Array<string | number>;
}

export interface UsageRecord {
  id: string;
  timestamp: string;
  sessionId: string;
  provider: string;
  originalModel: string; // Original request model before routing
  model: string; // Actual routed model
  upstreamModel?: string; // Model returned by the upstream provider (may differ from routed model)
  modelFamily: string;
  scenarioType: string;
  clientType?: string; // "claude-code" | "zcode" | "codex" | "pi" | "qwen-code" | "opencode" | "api" | "unknown"
  stream: boolean;
  usageEstimated?: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  ttft: number | null;
  tokensPerSecond: number | null;
  durationMs: number;
  status: UsageStatus;
  errorMessage?: string;
  responseBody?: string; // Full response body for error cases
}

export interface UsageSummary {
  estimatedCount: number;
  totalRequests: number;
  successCount: number;
  errorCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadInputTokens: number;
  totalCacheCreationInputTokens: number;
  avgTtft: number | null;
  avgTokensPerSecond: number | null;
  byModel: Record<string, { count: number; inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>;
  byProvider: Record<string, { count: number; inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>;
  byScenario: Record<string, { count: number; inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>;
  byFamily: Record<string, { count: number; inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>;
  byDay: Record<string, { count: number; inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>;
  byClient: Record<string, { count: number; inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>;
}

export interface UsageQueryFilters {
  startTime?: string;
  endTime?: string;
  model?: string;
  provider?: string;
  scenario?: string;
  clientType?: string;
  sessionId?: string;
  status?: UsageStatus;
  page?: number;
  pageSize?: number;
}

export interface UsageQueryResult {
  records: UsageRecord[];
  summary: UsageSummary;
  total: number;
  page: number;
  pageSize: number;
}

let dbInstance: SqliteDatabase | null = null;
let insertStatement: SqliteStatement | null = null;
let lastRetentionPruneAt = 0;

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function getDb(): SqliteDatabase {
  if (dbInstance) return dbInstance;

  ensureDataDir();
  const opened = openSqliteDatabase(USAGE_DB_FILE);
  const db = opened.db;
  if (opened.driver === "node:sqlite") {
    // One-time loud notice: the native addon did not load under this Node
    // (ABI mismatch, e.g. a desktop app injecting its own node into PATH).
    // node:sqlite keeps usage working; rebuilding better-sqlite3 restores it.
    console.error(
      `[usage] better-sqlite3 unavailable, using built-in node:sqlite fallback. ` +
      `Reason: ${opened.fallbackReason}`
    );
  }
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  // Schema versioning: only run DDL when initializing a fresh database.
  // Future migrations should check the current version and apply incremental changes.
  const currentVersion = (db.pragma("user_version", { simple: true }) as number) || 0;
  if (currentVersion < 1) {
    initializeSchema(db);
    db.pragma("user_version = 1");
  }
  if (currentVersion < 2) {
    // v2: track the model the upstream provider actually returned, so gateway
    // model swaps (e.g. silently routing glm-5 to a MiniMax backend) are visible.
    const columns = db.prepare("PRAGMA table_info(usage_records)").all() as { name: string }[];
    if (!columns.some((c) => c.name === "upstream_model")) {
      db.exec("ALTER TABLE usage_records ADD COLUMN upstream_model TEXT");
    }
    db.pragma("user_version = 2");
  }
  if (currentVersion < 3) {
    // Additive migration: historical and unmarked providers remain metered.
    db.exec("ALTER TABLE usage_records ADD COLUMN usage_estimated INTEGER NOT NULL DEFAULT 0");
    db.pragma("user_version = 3");
  }
  migrateLegacyUsageJsonl(db);
  pruneExpiredRecords(db, true);

  // NOTE: legacy databases may still carry codex_account_id/codex_account_email
  // columns from the removed account management feature. They are intentionally
  // left in place (no destructive migration) and simply never written or read.
  insertStatement = db.prepare(`
    INSERT INTO usage_records (
      id, timestamp, session_id, provider, original_model, model, upstream_model, model_family,
      scenario_type, client_type,
      stream, usage_estimated, input_tokens, output_tokens, cache_read_input_tokens,
      cache_creation_input_tokens, ttft, tokens_per_second, duration_ms,
      status, error_message, response_body
    ) VALUES (
      @id, @timestamp, @session_id, @provider, @original_model, @model, @upstream_model,
      @model_family, @scenario_type, @client_type,
      @stream, @usage_estimated, @input_tokens, @output_tokens,
      @cache_read_input_tokens, @cache_creation_input_tokens, @ttft,
      @tokens_per_second, @duration_ms, @status, @error_message, @response_body
    )
  `);

  dbInstance = db;
  return dbInstance;
}

function initializeSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_records (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      session_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      original_model TEXT NOT NULL,
      model TEXT NOT NULL,
      upstream_model TEXT,
      model_family TEXT NOT NULL,
      scenario_type TEXT NOT NULL,
      client_type TEXT,
      stream INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_input_tokens INTEGER NOT NULL,
      cache_creation_input_tokens INTEGER NOT NULL,
      ttft REAL,
      tokens_per_second REAL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      error_message TEXT,
      response_body TEXT
    );

    CREATE TABLE IF NOT EXISTS usage_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_usage_records_timestamp ON usage_records(timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_records_status_timestamp ON usage_records(status, timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_records_provider_timestamp ON usage_records(provider, timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_records_model_timestamp ON usage_records(model, timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_records_scenario_timestamp ON usage_records(scenario_type, timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_records_client_timestamp ON usage_records(client_type, timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_records_session_timestamp ON usage_records(session_id, timestamp);
  `);
}

function getMeta(db: SqliteDatabase, key: string): string | undefined {
  const row = db
    .prepare("SELECT value FROM usage_meta WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value;
}

function setMeta(db: SqliteDatabase, key: string, value: string): void {
  db.prepare(`
    INSERT INTO usage_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function migrateLegacyUsageJsonl(db: SqliteDatabase): void {
  if (getMeta(db, LEGACY_MIGRATION_META_KEY) || !existsSync(LEGACY_USAGE_FILE)) {
    return;
  }

  const insertStatement = getInsertStatement(db, "INSERT OR IGNORE");
  const content = readFileSync(LEGACY_USAGE_FILE, "utf-8");
  let imported = 0;
  let skipped = 0;
  let duplicates = 0;

  const migrate = db.transaction(() => {
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const parsed = JSON.parse(trimmed);
        if (!isMigrationCandidate(parsed)) {
          skipped++;
          continue;
        }

        const result = insertStatement.run(toDbRow(normalizeUsageRecord(parsed)));
        if (result.changes > 0) {
          imported++;
        } else {
          duplicates++;
        }
      } catch {
        skipped++;
      }
    }

    setMeta(db, LEGACY_MIGRATION_META_KEY, new Date().toISOString());
    setMeta(db, "legacy_usage_jsonl_migrated_path", LEGACY_USAGE_FILE);
    setMeta(db, "legacy_usage_jsonl_imported_count", String(imported));
    setMeta(db, "legacy_usage_jsonl_skipped_count", String(skipped));
    setMeta(db, "legacy_usage_jsonl_duplicate_count", String(duplicates));
  });

  migrate();
}

function isMigrationCandidate(value: unknown): value is UsageRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<UsageRecord>;
  return typeof record.id === "string" && record.id.length > 0 &&
    typeof record.timestamp === "string" && record.timestamp.length > 0;
}

function getInsertStatement(db: SqliteDatabase, insertMode = "INSERT"): SqliteStatement {
  return db.prepare(`
    ${insertMode} INTO usage_records (
      id, timestamp, session_id, provider, original_model, model, upstream_model, model_family,
      scenario_type, client_type,
      stream, usage_estimated, input_tokens, output_tokens, cache_read_input_tokens,
      cache_creation_input_tokens, ttft, tokens_per_second, duration_ms,
      status, error_message, response_body
    ) VALUES (
      @id, @timestamp, @session_id, @provider, @original_model, @model, @upstream_model,
      @model_family, @scenario_type, @client_type,
      @stream, @usage_estimated, @input_tokens, @output_tokens,
      @cache_read_input_tokens, @cache_creation_input_tokens, @ttft,
      @tokens_per_second, @duration_ms, @status, @error_message, @response_body
    )
  `);
}

function calculateUsageTokensPerSecond(outputTokens: number, durationMs: number | null, ttft: number | null): number | null {
  if (outputTokens <= 0 || durationMs == null || !Number.isFinite(durationMs)) return null;

  const timeToFirstToken = ttft != null && Number.isFinite(ttft) ? ttft : 0;
  const decodeDurationSeconds = Math.max(
    (durationMs - timeToFirstToken) / 1000,
    MIN_DECODE_DURATION_SECONDS
  );
  return Math.round(outputTokens / decodeDurationSeconds);
}

function normalizeUsageRecord(record: UsageRecord): UsageRecord {
  const outputTokens = Number(record.outputTokens) || 0;
  const rawDurationMs = Number(record.durationMs);
  const durationMs = Number.isFinite(rawDurationMs) ? rawDurationMs : null;
  // TTFT is only meaningful for streaming requests: a non-streaming response
  // arrives as one payload where "first token" equals total duration. Force
  // non-stream TTFT to null regardless of what the caller supplied, so it
  // cannot pollute per-record display or the avgTtft aggregate.
  const ttft = record.stream ? parseNumericTokenSpeedValue(record.ttft) : null;

  return {
    ...record,
    ttft,
    tokensPerSecond: calculateUsageTokensPerSecond(outputTokens, durationMs, ttft),
  };
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (value == null) return undefined;
  const normalized = String(value);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeNumber(value: unknown): number {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : 0;
}

function normalizeStatus(value: unknown): UsageStatus {
  return value === "success" ? "success" : "error";
}

function toDbRow(record: UsageRecord): UsageRecordRow {
  const normalized = normalizeUsageRecord(record);
  return {
    id: normalizeString(normalized.id),
    timestamp: normalizeString(normalized.timestamp),
    session_id: normalizeString(normalized.sessionId),
    provider: normalizeString(normalized.provider),
    original_model: normalizeString(normalized.originalModel),
    model: normalizeString(normalized.model),
    upstream_model: normalizeOptionalString(normalized.upstreamModel) ?? null,
    model_family: normalizeString(normalized.modelFamily),
    scenario_type: normalizeString(normalized.scenarioType),
    client_type: normalizeOptionalString(normalized.clientType) ?? null,
    stream: normalized.stream ? 1 : 0,
    usage_estimated: normalized.usageEstimated === true ? 1 : 0,
    input_tokens: Math.trunc(normalizeNumber(normalized.inputTokens)),
    output_tokens: Math.trunc(normalizeNumber(normalized.outputTokens)),
    cache_read_input_tokens: Math.trunc(normalizeNumber(normalized.cacheReadInputTokens)),
    cache_creation_input_tokens: Math.trunc(normalizeNumber(normalized.cacheCreationInputTokens)),
    ttft: parseNumericTokenSpeedValue(normalized.ttft),
    tokens_per_second: parseNumericTokenSpeedValue(normalized.tokensPerSecond),
    duration_ms: Math.trunc(normalizeNumber(normalized.durationMs)),
    status: normalizeStatus(normalized.status),
    error_message: normalizeOptionalString(normalized.errorMessage) ?? null,
    response_body: normalizeOptionalString(normalized.responseBody) ?? null,
  };
}

function toUsageRecord(row: UsageRecordRow): UsageRecord {
  return normalizeUsageRecord({
    id: row.id,
    timestamp: row.timestamp,
    sessionId: row.session_id,
    provider: row.provider,
    originalModel: row.original_model,
    model: row.model,
    upstreamModel: row.upstream_model ?? undefined,
    modelFamily: row.model_family,
    scenarioType: row.scenario_type,
    clientType: row.client_type ?? undefined,
    stream: row.stream === 1,
    ...(row.usage_estimated === 1 ? { usageEstimated: true } : {}),
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadInputTokens: row.cache_read_input_tokens,
    cacheCreationInputTokens: row.cache_creation_input_tokens,
    ttft: row.ttft,
    tokensPerSecond: row.tokens_per_second,
    durationMs: row.duration_ms,
    status: normalizeStatus(row.status),
    errorMessage: row.error_message ?? undefined,
    responseBody: row.response_body ?? undefined,
  });
}

function retentionCutoffTimestamp(): string {
  return new Date(Date.now() - USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function pruneExpiredRecords(db: SqliteDatabase, force = false): void {
  const now = Date.now();
  if (!force && now - lastRetentionPruneAt < RETENTION_PRUNE_INTERVAL_MS) return;

  db.prepare("DELETE FROM usage_records WHERE timestamp < ?").run(retentionCutoffTimestamp());
  lastRetentionPruneAt = now;
}

function buildWhereClause(filters: UsageQueryFilters): QueryWhereClause {
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (filters.startTime) {
    clauses.push("timestamp >= ?");
    params.push(filters.startTime);
  }
  if (filters.endTime) {
    clauses.push("timestamp <= ?");
    params.push(filters.endTime);
  }
  if (filters.model) {
    clauses.push("model = ?");
    params.push(filters.model);
  }
  if (filters.provider) {
    clauses.push("provider = ?");
    params.push(filters.provider);
  }
  if (filters.scenario) {
    clauses.push("scenario_type = ?");
    params.push(filters.scenario);
  }
  if (filters.clientType) {
    if (filters.clientType === "unknown") {
      clauses.push("(client_type IS NULL OR client_type = '' OR client_type = ?)");
      params.push(filters.clientType);
    } else {
      clauses.push("client_type = ?");
      params.push(filters.clientType);
    }
  }
  if (filters.sessionId) {
    clauses.push("session_id = ?");
    params.push(filters.sessionId);
  }
  if (filters.status) {
    clauses.push("status = ?");
    params.push(filters.status);
  }

  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

// Aggregate summaries directly in SQL. The previous implementation materialized
// every matching row into JS memory (SELECT * + per-row aggregation), which
// blocked the event loop for seconds on large tables because better-sqlite3 is
// synchronous. COUNT/SUM/AVG/GROUP BY keep this work inside SQLite and return
// only tiny result sets. Semantics intentionally mirror the old JS version:
// tokens are counted for successful requests only.
const SUMMARY_BUCKET_AGGREGATES = `
  COUNT(*) AS count,
  COALESCE(SUM(CASE WHEN status = 'success' THEN input_tokens ELSE 0 END), 0) AS inputTokens,
  COALESCE(SUM(CASE WHEN status = 'success' THEN output_tokens ELSE 0 END), 0) AS outputTokens,
  COALESCE(SUM(CASE WHEN status = 'success' THEN cache_read_input_tokens ELSE 0 END), 0) AS cacheReadInputTokens,
  COALESCE(SUM(CASE WHEN status = 'success' THEN cache_creation_input_tokens ELSE 0 END), 0) AS cacheCreationInputTokens
`;

type SummaryBucket = {
  count: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
};

interface SummaryBucketRow extends SummaryBucket {
  key: string;
}

function readSummaryBuckets(
  db: SqliteDatabase,
  where: QueryWhereClause,
  keyExpression: string,
  // MUST be a compile-time literal (never user input). It is concatenated into
  // the SQL string below rather than parameterized, so only pass trusted
  // constant fragments here.
  extraAndClause = ""
): Record<string, SummaryBucket> {
  const extraSql = extraAndClause
    ? where.sql
      ? `${where.sql} AND ${extraAndClause}`
      : `WHERE ${extraAndClause}`
    : where.sql;

  const rows = db
    .prepare(`
      SELECT ${keyExpression} AS key, ${SUMMARY_BUCKET_AGGREGATES}
      FROM usage_records ${extraSql}
      GROUP BY key
    `)
    .all(...where.params) as SummaryBucketRow[];

  const map: Record<string, SummaryBucket> = {};
  for (const row of rows) {
    if (row.key == null) continue;
    map[String(row.key)] = {
      count: row.count,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadInputTokens: row.cacheReadInputTokens,
      cacheCreationInputTokens: row.cacheCreationInputTokens,
    };
  }
  return map;
}

function computeSummarySQL(db: SqliteDatabase, filters: UsageQueryFilters): UsageSummary {
  const where = buildWhereClause(filters);

  const totals = db
    .prepare(`
      SELECT
        COUNT(*) AS totalRequests,
        COALESCE(SUM(usage_estimated), 0) AS estimatedCount,
        COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS successCount,
        COALESCE(SUM(CASE WHEN status = 'success' THEN input_tokens ELSE 0 END), 0) AS totalInputTokens,
        COALESCE(SUM(CASE WHEN status = 'success' THEN output_tokens ELSE 0 END), 0) AS totalOutputTokens,
        COALESCE(SUM(CASE WHEN status = 'success' THEN cache_read_input_tokens ELSE 0 END), 0) AS totalCacheReadInputTokens,
        COALESCE(SUM(CASE WHEN status = 'success' THEN cache_creation_input_tokens ELSE 0 END), 0) AS totalCacheCreationInputTokens,
        AVG(CASE WHEN status = 'success' AND ttft IS NOT NULL THEN ttft END) AS avgTtft,
        AVG(CASE WHEN status = 'success' AND tokens_per_second IS NOT NULL THEN tokens_per_second END) AS avgTokensPerSecond
      FROM usage_records ${where.sql}
    `)
    .get(...where.params) as {
    estimatedCount: number;
    totalRequests: number;
    successCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadInputTokens: number;
    totalCacheCreationInputTokens: number;
    avgTtft: number | null;
    avgTokensPerSecond: number | null;
  };

  return {
    estimatedCount: totals.estimatedCount,
    totalRequests: totals.totalRequests,
    successCount: totals.successCount,
    errorCount: totals.totalRequests - totals.successCount,
    totalInputTokens: totals.totalInputTokens,
    totalOutputTokens: totals.totalOutputTokens,
    totalCacheReadInputTokens: totals.totalCacheReadInputTokens,
    totalCacheCreationInputTokens: totals.totalCacheCreationInputTokens,
    avgTtft: totals.avgTtft != null ? Math.round(totals.avgTtft) : null,
    avgTokensPerSecond: totals.avgTokensPerSecond != null ? Math.round(totals.avgTokensPerSecond) : null,
    byModel: readSummaryBuckets(db, where, "model"),
    byProvider: readSummaryBuckets(db, where, "provider"),
    byScenario: readSummaryBuckets(db, where, "scenario_type"),
    byFamily: readSummaryBuckets(
      db,
      where,
      "model_family || '/' || scenario_type",
      "model_family IS NOT NULL AND model_family != ''"
    ),
    // Group by local-time calendar day. timestamp is stored as UTC ISO, so a
    // plain substr(…,1,10) bucket uses the UTC date and mis-files requests in
    // the local 0:00–8:00 window (whose UTC instant is still "yesterday") into
    // the previous day. date(timestamp,'localtime') converts to the process
    // timezone first. Aggregation is computed at query time, so historical rows
    // are re-bucketed correctly once this ships — no data migration needed.
    byDay: readSummaryBuckets(db, where, "date(timestamp, 'localtime')"),
    byClient: readSummaryBuckets(
      db,
      where,
      "CASE WHEN client_type IS NULL OR client_type = '' THEN 'unknown' ELSE client_type END"
    ),
  };
}

export function append(record: UsageRecord): void {
  const db = getDb();
  const normalized = normalizeUsageRecord(record);
  // Use the cached prepared statement for hot-path performance.
  insertStatement!.run(toDbRow(normalized));
  pruneExpiredRecords(db);
}

// Hard ceiling for a single usage page; the UI requests 20 rows at a time.
const MAX_PAGE_SIZE = 200;

export function query(filters: UsageQueryFilters): UsageQueryResult {
  const db = getDb();
  const where = buildWhereClause(filters);
  const page = Number.isFinite(filters.page) && filters.page! > 0 ? Math.floor(filters.page!) : 1;
  // Cap the page size: usage rows are wide (response bodies included) and an
  // unbounded LIMIT would let a single request materialize the whole table.
  const pageSize = Number.isFinite(filters.pageSize) && filters.pageSize! > 0
    ? Math.min(Math.floor(filters.pageSize!), MAX_PAGE_SIZE)
    : 50;
  const offset = (page - 1) * pageSize;

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS count FROM usage_records ${where.sql}`)
    .get(...where.params) as { count: number };
  const rows = db
    .prepare(`SELECT * FROM usage_records ${where.sql} ORDER BY timestamp DESC LIMIT ? OFFSET ?`)
    .all(...where.params, pageSize, offset) as UsageRecordRow[];

  const summary = computeSummarySQL(db, filters);

  return {
    records: rows.map(toUsageRecord),
    summary,
    total: totalRow.count,
    page,
    pageSize,
  };
}

export function querySummary(startTime?: string, endTime?: string, status?: UsageStatus): UsageSummary {
  const db = getDb();
  return computeSummarySQL(db, { startTime, endTime, status });
}

export function clear(beforeDate?: string): void {
  const db = getDb();
  if (!beforeDate) {
    db.prepare("DELETE FROM usage_records").run();
    return;
  }

  db.prepare("DELETE FROM usage_records WHERE timestamp < ?").run(beforeDate);
}

// Gracefully close the database connection (call on process shutdown).
export function close(): void {
  if (dbInstance) {
    // Run a WAL checkpoint to flush pending writes before closing.
    dbInstance.pragma("wal_checkpoint(TRUNCATE)");
    dbInstance.close();
    dbInstance = null;
    insertStatement = null;
  }
}

function parseNumericTokenSpeedValue(value: any): number | null {
  if (value == null) return null;
  if (typeof value === "number") return value;
  const num = parseFloat(String(value));
  return isNaN(num) ? null : num;
}

/**
 * Read token-speed temp file for a session to get TTFT and speed.
 *
 * The file name must be reconstructed exactly the way the writer side
 * (TempFileOutputHandler, configured by ccr/plugin-registration.ts and the
 * token-speed plugin's default reporter) builds it:
 * - v2 subdirectory TOKEN_SPEED_TEMP_SUBDIRECTORY under the OS temp root
 *   (keeps exact-name files away from the legacy flat root where old CCR
 *   processes still write timestamped files);
 * - default prefix `session` and extension `json` -> `session-<key>.json`;
 * - the key must go through the same sanitizeTempFileKey() as the writer,
 *   or the reader will look for a file that does not exist.
 * There is deliberately no directory-scan fallback: scanning
 * tmpdir/claude-code-router once blocked the event loop for ~33s per request
 * when the directory grew to millions of stale timestamped files.
 */
export function readTokenSpeedStats(sessionId: string): {
  ttft: number | null;
  tokensPerSecond: number | null;
} {
  const file = join(
    tmpdir(),
    TOKEN_SPEED_TEMP_SUBDIRECTORY,
    `session-${sanitizeTempFileKey(sessionId)}.json`
  );

  try {
    const data = JSON.parse(readFileSync(file, "utf-8"));
    return {
      ttft: parseNumericTokenSpeedValue(data.timeToFirstToken),
      tokensPerSecond: parseNumericTokenSpeedValue(data.tokensPerSecond),
    };
  } catch {
    // Missing file, unparsable JSON, or unexpected payload: report "no data".
    return { ttft: null, tokensPerSecond: null };
  }
}

export function getOldestRecordTimestamp(provider: string, startTime: string, endTime: string): string | undefined {
  const db = getDb();
  const row = db
    .prepare("SELECT MIN(timestamp) AS timestamp FROM usage_records WHERE provider = ? AND timestamp >= ? AND timestamp <= ?")
    .get(provider, startTime, endTime) as { timestamp: string | null } | undefined;
  return row?.timestamp ?? undefined;
}
