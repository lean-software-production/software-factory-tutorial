/**
 * The trigger half of `scripts/check-visual.mjs`.
 *
 * The script's expensive half needs Chromium and a built bundle, but its decision — should this
 * branch pay for a visual run? — is pure path logic over a git diff, and that is the half that
 * silently rots. A path that drops off `VISUAL_SURFACE` does not fail anything; it just makes the
 * suite stop firing, and the next rendering change lands unseen.
 *
 * So these tests run the real script against a throwaway repository with `SKIP_VISUAL_CHECK` set,
 * which stops it just after it announces its decision. No browser, no bundle, real git.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const repoRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(repoRoot, "scripts/check-visual.mjs");

/** Global and system git config are ignored so a developer's own settings cannot change a verdict. */
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

const sandboxes: string[] = [];

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, env: GIT_ENV });
}

/**
 * Builds a repository whose only committed file is the script under test, branches off `main`,
 * commits `paths` on the branch, and returns what the script says about that branch.
 */
async function decisionFor(paths: string[]): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), "check-visual-surface-"));
  sandboxes.push(dir);

  await git(dir, ["init", "--initial-branch=main"]);
  await git(dir, ["config", "user.email", "visual-surface@example.test"]);
  await git(dir, ["config", "user.name", "Visual Surface Test"]);
  await mkdir(resolve(dir, "scripts"), { recursive: true });
  await cp(scriptPath, resolve(dir, "scripts/check-visual.mjs"));
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "--no-gpg-sign", "-m", "the script itself"]);

  await git(dir, ["checkout", "-b", "a-branch"]);
  for (const path of paths) {
    const file = resolve(dir, path);
    await mkdir(dirname(file), { recursive: true });
    // The script is the one path that already exists here, and the branch still has to be able to
    // run it, so an edit to it is appended as a comment rather than written over the top.
    if (existsSync(file)) await appendFile(file, "\n// changed by the test\n");
    else await writeFile(file, "changed by the test\n");
  }
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "--no-gpg-sign", "-m", "the change under test"]);

  // SKIP_VISUAL_CHECK stops the script after it has announced the decision, so the browser and the
  // built bundle are never needed to observe it.
  return execFileSync(process.execPath, [resolve(dir, "scripts/check-visual.mjs")], {
    encoding: "utf8",
    env: { ...GIT_ENV, SKIP_VISUAL_CHECK: "1" },
  });
}

function ranTheSuite(output: string): boolean {
  return /on the visual surface changed/.test(output);
}

afterAll(async () => {
  await Promise.all(sandboxes.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("the visual check's trigger", () => {
  // The workbook screenshots are taken against a real server, so what a block's markdown is loaded
  // from, composed into, and ordered by is as visual as the stylesheet.
  const surface = [
    "tutorial-engine/web-workbook/src/App.tsx",
    "tutorial-engine/test/visual-affordances.mts",
    "tutorial-engine/test/visual/reading-line.approved.png",
    "tutorial-engine/test/fixtures/visual-workbook/lesson.md",
    "tutorial-engine/test/support/fake-tutors.ts",
    "tutorial-engine/src/workbook/authored-text.ts",
    "tutorial-engine/src/workbook/workbook-blocks.ts",
    "tutorial-engine/src/workbook/load.ts",
    "tutorial-engine/src/workbook/workflow.ts",
    "tutorial-engine/vite.config.ts",
    ".devcontainer/Dockerfile",
    "tutorial-engine/package.json",
    "scripts/check-visual.mjs",
  ];

  it.each(surface)("runs the suite for a branch touching only %s", async (path) => {
    expect(ranTheSuite(await decisionFor([path]))).toBe(true);
  });

  // The other half of the guarantee. These are the changes the optimisation exists for: if they
  // started firing the suite, every commit would pay for Chromium again.
  const offSurface = [
    "tutorial/lessons/001-run-an-agent-headlessly/lesson.md",
    "tutorial/docs/specs/002-build-a-doer.md",
    "AGENTS.md",
    "tutorial-engine/evals/run.ts",
    "tutorial-engine/src/workbook/cli-arguments.ts",
    // Deliberately absent from the surface: it moves on every dependency change, and almost none of
    // them touch rendering. The rendering-critical versions are pinned in tutorial-engine/package.json
    // instead, so a bump that can move pixels shows up there.
    "package-lock.json",
  ];

  it.each(offSurface)("still skips for a branch touching only %s", async (path) => {
    const output = await decisionFor([path]);
    expect(ranTheSuite(output)).toBe(false);
    expect(output).toContain("no change to the workbook's visual surface");
  });

  it("runs the suite when a visual change is mixed in with changes that are not", async () => {
    const output = await decisionFor([
      "tutorial/lessons/001-run-an-agent-headlessly/lesson.md",
      "tutorial-engine/src/workbook/authored-text.ts",
    ]);
    expect(ranTheSuite(output)).toBe(true);
  });
});

describe("the rendering dependencies the trigger relies on", () => {
  // Pinning is what makes `tutorial-engine/package.json` a usable trigger. Loosen one back to a
  // range and its next bump becomes a lockfile-only change, which the guard does not watch — the
  // suite would go quiet without any list having been edited.
  let manifest: { dependencies: Record<string, string>; devDependencies: Record<string, string> };

  beforeAll(async () => {
    manifest = JSON.parse(await readFile(resolve(repoRoot, "tutorial-engine/package.json"), "utf8"));
  });

  const pinned = [
    "@codemirror/commands",
    "@codemirror/state",
    "@codemirror/view",
    "@vitejs/plugin-react",
    "@xterm/addon-fit",
    "@xterm/xterm",
    "highlight.js",
    "mermaid",
    "react",
    "react-dom",
    "react-markdown",
    "rehype-highlight",
    "remark-gfm",
    "vite",
    "playwright",
  ];

  it.each(pinned)("pins %s to an exact version", (name) => {
    const declared = manifest.dependencies[name] ?? manifest.devDependencies[name];
    expect(declared, `${name} is not declared in tutorial-engine/package.json`).toBeDefined();
    expect(declared).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });
});
