import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

type PackageJson = { scripts: Record<string, string> };

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../../..");
const engineRoot = resolve(repoRoot, "tutorial-engine");

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runNpm(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<void> {
  await execFileAsync("npm", args, { cwd, env: { ...process.env, ...env } });
}

async function npmForwardedArgs(scriptName: "eval:engine" | "eval", args: string[]): Promise<string[]> {
  const rootPackage = await readJson<PackageJson>(resolve(repoRoot, "package.json"));
  const enginePackage = await readJson<PackageJson>(resolve(engineRoot, "package.json"));
  const sandbox = await mkdtemp(resolve(tmpdir(), "eval-forwarding-"));
  const capture = resolve(sandbox, `${scriptName.replace(":", "-")}.json`);
  try {
    await mkdir(resolve(sandbox, "tutorial-engine/evals"), { recursive: true });
    await mkdir(resolve(sandbox, "node_modules/.bin"), { recursive: true });
    await writeFile(resolve(sandbox, "package.json"), JSON.stringify({
      name: "eval-forwarding-root",
      private: true,
      workspaces: ["tutorial-engine"],
      scripts: {
        "eval:engine": rootPackage.scripts["eval:engine"],
        eval: rootPackage.scripts.eval
      }
    }, null, 2));
    await writeFile(resolve(sandbox, "tutorial-engine/package.json"), JSON.stringify({
      name: "@lean-software-production/tutorial-engine",
      private: true,
      type: "module",
      scripts: {
        build: "node -e \"process.exit(0)\"",
        eval: enginePackage.scripts.eval
      }
    }, null, 2));
    await writeFile(resolve(sandbox, "node_modules/.bin/tsx"), [
      "#!/usr/bin/env node",
      "const { writeFileSync } = require('node:fs');",
      "writeFileSync(process.env.CAPTURE_ARGS, JSON.stringify(process.argv.slice(2)));"
    ].join("\n"));
    await chmod(resolve(sandbox, "node_modules/.bin/tsx"), 0o755);

    await runNpm(["run", scriptName, "--", ...args], sandbox, { CAPTURE_ARGS: capture });
    return JSON.parse(await readFile(capture, "utf8")) as string[];
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

describe("evaluator package ownership", () => {
  it("keeps active evaluator ownership under tutorial-engine while preserving historical report ignores", async () => {
    const gitignore = await readFile(resolve(repoRoot, ".gitignore"), "utf8");

    expect(await exists(resolve(engineRoot, "evals/run.ts"))).toBe(true);
    expect(await exists(resolve(engineRoot, "evals/v2/scenarios.ts"))).toBe(true);
    expect(await exists(resolve(engineRoot, "evals/workbook/workbook.md"))).toBe(true);
    expect(await exists(resolve(engineRoot, "evals/test/v2-scenarios.test.ts"))).toBe(true);
    expect(await exists(resolve(engineRoot, "test/check-visual-surface.test.ts"))).toBe(false);
    expect(await exists(resolve(repoRoot, "scripts/check-visual.mjs"))).toBe(false);
    expect(await exists(resolve(repoRoot, "evals/run.ts"))).toBe(false);
    expect(gitignore).toContain("evals/reports/");
    expect(gitignore).toContain("tutorial-engine/evals/reports/");
  });

  it("forwards root eval arguments through npm into the workspace eval runner", async () => {
    const args = ["--scenario", "v2-exact-command-success", "--repeat", "3"];

    await expect(npmForwardedArgs("eval:engine", args)).resolves.toEqual(["evals/run.ts", ...args]);
    await expect(npmForwardedArgs("eval", args)).resolves.toEqual(["evals/run.ts", ...args]);
  });
});
