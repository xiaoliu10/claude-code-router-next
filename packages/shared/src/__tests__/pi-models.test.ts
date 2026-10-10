import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_WINDOW,
  applyPiProjectTakeover,
  disableClient,
  enableClient,
  getContextWindow,
  getPiProjectProviderName,
  isPiProjectTakeoverActive,
  removePiProjectTakeover,
} from "../client-integrations";
import { CCR_PROJECT_HEADER, getClaudeProjectId } from "../constants";

const tempDirs: string[] = [];

function createFixture(): { piDir: string; projectDir: string } {
  const root = mkdtempSync(join(tmpdir(), "ccr-pi-models-"));
  tempDirs.push(root);
  return {
    piDir: join(root, "pi"),
    projectDir: join(root, "project"),
  };
}

function readJson(filePath: string): any {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath: string, doc: any): void {
  writeFileSync(filePath, JSON.stringify(doc, null, 2));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Pi managed models", () => {
  it("exports the shared context window resolver", () => {
    expect(DEFAULT_CONTEXT_WINDOW).toBe(200000);
    expect(getContextWindow({})).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(getContextWindow({ ContextWindow: "350000" })).toBe(350000);
  });

  it("removes [1m] from family aliases while preserving contextWindow", () => {
    const { piDir } = createFixture();
    const config = {
      APIKEY: "test-key",
      PORT: 3456,
      ContextWindow: 420000,
      Router: {
        families: {
          opus: { default: "provider,opus", enableExtendedContext: true },
          sonnet: { default: "provider,sonnet", enableExtendedContext: false },
        },
      },
      Clients: {
        pi: {
          configPath: piDir,
          modelAlias: "ccr-opus[1m]",
        },
      },
    };

    enableClient(config, "pi");

    const models = readJson(join(piDir, "models.json")).providers.ccr.models;
    expect(models.map((model: any) => model.id)).toEqual(["ccr-opus", "ccr-sonnet"]);
    expect(models.every((model: any) => model.contextWindow === 420000)).toBe(true);
    expect(readJson(join(piDir, "settings.json")).defaultModel).toBe("ccr-opus");
  });

  it("removes [1m] from the fallback alias", () => {
    const { piDir } = createFixture();
    const config = {
      ContextWindow: 260000,
      Clients: {
        pi: {
          configPath: piDir,
          modelAlias: "ccr-sonnet[1m]",
        },
      },
    };

    enableClient(config, "pi");

    const provider = readJson(join(piDir, "models.json")).providers.ccr;
    expect(provider.models).toHaveLength(1);
    expect(provider.models[0]).toMatchObject({
      id: "ccr-sonnet",
      contextWindow: 260000,
    });
    expect(readJson(join(piDir, "settings.json")).defaultModel).toBe("ccr-sonnet");
  });

  it("keeps managed refresh idempotent when generated content is unchanged", async () => {
    const { piDir, projectDir } = createFixture();
    const config = {
      APIKEY: "test-key",
      PORT: 3456,
      ContextWindow: 300000,
      Router: {
        families: {
          opus: { default: "provider,opus", enableExtendedContext: true },
        },
      },
      Clients: {
        pi: { configPath: piDir },
      },
    };

    applyPiProjectTakeover(projectDir, config);
    const modelsPath = join(piDir, "models.json");
    const settingsPath = join(projectDir, ".pi", "settings.json");
    const initialModelsMtime = statSync(modelsPath).mtimeMs;
    const initialSettingsMtime = statSync(settingsPath).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 20));
    applyPiProjectTakeover(projectDir, config);

    expect(statSync(modelsPath).mtimeMs).toBe(initialModelsMtime);
    expect(statSync(settingsPath).mtimeMs).toBe(initialSettingsMtime);
  });

  it("registers a dedicated project provider carrying the managed project id", () => {
    const { piDir, projectDir } = createFixture();
    const config = {
      APIKEY: "test-key",
      PORT: 4567,
      Router: { default: "provider,project-model" },
      Clients: { pi: { configPath: piDir } },
    };

    applyPiProjectTakeover(projectDir, config);

    const providerName = getPiProjectProviderName(projectDir);
    const settings = readJson(join(projectDir, ".pi", "settings.json"));
    const provider = readJson(join(piDir, "models.json")).providers[providerName];
    expect(settings).toMatchObject({
      defaultProvider: providerName,
      defaultModel: "ccr-opus",
    });
    expect(provider).toMatchObject({
      baseUrl: "http://127.0.0.1:4567",
      headers: {
        [CCR_PROJECT_HEADER]: getClaudeProjectId(projectDir),
      },
    });
  });

  it("preserves Desktop modelOverrides across takeover refresh", () => {
    // Desktop (pi-desktop) writes model modelOverrides (contextWindow/maxTokens
    // edits from its model page) into the provider entry. The managed refresh
    // must keep them instead of regenerating the provider from scratch.
    const { piDir, projectDir } = createFixture();
    const config = {
      APIKEY: "test-key",
      PORT: 4567,
      Router: { default: "provider,project-model" },
      Clients: { pi: { configPath: piDir } },
    };

    applyPiProjectTakeover(projectDir, config);

    const providerName = getPiProjectProviderName(projectDir);
    const modelsPath = join(piDir, "models.json");
    const doc = readJson(modelsPath);
    doc.providers[providerName].modelOverrides = {
      "ccr-opus": { contextWindow: 200000, maxTokens: 32000 },
    };
    writeJson(modelsPath, doc);

    // Simulate a later takeover refresh (server restart / config change).
    applyPiProjectTakeover(projectDir, config);

    const provider = readJson(modelsPath).providers[providerName];
    expect(provider.modelOverrides).toEqual({
      "ccr-opus": { contextWindow: 200000, maxTokens: 32000 },
    });
    // Managed fields still win.
    expect(provider).toMatchObject({
      baseUrl: "http://127.0.0.1:4567",
      name: "Claude Code Router",
    });
  });

  it("preserves dedicated project providers when global Pi takeover is disabled", () => {
    const { piDir, projectDir } = createFixture();
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, "models.json"), JSON.stringify({
      providers: { official: { name: "Official" } },
    }));
    writeFileSync(join(piDir, "settings.json"), JSON.stringify({
      defaultProvider: "official",
      defaultModel: "official-model",
    }));
    const config = {
      APIKEY: "test-key",
      Router: { default: "provider,project-model" },
      Clients: { pi: { configPath: piDir } },
    };

    enableClient(config, "pi");
    applyPiProjectTakeover(projectDir, config);
    const projectProvider = getPiProjectProviderName(projectDir);
    disableClient(config, "pi");

    const models = readJson(join(piDir, "models.json"));
    expect(Object.keys(models.providers).sort()).toEqual(["official", projectProvider].sort());
    expect(models.providers[projectProvider].headers[CCR_PROJECT_HEADER]).toBe(
      getClaudeProjectId(projectDir)
    );
    expect(readJson(join(piDir, "settings.json"))).toMatchObject({
      defaultProvider: "official",
      defaultModel: "official-model",
    });
  });

  it("removes only the provider owned by the disabled project takeover", () => {
    const { piDir, projectDir } = createFixture();
    const otherProject = join(projectDir, "other");
    const config = {
      APIKEY: "test-key",
      Router: { default: "provider,project-model" },
      Clients: { pi: { configPath: piDir } },
    };
    applyPiProjectTakeover(projectDir, config);
    applyPiProjectTakeover(otherProject, config);

    removePiProjectTakeover(projectDir, config);

    const providers = readJson(join(piDir, "models.json")).providers;
    expect(providers[getPiProjectProviderName(projectDir)]).toBeUndefined();
    expect(providers[getPiProjectProviderName(otherProject)]).toBeDefined();
  });

  it("does not treat another project's provider as this project's takeover", () => {
    const { piDir, projectDir } = createFixture();
    const otherProject = join(projectDir, "other");
    const config = {
      APIKEY: "test-key",
      Router: { default: "provider,project-model" },
      Clients: { pi: { configPath: piDir } },
    };
    applyPiProjectTakeover(otherProject, config);
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({
      defaultProvider: getPiProjectProviderName(otherProject),
      defaultModel: "ccr-opus",
    }));

    removePiProjectTakeover(projectDir, config);

    const settings = readJson(join(projectDir, ".pi", "settings.json"));
    const providers = readJson(join(piDir, "models.json")).providers;
    expect(settings.defaultProvider).toBe(getPiProjectProviderName(otherProject));
    expect(providers[getPiProjectProviderName(otherProject)]).toBeDefined();
  });
});

