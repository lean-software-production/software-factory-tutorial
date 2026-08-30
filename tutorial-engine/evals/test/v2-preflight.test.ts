import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertV2EvalTerminalReady,
  createDisposableV2EvalPreflightFixture,
  runV2EvalCli,
  type V2EvalPreflightDependencies,
  type V2EvalPreflightFixture,
  type V2EvalTerminalPreflightResult
} from "../run.js";
import { DOCKER_TERMINAL_COMMAND_TIMEOUTS_MS, WORKBOOK_TERMINAL_IMAGE, type DockerCommandRunner } from "../../src/workbook/terminal.js";

const engineRoot = resolve(import.meta.dirname, "../..");
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempChild(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "v2-eval-preflight-test-"));
  tempRoots.push(root);
  return join(root, name);
}

async function pathExists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch { return false; }
}

async function realDisposableFixture(): Promise<V2EvalPreflightFixture> {
  return createDisposableV2EvalPreflightFixture(engineRoot);
}

function successfulTerminal(): V2EvalTerminalPreflightResult {
  return { image: WORKBOOK_TERMINAL_IMAGE, capabilities: { dockerInfo: true, imageInspect: true, containerStart: true, piAuthentication: true } };
}

function orderedDeps(calls: string[], failAt?: string): V2EvalPreflightDependencies {
  const maybeFail = (stage: string): void => {
    calls.push(stage);
    if (failAt === stage) throw new Error(`${stage} failed`);
  };
  return {
    createDisposableFixture: async () => {
      maybeFail("fixture");
      return realDisposableFixture();
    },
    assertTerminalReady: async () => {
      maybeFail("docker");
      return successfulTerminal();
    },
    preflightWorkbookModels: async () => {
      maybeFail("models");
      return [
        { role: "Main Tutor", envVar: "TUTOR_MODEL", requested: "provider/tutor", selectedModel: { provider: "provider", id: "tutor" } }
      ];
    },
    probeJudgeCommandModel: async () => {
      maybeFail("judge");
      return { commandLabel: "default-pi", model: "provider/judge", capabilities: { jsonObject: true } };
    }
  };
}

const controlledEvalEnv = ["EVAL_JUDGE_MODEL", "OPENCODE_API_KEY", "TUTOR_MODEL", "EVAL_JUDGE_COMMAND"] as const;

