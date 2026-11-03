import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { manifest, activate } from "../src/plugin";
it("packages a standalone plugin with all six host contributions and no core runtime inputs", async () => {
  const root = join(__dirname, "..");
  const bundle = await build({ entryPoints: [join(root, "src/plugin.ts")], bundle: true, platform: "node", target: "node20", format: "esm", metafile: true, write: false, logLevel: "silent" });
  expect(Object.keys(bundle.metafile!.inputs).filter(p => /(?:^|\/)core\/src\//.test(p))).toEqual([]);
  const registrations: string[] = [];
  const ctx: any = { host: { configDir: "/fixture/not-read" }, log: { info() {} } };
  for (const name of ["registerTransformer", "registerManagedRuntime", "registerAdminRoutes", "registerConfigProtector", "registerUiCard", "registerLocales"]) ctx[name] = () => registrations.push(name);
  await activate(ctx); expect(registrations).toHaveLength(6);
  expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version).toBe(manifest.version);
  expect(JSON.parse(readFileSync(join(root, "plugin.json"), "utf8"))).toMatchObject({ name: manifest.name, coreApi: manifest.coreApi, version: manifest.version });
  expect(readFileSync(join(root, "THIRD_PARTY_NOTICES.md"), "utf8")).toContain("Copyright (c) 2026 magpie-community contributors");
});
