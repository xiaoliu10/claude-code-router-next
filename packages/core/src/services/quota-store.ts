import type { ProviderQuotaResult } from "./quota-adapters";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { HOME_DIR } from "@wengine-ai/claude-code-router-shared";

export interface StoredQuotaResult extends ProviderQuotaResult {
  provider: string;
  capturedAt: number;
}

const RUNTIME_DIR = join(HOME_DIR, "runtime");
const PERSIST_FILE = join(RUNTIME_DIR, "quota-store.json");

const quotaStore = new Map<string, StoredQuotaResult>();
let persistenceInitialized = false;
let saveTimer: ReturnType<typeof setInterval> | null = null;

export function storeQuotaResult(
  providerName: string,
  result: ProviderQuotaResult
): void {
  if (!providerName) return;

  quotaStore.set(providerName, {
    ...result,
    provider: providerName,
    capturedAt: Date.now(),
  });
}

export function getQuotaResult(
  providerName: string
): StoredQuotaResult | undefined {
  const result = quotaStore.get(providerName);
  return result ? { ...result } : undefined;
}

export function getAllQuotaResults(): StoredQuotaResult[] {
  return Array.from(quotaStore.values()).map((result) => ({ ...result }));
}

/** Test-only: drop every in-memory quota sample so stores stay isolated. */
export function clearQuotaStore(): void {
  quotaStore.clear();
}

// --- Persistence ---

function loadFromDisk(): void {
  try {
    if (!existsSync(PERSIST_FILE)) return;
    const data = JSON.parse(readFileSync(PERSIST_FILE, "utf-8"));
    if (!Array.isArray(data)) return;
    const now = Date.now();
    for (const item of data) {
      if (item && item.provider) {
        // Skip entries older than 24 hours — quota data goes stale
        if (item.capturedAt && now - item.capturedAt > 24 * 60 * 60 * 1000) continue;
        quotaStore.set(item.provider, item);
      }
    }
  } catch {
    // Corrupted file — start fresh
  }
}

function saveToDisk(): void {
  try {
    if (quotaStore.size === 0) return;
    if (!existsSync(RUNTIME_DIR)) {
      mkdirSync(RUNTIME_DIR, { recursive: true });
    }
    writeFileSync(PERSIST_FILE, JSON.stringify(Array.from(quotaStore.values()), null, 2), "utf-8");
  } catch {
    // Best-effort persistence
  }
}

/**
 * Initialize persistence: load from disk and set up periodic save.
 */
export function initQuotaStorePersistence(): void {
  if (persistenceInitialized) return;
  persistenceInitialized = true;
  loadFromDisk();
  saveTimer = setInterval(saveToDisk, 60_000);
  saveTimer.unref?.();
  process.on("exit", saveToDisk);
}
