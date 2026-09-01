import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";
import { configDefaults } from "vitest/config";
import rootVitestConfigDefinition from "../vitest.config.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const vitestExecutable = resolve(repositoryRoot, "node_modules", ".bin", process.platform === "win32" ? "vitest.cmd" : "vitest");
const rootVitestConfig = resolve(repositoryRoot, "vitest.config.mjs");

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("close", (status, signal) => resolveRun({ status, signal, stdout, stderr }));
  });
}

test("root Vitest config preserves default excludes and adds only the root worktree cache", () => {
  assert.deepEqual(rootVitestConfigDefinition.test?.exclude, [...configDefaults.exclude, ".worktrees/**"]);
});

test("root Vitest config excludes nested .worktrees tests", async () => {
  const fixtureRoot = await mkdtemp(resolve(tmpdir(), "root-vitest-worktrees-exclude-"));
  try {
    const rootTestDirectory = resolve(fixtureRoot, "packages/example/test");
    const nestedWorktreeTestDirectory = resolve(fixtureRoot, ".worktrees/parallel-agent/packages/example/test");
    await mkdir(rootTestDirectory, { recursive: true });
    await mkdir(nestedWorktreeTestDirectory, { recursive: true });
    await writeFile(resolve(rootTestDirectory, "root-owned.test.ts"), `
      import { expect, test } from "vitest";
      test("root-owned fixture test runs", () => expect(1).toBe(1));
    `);
    await writeFile(resolve(nestedWorktreeTestDirectory, "nested-sentinel.test.ts"), `
      import { expect, test } from "vitest";
      test("nested worktree sentinel must not run", () => expect("nested .worktrees test was collected").toBe("excluded"));
    `);

    const result = await run(vitestExecutable, ["run", "--root", fixtureRoot, "--config", rootVitestConfig, "--reporter=dot"]);

    assert.equal(
      result.status,
      0,
      `expected nested .worktrees sentinel to be excluded\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
    assert.match(result.stdout, /Test Files\s+1 passed/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