describe("Pi project provider naming", () => {
  it("embeds a readable project slug plus a unique hash", () => {
    const name = getPiProjectProviderName("/Users/jason/projects/wengine/model-benchmark");
    expect(name).toMatch(/^ccr-project-model-benchmark-[0-9a-f]{12}$/);
  });

  it("is stable for the same path and distinct for same-basename projects", () => {
    const a1 = getPiProjectProviderName("/repos/one/api");
    const a2 = getPiProjectProviderName("/repos/one/api");
    const b = getPiProjectProviderName("/repos/two/api");
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    // Both share the readable slug; only the hash differs.
    expect(a1.startsWith("ccr-project-api-")).toBe(true);
    expect(b.startsWith("ccr-project-api-")).toBe(true);
  });

  it("sanitizes basenames with non-ascii or special characters", () => {
    const name = getPiProjectProviderName("/tmp/工作 目录.v2");
    expect(name).toMatch(/^ccr-project-v2-[0-9a-f]{12}$/);
  });

  it("keeps the ccr-project- prefix so pre-slug hash-only names stay recognized", () => {
    expect(getPiProjectProviderName("/a/b")).toMatch(/^ccr-project-/);
  });
});

describe("Pi legacy project provider migration", () => {
  function writeLegacyTakeover(piDir: string, projectDir: string, legacyName: string) {
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, "models.json"), JSON.stringify({
      providers: {
        [legacyName]: {
          name: "Claude Code Router",
          baseUrl: "http://127.0.0.1:4567",
          models: [{ id: "ccr-opus" }],
        },
      },
    }));
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({
      defaultProvider: legacyName,
      defaultModel: "ccr-opus",
    }));
  }

  function takeoverConfig(piDir: string) {
    return {
      APIKEY: "test-key",
      Router: { default: "provider,project-model" },
      Clients: { pi: { configPath: piDir } },
    };
  }

  it("migrates a pre-slug hash-only provider to the readable name on refresh", () => {
    const { piDir, projectDir } = createFixture();
    const legacyName = "ccr-project-0c969bce85c52041";
    writeLegacyTakeover(piDir, projectDir, legacyName);

    // The refresh path only touches projects it recognizes as taken over, so
    // the legacy name must count as active.
    expect(isPiProjectTakeoverActive(projectDir)).toBe(true);

    applyPiProjectTakeover(projectDir, takeoverConfig(piDir));

    const newName = getPiProjectProviderName(projectDir);
    expect(readJson(join(projectDir, ".pi", "settings.json")).defaultProvider).toBe(newName);
    const providers = readJson(join(piDir, "models.json")).providers;
    expect(providers[newName]).toBeDefined();
    expect(providers[newName].headers[CCR_PROJECT_HEADER]).toBe(getClaudeProjectId(projectDir));
    expect(providers[legacyName]).toBeUndefined();
  });

  it("keeps a bare-hash provider that is the current name of a slug-less project", () => {
    const { piDir, projectDir: root } = createFixture();
    // A basename with no [a-z0-9-] characters produces an empty slug, so the
    // computed name itself is bare hex — it must not be treated as legacy.
    const projectDir = join(root, "中文项目");
    const currentName = getPiProjectProviderName(projectDir);
    expect(currentName).toMatch(/^ccr-project-[0-9a-f]{12}$/);
    writeLegacyTakeover(piDir, projectDir, currentName);

    applyPiProjectTakeover(projectDir, takeoverConfig(piDir));

    expect(readJson(join(projectDir, ".pi", "settings.json")).defaultProvider).toBe(currentName);
    expect(readJson(join(piDir, "models.json")).providers[currentName]).toBeDefined();
  });

  it("clears a legacy provider when the project takeover is disabled", () => {
    const { piDir, projectDir } = createFixture();
    const legacyName = "ccr-project-3449c70d46280f6a";
    writeLegacyTakeover(piDir, projectDir, legacyName);
    const config = takeoverConfig(piDir);

    expect(isPiProjectTakeoverActive(projectDir)).toBe(true);
    removePiProjectTakeover(projectDir, config);

    // The fixture's settings carry only ccr fields, so the file is removed
    // once they are cleared.
    expect(existsSync(join(projectDir, ".pi", "settings.json"))).toBe(false);
    const providers = readJson(join(piDir, "models.json")).providers;
    expect(providers[legacyName]).toBeUndefined();
    expect(providers[getPiProjectProviderName(projectDir)]).toBeUndefined();
  });
});
