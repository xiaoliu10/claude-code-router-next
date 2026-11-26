import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type CodexServiceTier = "follow" | "standard" | "priority";

export function isCodexServiceTierSetting(value: unknown): value is { tier: CodexServiceTier } {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !Object.hasOwn(value, "tier") || Object.keys(value).length !== 1) return false;
  const { tier } = value as { tier: unknown };
  return tier === "follow" || tier === "standard" || tier === "priority";
}

export class CodexServiceTierStore {
  private writeTail: Promise<void> = Promise.resolve();

  private constructor(private readonly path: string, private current: CodexServiceTier) {}

  static async load(configDir: string, log: { warn(message: string): void }): Promise<CodexServiceTierStore> {
    const path = join(configDir, "codex-service-tier.json");
    let tier: CodexServiceTier = "follow";
    try {
      const setting: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!isCodexServiceTierSetting(setting)) throw new Error("invalid service tier");
      tier = setting.tier;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn("Could not read Codex service tier. Following the request tier.");
      }
    }
    return new CodexServiceTierStore(path, tier);
  }

  get tier(): CodexServiceTier { return this.current; }

  set(tier: CodexServiceTier): Promise<void> {
    const write = this.writeTail.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify({ tier }), { flag: "wx", mode: 0o600 });
        await rename(temp, this.path);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
      this.current = tier;
    });
    this.writeTail = write.catch(() => {});
    return write;
  }
}
