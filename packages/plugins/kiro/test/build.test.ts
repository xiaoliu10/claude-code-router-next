import { it, expect } from "vitest";
import { mkdtemp, cp, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

it("rejects package/runtime manifest version drift during a real build", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const fixture = await mkdtemp(join(tmpdir(), "kiro-build-"));
  try {
    for (const path of ["src", "scripts", "README.md", "package.json"]) await cp(join(root, path), join(fixture, path), { recursive: true });
    await symlink(join(root, "node_modules"), join(fixture, "node_modules"), "dir");
    const pkg = JSON.parse(await readFile(join(fixture, "package.json"), "utf8"));
    const declaredVersion = pkg.version;
    pkg.version = "99.0.0";
    await writeFile(join(fixture, "package.json"), JSON.stringify(pkg));
    const result = spawnSync(process.execPath, [join(root, "node_modules/tsx/dist/cli.mjs"), join(fixture, "scripts/build.ts")], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`manifest version ${declaredVersion} != package.json 99.0.0`);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});
