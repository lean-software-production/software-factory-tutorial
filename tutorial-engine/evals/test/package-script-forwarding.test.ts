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

async function gitIgnored(path: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", repoRoot, "check-ignore", "-q", path]);
    return true;
  } catch {
    return false;
  }
}

async function npmForwardedArgs(scriptName: "eval:engine" | "eval" | "eval:release", args: string[]): Promise<string[]> {
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
        "eval:release": rootPackage.scripts["eval:release"],
        eval: rootPackage.scripts.eval
      }
    }, null, 2));
    await writeFile(resolve(sandbox, "tutorial-engine/package.json"), JSON.stringify({
      name: "@lean-software-production/tutorial-engine",
      private: true,
      type: "module",
      scripts: {
        build: "node -e \"process.exit(0)\"",
        eval: enginePackage.scripts.eval,
        "eval:release": enginePackage.scripts["eval:release"]
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
  it("keeps active evaluator ownership paths, docs, markers, and report ignores unambiguous", async () => {
    const gitignore = await readFile(resolve(repoRoot, ".gitignore"), "utf8");
    const rootReadme = await readFile(resolve(repoRoot, "README.md"), "utf8");
    const rootEvalsReadme = await readFile(resolve(repoRoot, "evals/README.md"), "utf8");
    const workbookEvalsReadme = await readFile(resolve(repoRoot, "evals/workbook/README.md"), "utf8");
    const engineEvalsReadme = await readFile(resolve(engineRoot, "evals/README.md"), "utf8");

    expect(await exists(resolve(engineRoot, "evals/run.ts"))).toBe(true);
    expect(await exists(resolve(engineRoot, "evals/v2/scenarios.ts"))).toBe(true);
    expect(await exists(resolve(engineRoot, "evals/workbook/workbook.md"))).toBe(true);
    expect(await exists(resolve(engineRoot, "evals/test/v2-scenarios.test.ts"))).toBe(true);
    expect(await exists(resolve(repoRoot, "evals/README.md"))).toBe(true);
    expect(await exists(resolve(repoRoot, "evals/workbook/prerequisites/README.md"))).toBe(true);
    expect(await exists(resolve(repoRoot, "evals/workbook/README.md"))).toBe(true);
    expect(await exists(resolve(engineRoot, "test/check-visual-surface.test.ts"))).toBe(false);
    expect(await exists(resolve(repoRoot, "scripts/check-visual.mjs"))).toBe(false);
    expect(await exists(resolve(repoRoot, "evals/run.ts"))).toBe(false);

    expect(rootReadme).toContain("tutorial-engine/evals/reports/");
    expect(rootReadme).toContain("evals/workbook/reports/");
    expect(rootReadme).toContain("temporary compatibility alias for eval:engine, not authored eval");
    expect(rootReadme).toContain("`eval:workbook` is reserved");

    expect(rootEvalsReadme).toContain("[`../tutorial-engine/evals/`](../tutorial-engine/evals/) | `tutorial-engine` | Synthetic engine-mechanics live evals");
    expect(rootEvalsReadme).toContain("[`workbook/`](workbook/) | `root` | Real authored-curriculum evaluator foundations");
    expect(rootEvalsReadme).toContain("namespace `tutorial-engine/evals/engine-v2`, owner `tutorial-engine`, suite `engine-v2`");
    expect(rootEvalsReadme).toContain("schema `workbook-evaluator-prerequisite-seeds/v1` and owner `evals/workbook`");
    expect(rootEvalsReadme).toContain("`eval:workbook` is reserved and intentionally not wired");
    expect(rootEvalsReadme).toContain("No active runner writes `evals/reports/`");

    expect(workbookEvalsReadme).toContain("Root-owned evaluator code");
    expect(workbookEvalsReadme).toContain("command-stubs.ts");
    expect(workbookEvalsReadme).toContain("evals/workbook/reports/");

    expect(engineEvalsReadme).toContain("root-owned authored-workbook eval suite");
    expect(engineEvalsReadme).toContain('"namespace": "tutorial-engine/evals/engine-v2"');
    expect(engineEvalsReadme).toContain('"owner": "tutorial-engine"');
    expect(engineEvalsReadme).toContain('"suite": "engine-v2"');
    expect(engineEvalsReadme).toContain("tutorial-engine/evals/reports/<run-id>/");
    expect(engineEvalsReadme).toContain("root `evals/workbook/reports/`");

    expect(gitignore).toContain("Historical root eval reports from older runner locations; no active runner writes here.");
    expect(gitignore).toContain("Future authored-workbook live eval reports (owner: root)");
    expect(gitignore).toContain("Current live synthetic engine-mechanics eval reports (owner: tutorial-engine)");
    expect(gitignore).toContain("evals/reports/");
    expect(gitignore).toContain("evals/workbook/reports/");
    expect(gitignore).toContain("tutorial-engine/evals/reports/");
    await expect(gitIgnored("evals/reports/legacy/latest.json")).resolves.toBe(true);
    await expect(gitIgnored("evals/workbook/reports/latest.json")).resolves.toBe(true);
    await expect(gitIgnored("tutorial-engine/evals/reports/latest.json")).resolves.toBe(true);
    await expect(gitIgnored("evals/workbook/prerequisites/manifest.json")).resolves.toBe(false);
  });

  it("forwards root eval arguments through npm into the workspace eval runner", async () => {
    const args = ["--scenario", "v2-exact-command-success", "--repeat", "3"];

    await expect(npmForwardedArgs("eval:engine", args)).resolves.toEqual(["evals/run.ts", ...args]);
    await expect(npmForwardedArgs("eval", args)).resolves.toEqual(["evals/run.ts", ...args]);
  }, 15_000);

  it("forwards the root release shortcut into the bounded workspace release scope", async () => {
    await expect(npmForwardedArgs("eval:release", [])).resolves.toEqual(["evals/run.ts", "--release"]);
    await expect(npmForwardedArgs("eval:release", ["--repeat", "2"])).resolves.toEqual(["evals/run.ts", "--release", "--repeat", "2"]);
  }, 15_000);
});
