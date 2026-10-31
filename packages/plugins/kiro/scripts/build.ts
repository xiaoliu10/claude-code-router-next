import { build } from "esbuild";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const dist = join(root, "dist");
await mkdir(dist, { recursive: true });
const result = await build({ entryPoints: [join(root, "src/plugin.ts")], outfile: join(dist, "plugin.js"), bundle: true,
  platform: "node", format: "esm", target: "node20", sourcemap: "external", metafile: true, legalComments: "none" });
if (Object.keys(result.metafile!.inputs).some(p => /(?:^|\/)core\/src\//.test(p))) throw new Error("Plugin bundle contains host runtime code");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
await writeFile(join(dist, "plugin.json"), JSON.stringify({ name: "kiro", version: pkg.version, coreApi: "1", description: pkg.description }, null, 2) + "\n");
await writeFile(join(dist, "package.json"), '{"type":"module"}\n');
await copyFile(join(root, "README.md"), join(dist, "README.md"));
console.log("kiro authentication plugin built into dist/");
