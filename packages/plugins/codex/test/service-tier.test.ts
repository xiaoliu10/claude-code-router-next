import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexServiceTierStore } from "../src/service-tier";

describe("CodexServiceTierStore", () => {
  let dir: string;
  let path: string;
  const log = { warn: vi.fn() };
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "service-tier-"));
    path = join(dir, "codex-service-tier.json");
    log.warn.mockClear();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("defaults to follow without a file, serializes writes and reloads the last commit", async () => {
    const store = await CodexServiceTierStore.load(dir, log);
    expect(store.tier).toBe("follow");
    expect(await readdir(dir)).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
    const writes = [store.set("priority"), store.set("follow"), store.set("standard")];
    expect(store.tier).toBe("follow");
    await Promise.all(writes);
    expect(store.tier).toBe("standard");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ tier: "standard" });
    expect((await CodexServiceTierStore.load(dir, log)).tier).toBe("standard");
  });

  it("retains the last successful setting if rename fails and allows the next write", async () => {
    const store = await CodexServiceTierStore.load(dir, log);
    await store.set("priority");
    await rm(path);
    await mkdir(path);
    await expect(store.set("standard")).rejects.toThrow();
    expect(store.tier).toBe("priority");
    expect(await readdir(dir)).toEqual(["codex-service-tier.json"]);
    await rm(path, { recursive: true });
    await store.set("follow");
    expect(store.tier).toBe("follow");
    expect((await CodexServiceTierStore.load(dir, log)).tier).toBe("follow");
  });

  it.each(["private-fixture", '{"tier":"private-fixture"}'])("falls back with a redacted warning for bad data", async contents => {
    await writeFile(path, contents);
    expect((await CodexServiceTierStore.load(dir, log)).tier).toBe("follow");
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("private-fixture");
  });
});
