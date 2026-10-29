/**
 * WorkBuddy UI API payload types, SELF-CONTAINED copies of the former
 * `packages/ui/src/types.ts` WorkBuddy declarations (the UI deletes them at
 * the hard cut; the card must stay buildable on its own). Shapes are
 * behavioural subsets — the server assigns these objects role-free.
 */

export type WorkBuddyStatus =
  | "not_connected"
  | "connected"
  | "expired"
  | "sealed"
  | "source_missing"
  | "source_changed"
  | "error";

export type WorkBuddyKind = "workbuddy" | "workbuddy-ai";

export type WorkBuddyRenewalMode = "desktop" | "browser";

export interface WorkBuddyAccountSummary {
  uid: string;
  displayName: string | null;
  source: "desktop" | "browser";
  active: boolean;
  coolingUntil?: number | null;
  restrictedUntil?: number | null;
  expiresAt?: number | null;
}

export interface WorkBuddySiteStatus {
  status: WorkBuddyStatus;
  providerName: string;
  accounts: WorkBuddyAccountSummary[];
  activeUid: string | null;
  models: string[];
  hiddenModels: string[];
  modelCount: number;
  lastSyncAt: string | null;
  lastError: string | null;
  // Display-only extras. Optional so the UI also renders against a server
  // that returns exactly the §16 fields.
  site?: string;
  source?: "desktop" | "browser";
  renewalMode?: WorkBuddyRenewalMode;
  imagesUnsupportedModels?: string[];
}

export interface WorkBuddyStatusResponse {
  // §16 source of truth: one independent entry per site.
  sites: Partial<Record<WorkBuddyKind, WorkBuddySiteStatus>>;
  // Legacy flat mirror of the only connected site. Kept one version for
  // backwards compatibility; the UI reads it only when `sites` is absent.
  status?: WorkBuddyStatus;
  kind?: WorkBuddyKind;
  providerName?: string;
  site?: string;
  models?: string[];
  modelCount?: number;
  uid?: string | null;
  displayName?: string | null;
  domain?: string | null;
  expiresAt?: number | null;
  importedAt?: string | null;
  lastSyncAt?: string | null;
  lastError?: string | null;
  imagesUnsupportedModels?: string[];
  renewalMode?: WorkBuddyRenewalMode;
  source?: "desktop" | "browser";
}

export interface WorkBuddyUsage {
  plan: string;
  used: number;
  limit: number;
  unit: "credits";
}

export interface WorkBuddyUsageResponse {
  usage: WorkBuddyUsage | null;
}

export interface WorkBuddyUsageRequest {
  site: WorkBuddyKind;
  uid?: string;
}

export interface WorkBuddyModelHideResponse {
  ok: boolean;
  clearedRefs?: string[];
  removedModelRefs?: string[];
  // Actual persisted Router.default after hide; null means no default remains.
  defaultFallback?: string | null;
}

export interface WorkBuddyModelRestoreResponse {
  ok: boolean;
}

export type WorkBuddyFailureReason =
  | "sealed"
  | "source_missing"
  | "source_invalid"
  | "models_fetch_failed"
  | "workbuddy_name_conflict"
  | "login_state_rejected"
  | "login_account_failed"
  | "login_persist_failed";

export interface WorkBuddyLoginStartResponse {
  ok: true;
  site: WorkBuddyKind;
  loginId: string;
  url: string;
  expiresAt: number;
}

export type WorkBuddyLoginPollResponse =
  | { status: "pending" | "none" | "expired" }
  | { status: "failed"; reason: WorkBuddyFailureReason }
  | (WorkBuddyMutationResponse & { status: "connected"; success: true; models: string[]; accountChange?: "added" | "updated"; accountCount?: number });

export interface WorkBuddyMutationResponse {
  // §16 management routes return an additive `ok` alongside the legacy fields.
  ok?: boolean;
  success: boolean;
  status?: WorkBuddyStatus;
  models?: string[];
  modelCount?: number;
  displayName?: string | null;
  message?: string | null;
  modelsUnchanged?: boolean;
  reason?: WorkBuddyFailureReason;
  removedProvider?: boolean;
  deletedCredential?: boolean;
  error?: string;
  /** §16 outcome metadata when a login/import committed an account upsert: a new pool row was added, or an existing uid was replaced in place. */
  accountChange?: "added" | "updated";
  /** Committed pool size for the site after that upsert. */
  accountCount?: number;
}