async function withEvalEnvironment<T>(environment: NodeJS.ProcessEnv, action: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const name of controlledEvalEnv) {
    previous.set(name, process.env[name]);
    delete process.env[name];
  }
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined) process.env[name] = value;
  }
  try { return await action(); }
  finally {
    for (const name of controlledEvalEnv) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe("v2 live eval preflight", () => {
  it("keeps help and argument errors model-free and before all preflight probes", async () => {
    const calls: string[] = [];
    const reportsRoot = await tempChild("reports");

    await withEvalEnvironment({}, async () => {
      await expect(runV2EvalCli(["--help"], {
        reportsRoot,
        engineRoot,
        preflightDependencies: orderedDeps(calls),
        stdout: { write: () => true } as any
      })).resolves.toBe(0);
    });
    expect(calls).toEqual([]);

    await withEvalEnvironment({ EVAL_JUDGE_MODEL: "provider/judge" }, async () => {
      await expect(runV2EvalCli(["--scenario", "missing"], {
        reportsRoot,
        engineRoot,
        preflightDependencies: orderedDeps(calls)
      })).rejects.toThrow("Unknown v2 scenario 'missing'.");
    });
    expect(calls).toEqual([]);
    expect(await pathExists(reportsRoot)).toBe(false);
  });

  it("passes process.env consistently to CLI preflight probes", async () => {
    const calls: string[] = [];
    const reportsRoot = await tempChild("reports-process-env");
    const deps = orderedDeps(calls);
    const seen: boolean[] = [];
    deps.assertTerminalReady = async (_fixture, environment) => {
      seen.push(environment === process.env);
      calls.push(`docker:${environment.EVAL_JUDGE_MODEL}`);
      return successfulTerminal();
    };

    await withEvalEnvironment({ EVAL_JUDGE_MODEL: "provider/judge", OPENCODE_API_KEY: "not-recorded" }, async () => {
      await expect(runV2EvalCli(["--scenario", "v2-exact-command-success"], {
        reportsRoot,
        engineRoot,
        preflightDependencies: deps,
        dependencies: {
          createEvaluationWorkspace: async () => { throw new Error("stop before paid run"); }
        },
        stdout: { write: () => true } as any
      })).resolves.toBe(1);
    });

    expect(seen).toEqual([true]);
    expect(calls).toEqual(["fixture", "docker:provider/judge", "models", "judge"]);
  });

  it("prints only the judge command label, not the configured command path, after successful preflight", async () => {
    const reportsRoot = await tempChild("reports-command-label");
    const stdout: string[] = [];

    await withEvalEnvironment({ EVAL_JUDGE_MODEL: "provider/judge", EVAL_JUDGE_COMMAND: "/tmp/private-workspace/custom-judge --raw-flag", OPENCODE_API_KEY: "not-recorded" }, async () => {
      await expect(runV2EvalCli(["--scenario", "v2-exact-command-success"], {
        reportsRoot,
        engineRoot,
        preflightDependencies: {
          ...orderedDeps([]),
          probeJudgeCommandModel: async () => ({ commandLabel: "configured-command", model: "provider/judge", capabilities: { jsonObject: true } })
        },
        dependencies: {
          createEvaluationWorkspace: async () => { throw new Error("stop before paid run"); }
        },
        stdout: { write: (chunk: string) => { stdout.push(chunk); return true; } } as any
      })).resolves.toBe(1);
    });

    const output = stdout.join("");
    expect(output).toContain("judge configured-command/provider/judge");
    expect(output).not.toContain("/tmp/private-workspace");
    expect(output).not.toContain("custom-judge");
    expect(output).not.toContain("--raw-flag");
    expect(output).not.toContain("not-recorded");
  });

  it("checks explicit judge model before other probes", async () => {
    const calls: string[] = [];
    const reportsRoot = await tempChild("reports");

    await withEvalEnvironment({}, async () => {
      await expect(runV2EvalCli(["--scenario", "v2-exact-command-success"], {
        reportsRoot,
        engineRoot,
        preflightDependencies: orderedDeps(calls)
      })).rejects.toThrow("Set EVAL_JUDGE_MODEL");
    });

    expect(calls).toEqual([]);
    expect(await pathExists(reportsRoot)).toBe(false);
  });

  it("does not retain raw command causes, secrets, or absolute paths in public preflight errors", async () => {
    for (const [stage, deps] of [
      ["fixture", { createDisposableFixture: async () => { throw new Error("raw fixture path /tmp/private-workspace and not-recorded"); } }],
      ["docker", { ...orderedDeps([], undefined), assertTerminalReady: async () => { throw new Error("docker run --env OPENCODE_API_KEY=not-recorded --mount src=/tmp/private-workspace"); } }],
      ["models", { ...orderedDeps([], undefined), preflightWorkbookModels: async () => { throw new Error("Main Tutor raw provider response not-recorded at /tmp/private-workspace"); } }],
      ["judge", { ...orderedDeps([], undefined), probeJudgeCommandModel: async () => { throw new Error("judge command failed with HOME=/tmp/private-workspace and not-recorded"); } }]
    ] as const) {
      const reportsRoot = await tempChild(`reports-leak-${stage}`);
      let message = "";
      try {
        await withEvalEnvironment({ EVAL_JUDGE_MODEL: "provider/judge", OPENCODE_API_KEY: "not-recorded" }, async () => {
          await runV2EvalCli(["--scenario", "v2-exact-command-success"], {
            reportsRoot,
            engineRoot,
            preflightDependencies: deps
          });
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toContain("Live eval preflight failed");
      expect(message).not.toContain("not-recorded");
      expect(message).not.toContain("/tmp/private-workspace");
      expect(message).not.toContain("OPENCODE_API_KEY=");
      expect(await pathExists(reportsRoot)).toBe(false);
    }
  });

  it("runs live preflight probes in deterministic fail-fast order before report directories", async () => {
    for (const [stage, expected, message] of [
      ["fixture", ["fixture"], "validating the disposable evaluator fixture"],
      ["docker", ["fixture", "docker"], "checking Docker and workbook terminal readiness"],
      ["models", ["fixture", "docker", "models"], "checking Main Tutor model connectivity"],
      ["judge", ["fixture", "docker", "models", "judge"], "checking judge command/model connectivity"]
    ] as const) {
      const calls: string[] = [];
      const reportsRoot = await tempChild(`reports-${stage}`);

      await withEvalEnvironment({ EVAL_JUDGE_MODEL: "provider/judge", OPENCODE_API_KEY: "not-recorded" }, async () => {
        await expect(runV2EvalCli(["--scenario", "v2-exact-command-success"], {
          reportsRoot,
          engineRoot,
          preflightDependencies: orderedDeps(calls, stage)
        })).rejects.toThrow(message);
      });

      expect(calls).toEqual(expected);
      expect(await pathExists(reportsRoot)).toBe(false);
    }
  });

  it("checks Docker terminal readiness as info, image, run, Pi auth, then cleanup with bounded commands", async () => {
    const calls: Array<{ stage: string; timeout: number; env?: NodeJS.ProcessEnv; args: string[] }> = [];
    const runner: DockerCommandRunner = (_file, args, options) => {
      const stage = args[0] === "image" ? "image" : args[0] === "exec" ? "pi-auth" : args[0] === "rm" ? "cleanup" : args[0] ?? "unknown";
      calls.push({ stage, timeout: options.timeout, env: options.env, args });
    };

    await expect(assertV2EvalTerminalReady({ contentRoot: "/content", workspaceRoot: "/workspace", close: async () => {} }, { OPENCODE_API_KEY: "not-recorded", PATH: "/bin", LEAKED_SECRET: "absent" }, runner)).resolves.toEqual({
      image: WORKBOOK_TERMINAL_IMAGE,
      capabilities: { dockerInfo: true, imageInspect: true, containerStart: true, piAuthentication: true }
    });

    expect(calls.map((call) => call.stage)).toEqual(["info", "image", "run", "pi-auth", "cleanup"]);
    expect(calls.map((call) => call.timeout)).toEqual([
      DOCKER_TERMINAL_COMMAND_TIMEOUTS_MS.info,
      DOCKER_TERMINAL_COMMAND_TIMEOUTS_MS.imageInspect,
      DOCKER_TERMINAL_COMMAND_TIMEOUTS_MS.containerStart,
      DOCKER_TERMINAL_COMMAND_TIMEOUTS_MS.piAuthentication,
      DOCKER_TERMINAL_COMMAND_TIMEOUTS_MS.cleanup
    ]);
    expect(calls[2]?.args.join(" ")).toContain("--env OPENCODE_API_KEY");
    expect(calls[2]?.args.join(" ")).not.toContain("not-recorded");
    expect(calls[2]?.env).toEqual({ PATH: "/bin", OPENCODE_API_KEY: "not-recorded" });
  });

  it("fails terminal preflight with cleanup error when successful startup leaves an unremoved container", async () => {
    const calls: string[] = [];
    const runner: DockerCommandRunner = (_file, args) => {
      const stage = args[0] === "image" ? "image" : args[0] === "exec" ? "pi-auth" : args[0] === "rm" ? "cleanup" : args[0] ?? "unknown";
      calls.push(stage);
      if (stage === "cleanup") throw new Error("rm leaked not-recorded /tmp/private-workspace");
    };

    await expect(assertV2EvalTerminalReady({ contentRoot: "/content", workspaceRoot: "/workspace", close: async () => {} }, { OPENCODE_API_KEY: "not-recorded" }, runner)).rejects.toThrow("Live eval preflight failed while cleaning up the disposable workbook terminal container.");
    expect(calls).toEqual(["info", "image", "run", "pi-auth", "cleanup"]);
  });

  it("attempts cleanup and prefers fixed startup/auth cleanup failures when cleanup is unconfirmed", async () => {
    for (const [failAt, expected] of [
      ["run", "Could not start isolated terminal container for the workbook terminal preflight, and cleanup could not be confirmed."],
      ["pi-auth", "Could not authenticate Pi with OPENCODE_API_KEY inside the workbook terminal preflight, and cleanup could not be confirmed."]
    ] as const) {
      const calls: string[] = [];
      const runner: DockerCommandRunner = (_file, args) => {
        const stage = args[0] === "image" ? "image" : args[0] === "exec" ? "pi-auth" : args[0] === "rm" ? "cleanup" : args[0] ?? "unknown";
        calls.push(stage);
        if (stage === failAt || stage === "cleanup") throw new Error(`${stage} leaked not-recorded /tmp/private-workspace`);
      };

      await expect(assertV2EvalTerminalReady({ contentRoot: "/content", workspaceRoot: "/workspace", close: async () => {} }, { OPENCODE_API_KEY: "not-recorded" }, runner)).rejects.toThrow(expected);
      expect(calls).toEqual(failAt === "run" ? ["info", "image", "run", "cleanup"] : ["info", "image", "run", "pi-auth", "cleanup"]);
    }
  });
});
