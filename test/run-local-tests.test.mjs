import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandInvocationForStep,
  createReportInspector,
  invokeLocalTestOrchestrator,
  parseLocalTestOrchestratorArgs,
  repositoryRoot,
  runLocalTests
} from "../scripts/run-local-tests.mjs";
import { rootCommandContract } from "../scripts/local-test-command-contract.mjs";

async function withTemporaryRepository(callback) {
  const cwd = await mkdtemp(join(tmpdir(), "run-local-tests-"));
  try {
    await callback(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function releaseReportFixtureContract(steps) {
  return {
    execution: { mode: "continue-and-aggregate-independent-lanes" },
    steps: steps.map((step) => ({
      script: step.command,
      shell: `npm run ${step.command}`,
      ...step
    }))
  };
}

describe("root local test orchestrator", () => {
  it("is import-safe, rejects extra arguments, and exposes the exact supported profiles", async () => {
    for (const profile of ["test", "test:fast", "test:engine", "test:workbook", "test:workbook:fast"]) {
      assert.equal(parseLocalTestOrchestratorArgs([profile]), profile);
    }
    for (const bad of [[], ["test", "--extra"], ["test:engine:fast"], ["eval:engine"], ["check"]]) {
      assert.throws(() => parseLocalTestOrchestratorArgs(bad));
    }
    const errors = [];
    const code = await invokeLocalTestOrchestrator({ argv: ["test", "--extra"], error: (line) => errors.push(line), installSignalHandlers: false });
    assert.equal(code, 2);
    assert.match(errors.join("\n"), /Usage:/);
  });

  it("derives exact child argv/order/cwd/env/stdIO/shell false from the shared contract", async () => {
    const calls = [];
    const env = { PATH: "/bin", PRIVATE_TOKEN: "not-for-summary" };
    const logs = [];
    const code = await runLocalTests("test:workbook:fast", {
      env,
      log: (line) => logs.push(line),
      error: (line) => logs.push(line),
      runner: async (invocation) => {
        calls.push(invocation);
        return { status: 0 };
      }
    });

    assert.equal(code, 0);
    assert.deepEqual(calls.map(({ command, args, cwd, env: childEnv, stdio, shell }) => ({ command, args, cwd, childEnv, stdio, shell })), [
      { command: "npm", args: ["run", "test:onboarding"], cwd: repositoryRoot, childEnv: env, stdio: "inherit", shell: false },
      { command: "npm", args: ["run", "check:eval:workbook"], cwd: repositoryRoot, childEnv: env, stdio: "inherit", shell: false },
      { command: "npm", args: ["run", "test:eval:workbook"], cwd: repositoryRoot, childEnv: env, stdio: "inherit", shell: false },
      { command: "npm", args: ["run", "--workspace=tutorial-engine", "check:workbook"], cwd: repositoryRoot, childEnv: env, stdio: "inherit", shell: false },
      { command: "npm", args: ["run", "--workspace=tutorial/workspaces/refactor-line/calculator", "test"], cwd: repositoryRoot, childEnv: env, stdio: "inherit", shell: false }
    ]);
    assert.doesNotMatch(logs.join("\n"), /PRIVATE_TOKEN|not-for-summary/);
  });

  it("continues and aggregates all full release lanes after ordinary failures and spawn errors", async () => {
    const calls = [];
    const errors = [];
    const code = await runLocalTests("test", {
      log: (line) => errors.push(line),
      error: (line) => errors.push(line),
      runner: async (invocation) => {
        calls.push(invocation.args.join(" "));
        if (calls.length === 1) return { status: 1 };
        if (calls.length === 2) throw Object.assign(new Error("spawn ENOENT /private/tmp/secret"), { code: "ENOENT" });
        return { status: 0 };
      }
    });

    assert.equal(code, 1);
    assert.deepEqual(calls, [
      "run test:fast",
      "run --workspace=tutorial-engine test:visual",
      "run eval:engine -- --release",
      "run eval:workbook -- --release"
    ]);
    const summary = errors.join("\n");
    assert.match(summary, /deterministic-fast: FAIL/);
    assert.match(summary, /canonical-visual: FAIL/);
    assert.match(summary, /live-engine-eval: PASS/);
    assert.match(summary, /authored-workbook-eval: PASS/);
    assert.doesNotMatch(summary, /report target|\.received\.png|latest\.json|private\/tmp|secret/);
  });

  it("short-circuits ordered profiles and reports skipped remaining steps", async () => {
    const calls = [];
    const logs = [];
    const code = await runLocalTests("test:fast", {
      log: (line) => logs.push(line),
      error: (line) => logs.push(line),
      runner: async (invocation) => {
        calls.push(invocation.args.join(" "));
        return { status: 1 };
      }
    });

    assert.equal(code, 1);
    assert.deepEqual(calls, ["run test:engine:fast"]);
    assert.match(logs.join("\n"), /test:engine:fast: FAIL/);
    assert.match(logs.join("\n"), /test:workbook:fast: SKIPPED/);
  });

  it("prints no stale latest.json report when a failing lane leaves a preexisting target unchanged or deleted", async () => {
    await withTemporaryRepository(async (cwd) => {
      await mkdir(join(cwd, "evals/workbook/reports"), { recursive: true });
      await mkdir(join(cwd, "tutorial-engine/evals/reports"), { recursive: true });
      await writeFile(join(cwd, "evals/workbook/reports/latest.json"), "old workbook report\n");
      await writeFile(join(cwd, "tutorial-engine/evals/reports/latest.json"), "old engine report\n");

      const logs = [];
      const code = await runLocalTests("test", {
        cwd,
        contract: releaseReportFixtureContract([
          { command: "engine", report: "live-engine-eval", reportTarget: "tutorial-engine/evals/reports/latest.json" },
          { command: "workbook", report: "authored-workbook-eval", reportTarget: "evals/workbook/reports/latest.json" }
        ]),
        log: (line) => logs.push(line),
        error: (line) => logs.push(line),
        runner: async (_invocation, { step }) => {
          if (step.command === "engine") await unlink(join(cwd, "tutorial-engine/evals/reports/latest.json"));
          return { status: 1 };
        }
      });

      assert.equal(code, 1);
      const summary = logs.join("\n");
      assert.match(summary, /live-engine-eval: FAIL/);
      assert.match(summary, /authored-workbook-eval: FAIL/);
      assert.doesNotMatch(summary, /report:|latest\.json/);
    });
  });

  it("prints a latest.json report only when this lane rewrites it", async () => {
    await withTemporaryRepository(async (cwd) => {
      await mkdir(join(cwd, "evals/workbook/reports"), { recursive: true });
      await writeFile(join(cwd, "evals/workbook/reports/latest.json"), "old report\n");

      const logs = [];
      const code = await runLocalTests("test", {
        cwd,
        log: (line) => logs.push(line),
        error: (line) => logs.push(line),
        contract: releaseReportFixtureContract([{ command: "workbook", report: "authored-workbook-eval", reportTarget: "evals/workbook/reports/latest.json" }]),
        runner: async () => {
          await writeFile(join(cwd, "evals/workbook/reports/latest.json"), "new report\n");
          return { status: 1 };
        }
      });

      assert.equal(code, 1);
      assert.match(logs.join("\n"), /authored-workbook-eval: FAIL report: evals\/workbook\/reports\/latest\.json/);
    });
  });

  it("reports only changed visual received screenshots and none for visual passes without received output", async () => {
    await withTemporaryRepository(async (cwd) => {
      await mkdir(join(cwd, "tutorial-engine/test/visual"), { recursive: true });
      await mkdir(join(cwd, "empty-visual"), { recursive: true });
      await writeFile(join(cwd, "tutorial-engine/test/visual/existing.received.png"), "old screenshot\n");
      await writeFile(join(cwd, "tutorial-engine/test/visual/ignored.approved.png"), "approved\n");

      const logs = [];
      const code = await runLocalTests("test", {
        cwd,
        log: (line) => logs.push(line),
        error: (line) => logs.push(line),
        contract: releaseReportFixtureContract([
          { command: "unchanged", report: "visual-unchanged", reportTarget: "tutorial-engine/test/visual/*.received.png" },
          { command: "new", report: "visual-new", reportTarget: "tutorial-engine/test/visual/*.received.png" },
          { command: "modified", report: "visual-modified", reportTarget: "tutorial-engine/test/visual/*.received.png" },
          { command: "pass-empty", report: "visual-pass-empty", reportTarget: "empty-visual/*.received.png" }
        ]),
        runner: async (_invocation, { step }) => {
          if (step.command === "new") await writeFile(join(cwd, "tutorial-engine/test/visual/new.received.png"), "new screenshot\n");
          if (step.command === "modified") await writeFile(join(cwd, "tutorial-engine/test/visual/existing.received.png"), "changed screenshot\n");
          return { status: step.command === "pass-empty" ? 0 : 1 };
        }
      });

      assert.equal(code, 1);
      const lines = logs.join("\n");
      assert.match(lines, /visual-unchanged: FAIL/);
      assert.doesNotMatch(lines, /visual-unchanged: FAIL report:/);
      assert.match(lines, /visual-new: FAIL report: tutorial-engine\/test\/visual\/new\.received\.png/);
      assert.doesNotMatch(lines, /visual-new: FAIL.*existing\.received\.png/);
      assert.match(lines, /visual-modified: FAIL report: tutorial-engine\/test\/visual\/existing\.received\.png/);
      assert.doesNotMatch(lines, /visual-modified: FAIL.*ignored\.approved\.png/);
      assert.match(lines, /visual-pass-empty: PASS/);
      assert.doesNotMatch(lines, /visual-pass-empty: PASS report:/);
    });
  });

  it("does not inspect or print reports for skipped lanes", async () => {
    await withTemporaryRepository(async (cwd) => {
      const logs = [];
      const inspected = [];
      const code = await runLocalTests("test", {
        cwd,
        log: (line) => logs.push(line),
        error: (line) => logs.push(line),
        contract: {
          execution: { mode: "ordered-short-circuit" },
          steps: [
            { command: "first", shell: "npm run first", report: "first", reportTarget: "reports/first/latest.json" },
            { command: "skipped", shell: "npm run skipped", report: "skipped", reportTarget: "reports/skipped/latest.json" }
          ]
        },
        reportInspector: {
          snapshot: async (target) => {
            inspected.push(target);
            return await createReportInspector({ cwd }).snapshot(target);
          },
          changedReports: async (snapshot) => createReportInspector({ cwd }).changedReports(snapshot)
        },
        runner: async () => ({ status: 1 })
      });

      assert.equal(code, 1);
      assert.deepEqual(inspected, ["reports/first/latest.json"]);
      assert.match(logs.join("\n"), /skipped: SKIPPED/);
      assert.doesNotMatch(logs.join("\n"), /skipped: SKIPPED report:/);
    });
  });

  it("maps SIGINT/SIGTERM to interrupted exit codes and skips unscheduled lanes", async () => {
    for (const [signal, expectedCode] of [["SIGINT", 130], ["SIGTERM", 143]]) {
      const calls = [];
      const logs = [];
      const code = await runLocalTests("test", {
        signalName: () => signal,
        signalCode: () => expectedCode,
        log: (line) => logs.push(line),
        error: (line) => logs.push(line),
        runner: async (invocation) => {
          calls.push(invocation.args.join(" "));
          return { signal };
        }
      });
      assert.equal(code, expectedCode);
      assert.deepEqual(calls, ["run test:fast"]);
      assert.match(logs.join("\n"), /deterministic-fast: INTERRUPTED/);
      assert.match(logs.join("\n"), /canonical-visual: SKIPPED/);
      assert.match(logs.join("\n"), /live-engine-eval: SKIPPED/);
      assert.match(logs.join("\n"), /authored-workbook-eval: SKIPPED/);
    }
  });

  it("keeps the command invocation parser shell-free for every orchestrated contract step", () => {
    for (const profile of ["test", "test:fast", "test:engine", "test:workbook", "test:workbook:fast"]) {
      for (const step of rootCommandContract(profile).steps) {
        const invocation = commandInvocationForStep(step);
        assert.equal(invocation.command, "npm");
        assert.equal(invocation.shell, false);
        assert.equal(invocation.stdio, "inherit");
        assert.equal(invocation.cwd, repositoryRoot);
      }
    }
  });
});
