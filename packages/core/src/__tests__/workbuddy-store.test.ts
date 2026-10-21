import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WORKBUDDY_AI_API_KEY,
  WORKBUDDY_AI_PROVIDER_NAME,
  WORKBUDDY_API_KEY,
  WORKBUDDY_PROVIDER_NAME,
  WORKBUDDY_SITES,
  WorkBuddyCredentialStore,
  isWorkBuddyRuntime,
  lockWorkBuddyProvider,
  managedProvider,
  workBuddySiteFromProvider,
  type WorkBuddyCredential,
} from "../services/workbuddy";

const dirs: string[] = [];
function newStore(): { store: WorkBuddyCredentialStore; dir: string; path: string; backup: string } {
  const dir = mkdtempSync(join(tmpdir(), "wb-store16-"));
  dirs.push(dir);
  const path = join(dir, "workbuddy-credentials.json");
  const store = new WorkBuddyCredentialStore(path);
  return { store, dir, path, backup: join(dir, "workbuddy-credentials.v1.bak") };
}

function v1Credential(extra: Partial<WorkBuddyCredential> = {}): WorkBuddyCredential {
  return {
    version: 1,
    kind: "workbuddy",
    uid: "u-1",
    displayName: "Nick",
    enterpriseId: "",
    domain: "",
    source: "desktop",
    accessToken: "super-secret-access-token",
    expiresAt: 0,
    importedAt: "2026-10-19T00:00:00.000Z",
    tokenType: "",
    ...extra,
  };
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("WorkBuddy v2 store migration (contract §16)", () => {
  it("backs up the v1 file 0600 once and converts it to v2", async () => {
    const { store, path, backup } = newStore();
    writeFileSync(path, JSON.stringify(v1Credential()));
    expect(existsSync(backup)).toBe(false);

    const result = await store.migrateV1();
    expect(result.backupCreated).toBe(true);
    expect(result.legacy?.version).toBe(1);
    expect(result.data.version).toBe(2);

    // Backup holds the exact v1 bytes, 0600, and is not re-created on repeat calls.
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(backup, "utf8"))).toMatchObject({ version: 1, uid: "u-1" });
    const second = await store.migrateV1();
    expect(second.backupCreated).toBe(false);
    expect(second.legacy).toBeNull();

    const data = await store.loadData();
    expect(data?.sites.workbuddy).toMatchObject({ activeUid: "u-1", hiddenModels: [] });
    expect(data?.sites.workbuddy?.accounts).toHaveLength(1);
    expect(data?.sites.workbuddy?.accounts[0]).toMatchObject({ uid: "u-1", source: "desktop" });
    // The live file carries no secret field name beyond the v2 account envelope.
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(2);
  });

  it("strips a desktop refreshToken during migration but keeps a browser one", async () => {
    const { store, path } = newStore();
    writeFileSync(path, JSON.stringify(v1Credential({ refreshToken: "desktop-shared-refresh-secret" } as WorkBuddyCredential)));
    await store.migrateV1();
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("desktop-shared-refresh-secret");
    expect(raw).not.toContain("refreshToken");

    const { store: b, path: bPath } = newStore();
    writeFileSync(bPath, JSON.stringify(v1Credential({
      kind: "workbuddy-ai", uid: "b-1", domain: "www.workbuddy.ai",
      source: "browser", refreshToken: "browser-owned-refresh", refreshExpiresAt: 42,
    })));
    await b.migrateV1();
    const bRaw = readFileSync(bPath, "utf8");
    expect(bRaw).toContain("browser-owned-refresh");
    const bData = await b.loadData();
    expect(bData?.sites["workbuddy-ai"]?.accounts[0]).toMatchObject({
      source: "browser", refreshToken: "browser-owned-refresh", refreshExpiresAt: 42,
    });
  });

  it("in-memory loadData migration does not touch disk", async () => {
    const { store, path, backup } = newStore();
    writeFileSync(path, JSON.stringify(v1Credential()), { mode: 0o600 });
    const data = await store.loadData();
    expect(data?.version).toBe(2);
    // The file is still v1 and no backup exists: only explicit migrateV1 writes.
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(1);
    expect(existsSync(backup)).toBe(false);
  });

  it("writes v2 data 0600, leaves no temp files, and rejects permissive permissions", async () => {
    const { store, path } = newStore();
    await store.saveData({ version: 2, sites: { workbuddy: {
      hiddenModels: [], activeUid: "u-1",
      accounts: [{ ...v1Credential(), kind: undefined } as any],
    } } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(path, "..")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    chmodSync(path, 0o644);
    await expect(store.loadData()).rejects.toThrow(/重新导入/);
  });
});

describe("WorkBuddy v2 account pool", () => {
  it("appends multiple accounts per site, replaces on same uid, and keeps other sites intact", async () => {
    const { store } = newStore();
    const a = v1Credential({ uid: "a", importedAt: "2026-10-19T00:00:00.000Z" });
    const b = v1Credential({ uid: "b", accessToken: "token-b", importedAt: "2026-10-19T01:00:00.000Z" });
    const ai = v1Credential({ kind: "workbuddy-ai", uid: "a", domain: "www.workbuddy.ai", accessToken: "token-ai" });
    await store.upsertAccount(a);
    const r2 = await store.upsertAccount(b);
    expect(r2.replaced).toBe(false);
    await store.upsertAccount(ai);

    let data = await store.loadData();
    expect(data?.sites.workbuddy?.accounts.map((x) => x.uid)).toEqual(["a", "b"]);
    expect(data?.sites.workbuddy?.activeUid).toBe("a");
    expect(data?.sites["workbuddy-ai"]?.accounts).toHaveLength(1);

    const replace = await store.upsertAccount(v1Credential({ uid: "a", accessToken: "token-a2" }));
    expect(replace.replaced).toBe(true);
    data = await store.loadData();
    const cn = data!.sites.workbuddy!;
    expect(cn.accounts.map((x) => x.uid)).toEqual(["a", "b"]);
    expect(cn.accounts[0].accessToken).toBe("token-a2");
    expect(cn.activeUid).toBe("a"); // stickiness survives replacement
  });

  it("migrates a legacy v1 file (with backup) on the first v2 upsert", async () => {
    const { store, path, backup } = newStore();
    writeFileSync(path, JSON.stringify(v1Credential({ uid: "legacy" })));
    await store.upsertAccount(v1Credential({ uid: "legacy", accessToken: "rotated" }));
    expect(existsSync(backup)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(2);
    const data = await store.loadData();
    expect(data?.sites.workbuddy?.accounts).toHaveLength(1);
    expect(data?.sites.workbuddy?.accounts[0].accessToken).toBe("rotated");
  });

  it("switches the sticky active account and rejects an unknown uid", async () => {
    const { store } = newStore();
    await store.upsertAccount(v1Credential({ uid: "a" }));
    await store.upsertAccount(v1Credential({ uid: "b" }));
    await store.setActiveUid("workbuddy", "b");
    expect((await store.loadData())?.sites.workbuddy?.activeUid).toBe("b");
    await expect(store.setActiveUid("workbuddy", "ghost")).rejects.toThrow("workbuddy_account_not_found");
  });

  it("advances active to earliest-imported on removal and empties the pool by deleting the site/file", async () => {
    const { store, path } = newStore();
    await store.upsertAccount(v1Credential({ uid: "a", importedAt: "2026-10-19T03:00:00.000Z" }));
    await store.upsertAccount(v1Credential({ uid: "b", importedAt: "2026-10-19T01:00:00.000Z" }));
    await store.upsertAccount(v1Credential({ uid: "c", importedAt: "2026-10-19T02:00:00.000Z" }));
    await store.setActiveUid("workbuddy", "a");
    const removed = await store.removeAccount("workbuddy", "a");
    expect(removed.activeAdvancedTo).toBe("b");
    expect((await store.loadData())?.sites.workbuddy?.activeUid).toBe("b");

    await store.removeAccount("workbuddy", "b");
    const last = await store.removeAccount("workbuddy", "c");
    expect(last.data).toBeNull();
    expect(existsSync(path)).toBe(false); // empty pool = full site disconnect
    expect(await store.loadData()).toBeNull();
  });

  it("persists hidden models and account cooldowns with whitelist normalization", async () => {
    const { store } = newStore();
    await store.upsertAccount(v1Credential({ uid: "a" }));
    await store.setHiddenModels("workbuddy", ["glm-5.3", "glm-5.3", "bad,id", "x"] as any);
    expect((await store.loadData())?.sites.workbuddy?.hiddenModels).toEqual(["glm-5.3", "x"]);
    await store.setAccountCooldown("workbuddy", "a", { until: Date.now() + 60_000, scope: "model", model: "glm-5.3", code: 6004 });
    const c = (await store.loadData())?.sites.workbuddy?.accounts[0];
    // Model-scoped cooldowns live in the additive per-model map, not the account slot.
    expect(c?.cooldown).toBeUndefined();
    expect(c?.modelCooldowns?.["glm-5.3"]).toMatchObject({ code: 6004 });
    await store.setAccountCooldown("workbuddy", "a", { until: Date.now() + 60_000, scope: "model", model: "kimi-k3-1", code: 6004 });
    const both = (await store.loadData())?.sites.workbuddy?.accounts[0].modelCooldowns;
    expect(Object.keys(both ?? {}).sort()).toEqual(["glm-5.3", "kimi-k3-1"]); // simultaneous A+B limits preserved
    await store.setAccountCooldown("workbuddy", "a", null);
    const cleared = (await store.loadData())?.sites.workbuddy?.accounts[0];
    expect(cleared?.cooldown).toBeUndefined();
    expect(cleared?.modelCooldowns).toBeUndefined();
    await expect(store.setHiddenModels("workbuddy-ai", ["m"])).rejects.toThrow("workbuddy_not_connected");
  });

  it("preserves still-valid cooldowns across same-uid re-login and drops expired ones", async () => {
    const { store } = newStore();
    await store.upsertAccount(v1Credential({ uid: "a", accessToken: "token-a1" }));
    await store.setAccountCooldown("workbuddy", "a", { until: Date.now() + 60_000, scope: "account", code: 14018 });
    await store.setAccountCooldown("workbuddy", "a", { until: Date.now() + 60_000, scope: "model", model: "glm-5.3", code: 6004 });
    // Successful login is NOT evidence quota/rate limits reset (§16 review).
    await store.upsertAccount(v1Credential({ uid: "a", accessToken: "token-a2" }));
    const kept = (await store.loadData())?.sites.workbuddy?.accounts[0];
    expect(kept?.accessToken).toBe("token-a2");
    expect(kept?.cooldown).toMatchObject({ scope: "account", code: 14018 });
    expect(kept?.modelCooldowns?.["glm-5.3"]).toBeDefined();
    // Expired state is dropped on the next normalization pass (fresh account with
    // only an expired cooldown; the preserved live one above is separate).
    const { store: s2 } = newStore();
    await s2.upsertAccount(v1Credential({ uid: "b", accessToken: "token-b1", cooldown: { until: Date.now() - 1, scope: "account", code: 14018 } }));
    const dropped = (await s2.loadData())?.sites.workbuddy?.accounts[0];
    expect(dropped?.accessToken).toBe("token-b1");
    expect(dropped?.cooldown).toBeUndefined();
  });

  it("migrates a permissive 0644 v1 file: backup and live file both end up 0600", async () => {
    const { store, path, backup } = newStore();
    const v1bytes = JSON.stringify(v1Credential({ uid: "permissive" }));
    writeFileSync(path, v1bytes, { mode: 0o644 });
    const result = await store.migrateV1();
    expect(result.backupCreated).toBe(true);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(backup, "utf8")).toBe(v1bytes); // exact bytes, single validated read
    expect((await store.loadData())?.sites.workbuddy?.activeUid).toBe("permissive");
  });

  it("exposes the legacy single-credential shim for the pre-§16 service", async () => {
    const { store } = newStore();
    await store.save(v1Credential({ uid: "a", accessToken: "token-a" }));
    const legacy = await store.load();
    expect(legacy).toMatchObject({ version: 1, kind: "workbuddy", uid: "a", accessToken: "token-a" });
    await store.save(v1Credential({ uid: "a", accessToken: "token-a2" }));
    expect((await store.load())?.accessToken).toBe("token-a2");
    expect((await store.loadData())?.sites.workbuddy?.accounts).toHaveLength(1);
  });
});

describe("WorkBuddy per-site managed provider markers (contract §16)", () => {
  it("resolves name/key per site", () => {
    expect(managedProvider("workbuddy")).toEqual({ name: WORKBUDDY_PROVIDER_NAME, apiKey: WORKBUDDY_API_KEY });
    expect(managedProvider("workbuddy-ai")).toEqual({ name: WORKBUDDY_AI_PROVIDER_NAME, apiKey: WORKBUDDY_AI_API_KEY });
  });

  it("recognizes both runtimes by name/marker and derives site from name/url", () => {
    expect(isWorkBuddyRuntime({ name: "workbuddy", apiKey: WORKBUDDY_API_KEY })).toBe(true);
    expect(isWorkBuddyRuntime({ name: "workbuddy-ai", apiKey: WORKBUDDY_AI_API_KEY })).toBe(true);
    expect(isWorkBuddyRuntime({ name: "workbuddy-ai", workbuddyManaged: true })).toBe(true);
    expect(isWorkBuddyRuntime({ name: "workbuddy", apiKey: "real-user-key" })).toBe(false);
    // A hand-edited cross-marker pair is still treated as managed (name decides the site);
    // lockWorkBuddyProvider always writes consistent pairs, so this only widens the
    // fixed-origin safety net, never the attack surface.
    expect(isWorkBuddyRuntime({ name: "workbuddy-ai", apiKey: WORKBUDDY_API_KEY })).toBe(true);
    expect(workBuddySiteFromProvider({ name: "workbuddy-ai" })).toBe("workbuddy-ai");
    expect(workBuddySiteFromProvider({ name: "workbuddy", api_base_url: "https://evil.example" })).toBe("workbuddy");
    expect(workBuddySiteFromProvider({ name: "x", baseUrl: "https://www.workbuddy.ai/v2/chat/completions" })).toBe("workbuddy-ai");
  });

  it("locks each site's provider name, fixed URL, marker key and transformer", () => {
    const cn = lockWorkBuddyProvider({ name: "user-tampered", api_base_url: "https://evil.example", api_key: "leaked" }, "workbuddy");
    expect(cn).toMatchObject({
      name: "workbuddy", ccr_managed: true, workbuddy_kind: "workbuddy", workbuddyManaged: true,
      api_base_url: "https://copilot.tencent.com/v2/chat/completions", api_key: WORKBUDDY_API_KEY,
      transformer: { use: ["workbuddy"] },
    });
    const ai = lockWorkBuddyProvider({ name: "workbuddy" }, "workbuddy-ai");
    expect(ai).toMatchObject({
      name: "workbuddy-ai", workbuddy_kind: "workbuddy-ai",
      api_base_url: WORKBUDDY_SITES["workbuddy-ai"].origin + "/v2/chat/completions",
      api_key: WORKBUDDY_AI_API_KEY,
    });
  });
});
