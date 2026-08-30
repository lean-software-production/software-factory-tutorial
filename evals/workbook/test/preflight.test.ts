import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { readAuthoredCommandStubEvidence } from "../command-stubs.js";
import {
  AUTHORED_PREFLIGHT_MIN_TOKENS_PER_PAID_CALL,
  AuthoredWorkbookEvalPreflightError,
  EVAL_JUDGE_COMMAND_ENV,
  EVAL_JUDGE_MODEL_ENV,
  OPENCODE_API_KEY_ENV,
  PRACTICE_COACH_LOG_PROMPT_ENV,
  WORKBOOK_TERMINAL_IMAGE,
  authoredTerminalDockerRunArguments,
  createDefaultJudgeProbe,
  defaultPreflightOperations,
  defaultRemoveDisposablePreflightFixture,
  createAuthoredWorkbookRunnerModelConfiguration,
  dockerClientEnvironment,
  parseAuthoredWorkbookEvalPreflightArgs,
  runAuthoredWorkbookEvalPreflight,
  satisfiesVersionRange,
  snapshotAuthoredWorkbookEvalEnvironment,
  validateAuthoredWorkbookEvalPreflightRequest,
  validateAuthoredWorkbookEvalPreflightRequestForTest,
  type AuthoredWorkbookEvalDisposableFixture,
  type AuthoredWorkbookEvalExternalOperations,
  type AuthoredWorkbookEvalPreflightPhase,
  type AuthoredWorkbookEvalPreflightRequestInput,
  type AuthoredWorkbookEvalScenario,
  type AuthoredWorkbookEvalTerminalInput
} from "../preflight.js";

const execFileAsync = promisify(execFile);
const secret = "sk-secret-123";
const privatePath = "/private/tmp/disposable-workbook-secret";

const CATALOG = [
  testScenario("part-1-happy-path", { mainTutor: 2, practiceCoach: 1, judge: 1, total: 4 }, { bounded: true, cheap: false }, { terminal: true, docker: true }),
  testScenario("part-2-review", { mainTutor: 1, practiceCoach: 1, judge: 1, total: 3 }, { cheap: true }, { docker: true })
] satisfies AuthoredWorkbookEvalScenario[];

function testScenario(
  id: string,
  expectedModelCalls: AuthoredWorkbookEvalScenario["expectedModelCalls"],
  expectedBudgetFlags: Record<string, boolean> = {},
  expectedCapabilityFlags: Record<string, boolean> = {}
): AuthoredWorkbookEvalScenario {
  return { id, expectedModelCalls, expectedBudgetFlags, expectedCapabilityFlags };
}

function validRequest(overrides: Partial<AuthoredWorkbookEvalPreflightRequestInput> = {}): AuthoredWorkbookEvalPreflightRequestInput {
  return {
    scenarioIds: ["primer-validation-misconception"],
    models: {
      mainTutor: "anthropic/claude-sonnet-4-5",
      practiceCoach: "openai/gpt-5-mini",
      judge: "google/gemini-3-pro"
    },
    costBudget: { maxPaidModelCalls: 18, maxEstimatedTokens: 36_000, estimatedTokensPerPaidCall: 2_000 },
    environment: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      [OPENCODE_API_KEY_ENV]: secret,
      [EVAL_JUDGE_COMMAND_ENV]: `${privatePath}/judge.sh`,
      [PRACTICE_COACH_LOG_PROMPT_ENV]: "0",
      EXTRA_SECRET: "must-not-copy"
    },
    repositoryRoot: process.cwd(),
    ...overrides
  };
}

function stubFixture(overrides: Partial<AuthoredWorkbookEvalDisposableFixture> = {}): AuthoredWorkbookEvalDisposableFixture {
  return {
    root: process.cwd(),
    workspaceRoot: process.cwd(),
    workspaceVolumeName: "authored-workbook-preflight-00000000-0000-4000-8000-000000000000",
    trustedNodeModulesHostPath: process.cwd(),
    commandStubs: {
      hostBinDir: resolve(process.cwd(), "factory/.tmp/authored-eval-command-stubs/bin"),
      hostStateDir: resolve(process.cwd(), "factory/.tmp/authored-eval-command-stubs"),
      hostEvidencePath: resolve(process.cwd(), "factory/.tmp/authored-eval-command-stubs/invocations.jsonl"),
      hostConfigPath: resolve(process.cwd(), "host-config.json"),
      hostContainerConfigPath: resolve(process.cwd(), "factory/.tmp/authored-eval-command-stubs/container-config.json"),
      workspaceRelativeBinPath: "factory/.tmp/authored-eval-command-stubs/bin",
      containerBinPath: "/workspace/factory/.tmp/authored-eval-command-stubs/bin",
      containerStateDir: "/workspace/factory/.tmp/authored-eval-command-stubs",
      containerEvidencePath: "/workspace/factory/.tmp/authored-eval-command-stubs/invocations.jsonl",
      containerConfigPath: "/workspace/factory/.tmp/authored-eval-command-stubs/container-config.json",
      runId: "00000000-0000-4000-8000-000000000000",
      containerShellActivation: "export AUTHORED_EVAL_COMMAND_STUB_CONFIG=/workspace/factory/.tmp/authored-eval-command-stubs/container-config.json; export PATH=/workspace/factory/.tmp/authored-eval-command-stubs/bin:$PATH",
      hostEnv: {},
      close: async () => undefined
    },
    ...overrides
  };
}

function recordingOperations(events: string[], overrides: Partial<AuthoredWorkbookEvalExternalOperations> = {}): Partial<AuthoredWorkbookEvalExternalOperations> {
  return {
    npmVersion: async ({ timeoutMs }) => { events.push(`npm:${timeoutMs}`); return "11.0.0"; },
    dockerReady: async ({ timeoutMs }) => { events.push(`docker-ready:${timeoutMs}`); },
    createDisposablePreflightFixture: async ({ timeoutMs }) => { events.push(`fixture-create:${timeoutMs}`); return stubFixture(); },
    dockerRunTerminal: async (input) => { events.push(`terminal-run:${input.timeoutMs}:${input.runtimeProvision.workspaceMountTargets.join(",")}`); },
    dockerMountReadiness: async (input) => { events.push(`terminal-readiness:${input.timeoutMs}:${input.name.startsWith("workbook-terminal-preflight-")}:${input.fixture.commandStubs.containerConfigPath}`); },
    dockerPiAuthentication: async (input) => { events.push(`terminal-auth:${input.timeoutMs}:${input.name.startsWith("workbook-terminal-preflight-")}`); },
    dockerRemoveTerminal: async (input) => { events.push(`terminal-rm:${input.timeoutMs}:${input.name.startsWith("workbook-terminal-preflight-")}`); },
    removeDisposablePreflightFixture: async ({ timeoutMs, name }) => { events.push(`fixture-rm:${timeoutMs}:${name}`); },
    probeMainTutor: async ({ roleLabel, model, timeoutMs, request }) => {
      events.push(`paid:${roleLabel}:${model.identity}:${request.environment.TUTOR_MODEL}:${timeoutMs}`);
      return { selectedModel: { provider: `${model.provider}-selected`, id: `${model.id}-selected` } };
    },
    probePracticeCoach: async ({ roleLabel, model, timeoutMs, request }) => {
      events.push(`paid:${roleLabel}:${model.identity}:${request.environment.PRACTICE_COACH_MODEL}:${timeoutMs}`);
      return { selectedModel: { provider: `${model.provider}-selected`, id: `${model.id}-selected` } };
    },
    probeJudge: async ({ roleLabel, model, timeoutMs, request }) => {
      events.push(`paid:${roleLabel}:${model.identity}:${request.environment.EVAL_JUDGE_MODEL}:${request.environment.EVAL_JUDGE_COMMAND !== undefined}:${timeoutMs}`);
      return { commandLabel: "configured-command", model: model.identity, capabilities: { jsonObject: true } };
    },
    ...overrides
  };
}

async function expectPreflightFailure(input: AuthoredWorkbookEvalPreflightRequestInput, operations: Partial<AuthoredWorkbookEvalExternalOperations>, signal?: AbortSignal): Promise<AuthoredWorkbookEvalPreflightError> {
  try {
    await runAuthoredWorkbookEvalPreflight(input, { operations, signal, timeoutsMs: { npmVersion: 5, dockerReady: 5, terminalStart: 5, terminalReadiness: 5, terminalAuth: 5, terminalCleanup: 5, fixture: 5, fixtureCleanup: 5, mainTutor: 5, practiceCoach: 5, judge: 5 } });
  } catch (error) {
    expect(error).toBeInstanceOf(AuthoredWorkbookEvalPreflightError);
    return error as AuthoredWorkbookEvalPreflightError;
  }
  throw new Error("Expected preflight to fail.");
}

function serializedPublicError(error: AuthoredWorkbookEvalPreflightError): string {
  const ownPropertySnapshot = Object.fromEntries(Object.getOwnPropertyNames(error).map((name) => [name, (error as unknown as Record<string, unknown>)[name]]));
  return JSON.stringify({ ownPropertySnapshot, json: error, stack: error.stack, message: error.message });
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveDeferred!: (value: T) => void;
  return { promise: new Promise<T>((resolve) => { resolveDeferred = resolve; }), resolve: resolveDeferred };
}

async function waitUntil(assertion: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!assertion()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for test condition");
    await new Promise((resolveWait) => setTimeout(resolveWait, 1));
  }
}

async function pauseableFixtureTimeoutCase(pauseAfter: "root" | "calculator" | "stub"): Promise<{ error: AuthoredWorkbookEvalPreflightError; events: string[]; root: string; closed: number }> {
  const events: string[] = [];
  const pause = deferred();
  const enteredFixture = deferred<void>();
  let root = "";
  let closed = 0;
  let operationSettled: Promise<unknown> | undefined;
  const operations = recordingOperations(events, {
    createDisposablePreflightFixture: (input) => {
      events.push(`fixture-create:${input.timeoutMs}:${input.signal instanceof AbortSignal}`);
      operationSettled = (async () => {
        root = await mkdtemp(join(tmpdir(), `authored-preflight-timeout-${pauseAfter}-`));
        enteredFixture.resolve();
        const workspaceRoot = resolve(root, "workspace");
        let commandStubs: AuthoredWorkbookEvalDisposableFixture["commandStubs"] | undefined;
        input.registerPartialFixtureLease?.({
          root,
          get commandStubs() { return commandStubs; },
          close: async () => {
            closed += 1;
            await commandStubs?.close();
            await rm(root, { recursive: true, force: true });
          }
        });
        if (pauseAfter === "root") await pause.promise;
        if (input.signal?.aborted) throw new Error("aborted after root");
        await mkdir(resolve(workspaceRoot, "calculator"), { recursive: true });
        await writeFile(resolve(workspaceRoot, "calculator/package.json"), "{}", "utf8");
        if (pauseAfter === "calculator") await pause.promise;
        if (input.signal?.aborted) throw new Error("aborted after calculator");
        await mkdir(resolve(workspaceRoot, "factory/.tmp/authored-eval-command-stubs/bin"), { recursive: true });
        commandStubs = {
          ...stubFixture({ root, workspaceRoot }).commandStubs,
          close: async () => {
            closed += 1;
            await rm(resolve(workspaceRoot, "factory/.tmp/authored-eval-command-stubs"), { recursive: true, force: true });
          }
        };
        if (pauseAfter === "stub") await pause.promise;
        if (input.signal?.aborted) throw new Error("aborted after stub");
        return stubFixture({ root, workspaceRoot, commandStubs });
      })();
      return operationSettled as Promise<AuthoredWorkbookEvalDisposableFixture>;
    }
  });

  vi.useFakeTimers();
  try {
    const failure = (async () => {
      try {
        await runAuthoredWorkbookEvalPreflight(validRequest(), { operations, timeoutsMs: { npmVersion: 5, dockerReady: 5, terminalStart: 5, terminalReadiness: 5, terminalAuth: 5, terminalCleanup: 5, fixture: 100, fixtureCleanup: 5, mainTutor: 5, practiceCoach: 5, judge: 5 } });
      } catch (error) {
        expect(error).toBeInstanceOf(AuthoredWorkbookEvalPreflightError);
        return error as AuthoredWorkbookEvalPreflightError;
      }
      throw new Error("Expected preflight to fail.");
    })();
    await enteredFixture.promise;
    expect(root).not.toBe("");
    await vi.advanceTimersByTimeAsync(100);
    const error = await failure;
    expect(existsSync(root)).toBe(false);
    pause.resolve();
    await operationSettled?.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    return { error, events, root, closed };
  } finally {
    vi.useRealTimers();
  }
}

describe("authored workbook eval preflight", () => {
  it("keeps help model-free and does not produce a runnable eval request", () => {
    const parsed = parseAuthoredWorkbookEvalPreflightArgs(["--help"], {
      TUTOR_MODEL: "secret/not-used",
      PRACTICE_COACH_MODEL: "secret/not-used",
      EVAL_JUDGE_MODEL: "secret/not-used"
    });

    if (parsed.kind !== "help") throw new Error("expected help");
    expect(parsed.text).toContain("not the final eval:workbook CLI");
    expect(parsed.text).toContain("does not create reports, session workspaces, curriculum slices, Docker containers, or model sessions");
  });

  it("resolves CLI scenarios only from an immutable source-of-truth catalog", async () => {
    const parsed = parseAuthoredWorkbookEvalPreflightArgs([
      "--scenario", "part-1-happy-path",
      "--max-paid-model-calls", "9",
      "--max-estimated-tokens", "18000"
    ], {
      PATH: process.env.PATH,
      OPENCODE_API_KEY: secret,
      EVAL_JUDGE_COMMAND: "judge-command",
      TUTOR_MODEL: "anthropic/tutor",
      PRACTICE_COACH_MODEL: "openai/coach",
      EVAL_JUDGE_MODEL: "google/eval-judge",
      JUDGE_MODEL: "secret/wrong"
    }, CATALOG);

    expect(parsed.kind).toBe("request");
    if (parsed.kind === "request") {
      expect(parsed.request.scenarioIds).toEqual(["part-1-happy-path"]);
      expect(parsed.request.models?.judge).toBe("google/eval-judge");
      await expect(runAuthoredWorkbookEvalPreflight(parsed.request, { operations: recordingOperations([]) })).rejects.toBeInstanceOf(AuthoredWorkbookEvalPreflightError);
    }

    expect(() => parseAuthoredWorkbookEvalPreflightArgs(["--scenario", "part-1-happy-path", "--max-paid-model-calls", "9", "--max-estimated-tokens", "18000"], validRequest().environment)).toThrow(AuthoredWorkbookEvalPreflightError);
    expect(() => parseAuthoredWorkbookEvalPreflightArgs(["--scenario", "missing", "--max-paid-model-calls", "9", "--max-estimated-tokens", "18000"], validRequest().environment, CATALOG)).toThrow(AuthoredWorkbookEvalPreflightError);
    expect(() => parseAuthoredWorkbookEvalPreflightArgs(["--scenario", "part-1-happy-path", "--scenario", "part-1-happy-path", "--max-paid-model-calls", "9", "--max-estimated-tokens", "18000"], validRequest().environment, CATALOG)).toThrow(AuthoredWorkbookEvalPreflightError);
  });

  it("does not deep-freeze or mutate process.env while producing an immutable plain env snapshot", () => {
    const before = { ...process.env };
    const env: NodeJS.ProcessEnv = { ...process.env, OPENCODE_API_KEY: secret, EVAL_JUDGE_COMMAND: "judge", EXTRA_SECRET: "nope" };
    delete env.PRACTICE_COACH_LOG_PROMPT;
    const request = validateAuthoredWorkbookEvalPreflightRequest(validRequest({ environment: env }));

    expect({ ...process.env }).toEqual(before);
    expect(() => { (process.env as Record<string, string | undefined>).AUTHORED_PREFLIGHT_MUTATION_TEST = "ok"; }).not.toThrow();
    delete process.env.AUTHORED_PREFLIGHT_MUTATION_TEST;
    expect(Object.isFrozen(process.env)).toBe(false);
    expect(Object.isFrozen(request.environment)).toBe(true);
    expect(request.environment.EXTRA_SECRET).toBeUndefined();
  });

  it("validates repeat defaults and multiplies only selected release scenario calls", async () => {
    const defaultRepeat = validateAuthoredWorkbookEvalPreflightRequest(validRequest());
    expect(defaultRepeat.repeat).toBe(1);
    expect(defaultRepeat.scenarios[0]?.expectedModelCalls).toEqual({ mainTutor: 14, practiceCoach: 0, judge: 1, total: 15 });
    expect(defaultRepeat.expectedCosts.paidReleaseCallsByRole).toEqual({ "Main Tutor": 14, "Practice Coach": 0, Judge: 1 });
    expect(defaultRepeat.expectedCosts.paidPreflightCallsByRole).toEqual({ "Main Tutor": 1, "Practice Coach": 1, Judge: 1 });

    const request = validateAuthoredWorkbookEvalPreflightRequest(validRequest({
      scenarioIds: ["primer-validation-misconception"],
      repeat: 3,
      costBudget: { maxPaidModelCalls: 48, maxEstimatedTokens: 96_000, estimatedTokensPerPaidCall: 2_000 }
    }));

    expect(request.repeat).toBe(3);
    expect(request.expectedCosts.paidPreflightCallsByRole).toEqual({ "Main Tutor": 1, "Practice Coach": 1, Judge: 1 });
    expect(request.expectedCosts.expectedPaidPreflightCalls).toBe(3);
    expect(request.expectedCosts.paidReleaseCallsByRole).toEqual({ "Main Tutor": 42, "Practice Coach": 0, Judge: 3 });
    expect(request.expectedCosts.expectedPaidReleaseCalls).toBe(45);
    expect(request.expectedCosts.expectedPaidModelCallsTotal).toBe(48);
    expect(request.expectedCosts.releaseScenarioCount).toBe(1);
    expect(request.expectedCosts.releaseRunCount).toBe(3);

    const events: string[] = [];
    const summary = await runAuthoredWorkbookEvalPreflight(validRequest({
      scenarioIds: ["primer-validation-misconception"],
      repeat: 3,
      costBudget: { maxPaidModelCalls: 48, maxEstimatedTokens: 96_000, estimatedTokensPerPaidCall: 2_000 }
    }), { operations: recordingOperations(events) });

    expect(summary.repeat).toBe(3);
    expect(summary.counts.paidPreflightCallsByRole).toEqual({ "Main Tutor": 1, "Practice Coach": 1, Judge: 1 });
    expect(summary.counts.paidReleaseCallsByRole).toEqual({ "Main Tutor": 42, "Practice Coach": 0, Judge: 3 });
    expect(events.filter((event) => event.startsWith("paid:"))).toHaveLength(3);
  });

  it("rejects invalid, missing, or duplicate repeat flags and repeat underbudgets before side effects", async () => {
    const badArgv = [
      ["--scenario", "part-1-happy-path", "--max-paid-model-calls", "9", "--max-estimated-tokens", "18000", "--repeat"],
      ["--scenario", "part-1-happy-path", "--max-paid-model-calls", "9", "--max-estimated-tokens", "18000", "--repeat", "0"],
      ["--scenario", "part-1-happy-path", "--max-paid-model-calls", "9", "--max-estimated-tokens", "18000", "--repeat", "4"],
      ["--scenario", "part-1-happy-path", "--max-paid-model-calls", "9", "--max-estimated-tokens", "18000", "--repeat", "3", "--repeat", "2"],
      ["--scenario", "part-1-happy-path", "--max-paid-model-calls", "9", "--max-paid-model-calls", "10", "--max-estimated-tokens", "18000"]
    ];
    const parserEnvironment = {
      ...validRequest().environment,
      TUTOR_MODEL: "anthropic/claude-sonnet-4-5",
      PRACTICE_COACH_MODEL: "openai/gpt-5-mini",
      EVAL_JUDGE_MODEL: "google/gemini-3-pro"
    };
    for (const argv of badArgv) expect(() => parseAuthoredWorkbookEvalPreflightArgs(argv, parserEnvironment, CATALOG)).toThrow(AuthoredWorkbookEvalPreflightError);

    expect(() => parseAuthoredWorkbookEvalPreflightArgs([
      "--scenario", "part-1-happy-path",
      "--max-paid-model-calls", "14",
      "--max-estimated-tokens", "28000",
      "--repeat", "3"
    ], parserEnvironment, CATALOG)).toThrow(AuthoredWorkbookEvalPreflightError);

    const events: string[] = [];
    const error = await expectPreflightFailure(validRequest({
      repeat: 3,
      costBudget: { maxPaidModelCalls: 47, maxEstimatedTokens: 96_000, estimatedTokensPerPaidCall: 2_000 }
    }), recordingOperations(events));
    expect(error.phase).toBe("budget");
    expect(events).toEqual([]);
  });

  it("fails pure argument and budget validation before npm, Docker, stubs, artifacts, or paid calls", async () => {
    const events: string[] = [];
    const argumentError = await expectPreflightFailure(validRequest({ scenarioIds: ["/tmp/private/path"] }), recordingOperations(events));
    expect(argumentError.phase).toBe("arguments");
    expect(events).toEqual([]);

    const duplicateScenarioId = await expectPreflightFailure(validRequest({ scenarioIds: ["primer-validation-misconception", "primer-validation-misconception"] }), recordingOperations(events));
    expect(duplicateScenarioId.phase).toBe("arguments");
    expect(events).toEqual([]);

    const oneTokenBudget = await expectPreflightFailure(validRequest({ costBudget: { maxPaidModelCalls: 18, maxEstimatedTokens: 1, estimatedTokensPerPaidCall: 1 } }), recordingOperations(events));
    expect(oneTokenBudget.phase).toBe("budget");
    expect(events).toEqual([]);

    const missingOnePreflightProbe = await expectPreflightFailure(validRequest({ costBudget: { maxPaidModelCalls: 17, maxEstimatedTokens: 36_000, estimatedTokensPerPaidCall: 2_000 } }), recordingOperations(events));
    expect(missingOnePreflightProbe.phase).toBe("budget");
    expect(events).toEqual([]);
  });

  it("makes prompt-log bypass impossible by failing on the real knob before probes", async () => {
    const events: string[] = [];
    const error = await expectPreflightFailure(
      validRequest({ environment: { PATH: process.env.PATH, OPENCODE_API_KEY: secret, EVAL_JUDGE_COMMAND: "judge", PRACTICE_COACH_LOG_PROMPT: "true" } }),
      recordingOperations(events)
    );

    expect(error.phase).toBe("promptLogging");
    expect(events).toEqual([]);
  });

  it("rejects under-declared, negative, bad-judge, missing-total, or inconsistent release scenario counts before probes", () => {
    const cases: AuthoredWorkbookEvalScenario[] = [
      { id: "missing-role", expectedModelCalls: { mainTutor: 1, judge: 1, total: 2 } as any },
      { id: "missing-total", expectedModelCalls: { mainTutor: 1, practiceCoach: 1, judge: 1 } as any },
      { id: "zero-judge", expectedModelCalls: { mainTutor: 1, practiceCoach: 1, judge: 0, total: 2 } },
      { id: "negative-coach", expectedModelCalls: { mainTutor: 1, practiceCoach: -1, judge: 1, total: 1 } },
      { id: "two-judges", expectedModelCalls: { mainTutor: 1, practiceCoach: 0, judge: 2, total: 3 } },
      { id: "bad-total", expectedModelCalls: { mainTutor: 1, practiceCoach: 1, judge: 1, total: 99 } }
    ];

    for (const scenario of cases) {
      expect(() => validateAuthoredWorkbookEvalPreflightRequestForTest(validRequest({ scenarioIds: [scenario.id] }), [scenario])).toThrow(AuthoredWorkbookEvalPreflightError);
    }

    const primer = validateAuthoredWorkbookEvalPreflightRequest(validRequest());
    expect(primer.scenarios[0]?.expectedModelCalls).toEqual({ mainTutor: 14, practiceCoach: 0, judge: 1, total: 15 });
    expect(primer.expectedCosts.paidPreflightCallsByRole["Practice Coach"]).toBe(1);
  });

  it("runs every unpaid check before paid Main Tutor, Practice Coach, then actual Judge command", async () => {
    const events: string[] = [];
    const summary = await runAuthoredWorkbookEvalPreflight(validRequest(), {
      operations: recordingOperations(events),
      timeoutsMs: { npmVersion: 5, dockerReady: 11, fixture: 5, fixtureCleanup: 5, mainTutor: 6, practiceCoach: 7, judge: 8 }
    });

    expect(events).toEqual([
      "npm:5",
      "docker-ready:11",
      "fixture-create:5",
      "terminal-run:30000:",
      "terminal-readiness:20000:true:/workspace/factory/.tmp/authored-eval-command-stubs/container-config.json",
      "terminal-auth:20000:true",
      "terminal-rm:10000:true",
      expect.stringMatching(/^fixture-rm:5:workbook-terminal-preflight-/),
      "paid:Main Tutor:anthropic/claude-sonnet-4-5:anthropic/claude-sonnet-4-5:6",
      "paid:Practice Coach:openai/gpt-5-mini:openai/gpt-5-mini:7",
      "paid:Judge:google/gemini-3-pro:google/gemini-3-pro:true:8"
    ]);
    expect(summary.counts.dockerReadyChecks).toBe(1);
    expect(summary.counts.paidPreflightCallsByRole).toEqual({ "Main Tutor": 1, "Practice Coach": 1, Judge: 1 });
  });

  it("unpaid readiness failure means zero paid calls and mandatory rm then fixture cleanup", async () => {
    const events: string[] = [];
    const error = await expectPreflightFailure(validRequest(), recordingOperations(events, {
      dockerMountReadiness: async () => { events.push(`readiness-fails:${secret}:${privatePath}`); throw new Error(`raw ${secret} ${privatePath}`); }
    }));

    expect(error.phase).toBe("terminalReadiness");
    expect(events).toEqual([
      "npm:5",
      "docker-ready:5",
      "fixture-create:5",
      "terminal-run:5:",
      `readiness-fails:${secret}:${privatePath}`,
      "terminal-rm:5:true",
      expect.stringMatching(/^fixture-rm:5:workbook-terminal-preflight-/)
    ]);
    expect(events.some((event) => event.startsWith("paid:"))).toBe(false);
    expect(serializedPublicError(error)).not.toContain(secret);
    expect(serializedPublicError(error)).not.toContain(privatePath);
  });

  it("cleans up a fixture even if no terminal input can be prepared", async () => {
    const events: string[] = [];
    const error = await expectPreflightFailure(validRequest(), recordingOperations(events, {
      createDisposablePreflightFixture: async () => { events.push("fixture-create-invalid"); return stubFixture({ workspaceVolumeName: "private/bad-volume-name" }); }
    }));

    expect(error.phase).toBe("terminal");
    expect(events).toEqual(["npm:5", "docker-ready:5", "fixture-create-invalid", "fixture-rm:5:not-started"]);
  });

  it("gives cleanup failure fixed precedence over success or a primary terminal failure", async () => {
    const events: string[] = [];
    const successCleanup = await expectPreflightFailure(validRequest(), recordingOperations(events, {
      dockerRemoveTerminal: async () => { events.push("rm-fails"); throw new Error(`rm raw ${secret}`); }
    }));
    expect(successCleanup.phase).toBe("cleanup");
    expect(events.some((event) => event.startsWith("paid:"))).toBe(false);

    events.length = 0;
    const primaryAndCleanup = await expectPreflightFailure(validRequest(), recordingOperations(events, {
      dockerPiAuthentication: async () => { events.push("auth-fails"); throw new Error("auth raw"); },
      removeDisposablePreflightFixture: async () => { events.push("fixture-rm-fails"); throw new Error("cleanup raw"); }
    }));
    expect(primaryAndCleanup.phase).toBe("cleanup");
  });

  it("cleans partial fixture leases on fixture creation timeout without later recreation", async () => {
    for (const pauseAfter of ["root", "calculator", "stub"] as const) {
      const { error, events, root, closed } = await pauseableFixtureTimeoutCase(pauseAfter);
      expect(error.phase, pauseAfter).toBe("terminal");
      expect(events).toEqual(["npm:5", "docker-ready:5", `fixture-create:100:true`]);
      expect(events.some((event) => event.startsWith("paid:"))).toBe(false);
      expect(existsSync(root), pauseAfter).toBe(false);
      expect(closed, pauseAfter).toBeGreaterThanOrEqual(1);
    }
  });

  it("bounds every timeout stage and reports the correct sanitized phase", async () => {
    const expectations = new Map<keyof AuthoredWorkbookEvalExternalOperations, AuthoredWorkbookEvalPreflightPhase>([
      ["npmVersion", "runtime"],
      ["dockerReady", "dockerReady"],
      ["createDisposablePreflightFixture", "terminal"],
      ["dockerRunTerminal", "terminal"],
      ["dockerMountReadiness", "terminalReadiness"],
      ["dockerPiAuthentication", "terminalAuth"],
      ["dockerRemoveTerminal", "cleanup"],
      ["removeDisposablePreflightFixture", "cleanup"],
      ["probeMainTutor", "mainTutor"],
      ["probePracticeCoach", "practiceCoach"],
      ["probeJudge", "judge"]
    ]);

    for (const [stage, phase] of expectations) {
      const events: string[] = [];
      const overrides: Partial<AuthoredWorkbookEvalExternalOperations> = {};
      (overrides as Record<string, unknown>)[stage] = async () => new Promise(() => undefined);
      const error = await expectPreflightFailure(validRequest(), recordingOperations(events, overrides));
      expect(error.phase, stage).toBe(phase);
      if (phase !== "mainTutor" && phase !== "practiceCoach" && phase !== "judge") expect(events.some((event) => event.startsWith("paid:"))).toBe(false);
    }
  });

  it("propagates external abort through runtime, Docker, fixture, and paid operations without continuing", async () => {
    for (const stage of ["npmVersion", "dockerReady", "dockerRunTerminal", "probeMainTutor"] as const) {
      const events: string[] = [];
      const controller = new AbortController();
      const operations = recordingOperations(events, {
        [stage]: async (input: any) => {
          events.push(`abort-stage:${stage}:${input.signal instanceof AbortSignal}`);
          controller.abort();
          await new Promise((_resolve, reject) => input.signal.addEventListener("abort", () => reject(new Error(`raw ${secret} ${privatePath}`)), { once: true }));
        }
      } as Partial<AuthoredWorkbookEvalExternalOperations>);
      const error = await expectPreflightFailure(validRequest(), operations, controller.signal);
      expect(error).toBeInstanceOf(AuthoredWorkbookEvalPreflightError);
      if (stage !== "probeMainTutor") expect(events.some((event) => event.startsWith("paid:")), stage).toBe(false);
      expect(serializedPublicError(error)).not.toContain(secret);
      expect(serializedPublicError(error)).not.toContain(privatePath);
    }
  });

  it("keeps public errors secret/path/diagnostic free even for adversarial paid failures", async () => {
    const events: string[] = [];
    const error = await expectPreflightFailure(validRequest(), recordingOperations(events, {
      probeJudge: async () => { throw Object.assign(new Error(`command failed: ${secret} at ${privatePath}`), { stderr: `stderr ${secret}`, command: [privatePath], cwd: privatePath }); }
    }));

    const serialized = serializedPublicError(error);
    expect(error.phase).toBe("judge");
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(privatePath);
    expect(serialized).not.toMatch(/stderr|command failed|response|prompt/i);
    expect(Object.getOwnPropertyNames(error).sort()).toEqual(["code", "message", "model", "name", "phase", "role", "stack"].sort());
  });

  it("uses production Docker argv/env primitives and never puts OPENCODE_API_KEY values in argv", () => {
    const request = validateAuthoredWorkbookEvalPreflightRequest(validRequest());
    const input: AuthoredWorkbookEvalTerminalInput = {
      request,
      timeoutMs: 123,
      name: "workbook-terminal-preflight-test",
      fixture: stubFixture(),
      runtimeProvision: { mounts: [], workspaceMountTargets: [] }
    };

    const args = authoredTerminalDockerRunArguments(input);
    expect(args.slice(0, 5)).toEqual(["run", "-d", "--rm", "--name", "workbook-terminal-preflight-test"]);
    expect(args).toContain("--env");
    expect(args).toContain(OPENCODE_API_KEY_ENV);
    expect(args.join(" ")).not.toContain(secret);
    expect(args).toContain(WORKBOOK_TERMINAL_IMAGE);
    expect(dockerClientEnvironment(request.environment).OPENCODE_API_KEY).toBeUndefined();
  });

  it("sends terminal readiness and authentication scripts through private Docker stdin, not argv", async () => {
    const request = validateAuthoredWorkbookEvalPreflightRequest(validRequest());
    const calls: Array<{ args: string[]; stdin?: string; serialized: string }> = [];
    const operations = defaultPreflightOperations({
      authoredDockerCommandRunner: async (_file, args, options) => {
        calls.push({ args, stdin: typeof options.privateStdin === "string" ? options.privateStdin : options.privateStdin?.toString("utf8"), serialized: JSON.stringify({ args, options }) });
      }
    });
    const input: AuthoredWorkbookEvalTerminalInput = { request, timeoutMs: 123, name: "workbook-terminal-preflight-test", fixture: stubFixture(), runtimeProvision: { mounts: [], workspaceMountTargets: [] } };

    await operations.dockerMountReadiness(input);
    await operations.dockerPiAuthentication(input);

    expect(calls.map((call) => call.args)).toEqual([
      ["exec", "-i", "workbook-terminal-preflight-test", "sh"],
      ["exec", "-i", "workbook-terminal-preflight-test", "sh"]
    ]);
    expect(calls[0]?.stdin).toContain("AUTHORED_EVAL_COMMAND_STUB_CONFIG");
    expect(calls[0]?.stdin).toContain(stubFixture().commandStubs.containerConfigPath);
    expect(calls[1]?.stdin).toContain("ModelRuntime");
    for (const call of calls) {
      expect(call.args.join(" ")).not.toContain("AUTHORED_EVAL_COMMAND_STUB_CONFIG");
      expect(call.args.join(" ")).not.toContain(stubFixture().commandStubs.containerConfigPath);
      expect(call.args.join(" ")).not.toContain(stubFixture().commandStubs.containerEvidencePath);
      expect(call.args.join(" ")).not.toContain(stubFixture().commandStubs.runId);
      expect(call.serialized).not.toContain(secret);
    }
  });

  it("uses the production Docker ready primitive seam rather than copied daemon/image commands", async () => {
    const request = validateAuthoredWorkbookEvalPreflightRequest(validRequest());
    const calls: Array<{ file: string; args: string[]; timeout: number; hasSecret: boolean }> = [];
    const operations = defaultPreflightOperations({
      authoredDockerCommandRunner: async (file, args, options) => {
        calls.push({ file, args, timeout: options.timeout, hasSecret: options.env?.OPENCODE_API_KEY === secret });
      }
    });

    await operations.dockerReady({ request, timeoutMs: 123 });
    expect(calls).toEqual([
      { file: "docker", args: ["info"], timeout: 10_000, hasSecret: false },
      { file: "docker", args: ["image", "inspect", WORKBOOK_TERMINAL_IMAGE], timeout: 10_000, hasSecret: false }
    ]);
  });

  it("creates an actual authored command-stub fixture and removes it without leaking directories", async () => {
    const request = validateAuthoredWorkbookEvalPreflightRequest(validRequest());
    const operations = defaultPreflightOperations();
    const fixture = await operations.createDisposablePreflightFixture({ request, timeoutMs: 10_000 });
    const root = fixture.root;
    try {
      expect(fixture.workspaceRoot).toBe(resolve(root, "workspace"));
      expect(fixture.commandStubs.hostConfigPath.startsWith(fixture.workspaceRoot)).toBe(false);
      expect(fixture.commandStubs.containerBinPath).toBe("/workspace/factory/.tmp/authored-eval-command-stubs/bin");
      expect(fixture.commandStubs.containerConfigPath).toBe("/workspace/factory/.tmp/authored-eval-command-stubs/container-config.json");
      expect(fixture.commandStubs.containerEvidencePath).toBe("/workspace/factory/.tmp/authored-eval-command-stubs/invocations.jsonl");
      expect(fixture.commandStubs.containerShellActivation).toContain("/workspace/factory/.tmp/authored-eval-command-stubs/bin");
      await expect(execFileAsync("/bin/sh", ["-c", "printf '%s' 'Findings reported by: authored preflight.\n- calculator/src/index.ts duplicated operator branch parser\n' | pi --no-session --tools read,grep,find,ls,bash -p"], {
        cwd: resolve(fixture.workspaceRoot, "calculator"),
        env: fixture.commandStubs.hostEnv,
        timeout: 5_000,
        encoding: "utf8"
      })).resolves.toMatchObject({ stderr: "" });
      const evidence = await readAuthoredCommandStubEvidence(fixture.commandStubs.hostEvidencePath);
      expect(evidence).toEqual([expect.objectContaining({ kind: "pi", accepted: true, cwd: "calculator", mode: "text", tools: "read,grep,find,ls,bash", station: "validator" })]);
    } finally {
      await defaultRemoveDisposablePreflightFixture({ request, timeoutMs: 5_000, name: "not-started", fixture, runtimeProvision: { mounts: [], workspaceMountTargets: [] } });
      await rm(root, { recursive: true, force: true });
    }
    expect(existsSync(root)).toBe(false);
  }, 15_000);


  it("default fixture cleanup closes command stubs and removes the temp root even when close fails", async () => {
    const request = validateAuthoredWorkbookEvalPreflightRequest(validRequest());
    const root = await mkdtemp(join(tmpdir(), "authored-preflight-cleanup-test-"));
    await mkdir(resolve(root, "workspace"), { recursive: true });
    const events: string[] = [];
    await expect(defaultRemoveDisposablePreflightFixture({
      request,
      timeoutMs: 5_000,
      name: "not-started",
      runtimeProvision: { mounts: [], workspaceMountTargets: [] },
      fixture: stubFixture({
        root,
        workspaceRoot: resolve(root, "workspace"),
        commandStubs: { ...stubFixture().commandStubs, close: async () => { events.push("close"); throw new Error("close failed"); } }
      })
    })).rejects.toThrow(/fixture cleanup failed/);
    expect(events).toEqual(["close"]);
    expect(existsSync(root)).toBe(false);
  });

  it("invokes the configured Judge command/model preflight path instead of a substitute SDK session", async () => {
    const request = validateAuthoredWorkbookEvalPreflightRequest(validRequest());
    const calls: Array<{ command?: string; model?: string; timeout?: number }> = [];
    const probe = createDefaultJudgeProbe(async (environment, options) => {
      calls.push({ command: environment.EVAL_JUDGE_COMMAND, model: environment.EVAL_JUDGE_MODEL, timeout: options?.timeoutMs });
      return { commandLabel: "configured-command", model: environment.EVAL_JUDGE_MODEL ?? "", capabilities: { jsonObject: true } };
    });

    await expect(probe({ request, timeoutMs: 4321, role: "judge", roleLabel: "Judge", model: request.models.judge })).resolves.toEqual({ commandLabel: "configured-command", model: "google/gemini-3-pro", capabilities: { jsonObject: true } });
    expect(calls).toEqual([{ command: `${privatePath}/judge.sh`, model: "google/gemini-3-pro", timeout: 4321 }]);
  });

  it("provides runner factories that carry the validated environment without exposing credentials", async () => {
    const request = validateAuthoredWorkbookEvalPreflightRequest(validRequest());
    const summary = await runAuthoredWorkbookEvalPreflight(validRequest(), { operations: recordingOperations([]) });
    const configuration = createAuthoredWorkbookRunnerModelConfiguration(request, summary);

    expect(Reflect.ownKeys(configuration).sort()).toEqual(["createMainTutor", "createPracticeCoach"]);
    expect(Object.hasOwn(configuration, "environment")).toBe(false);
    expect(JSON.stringify(configuration)).not.toContain(secret);
    expect(JSON.stringify(configuration)).not.toContain(OPENCODE_API_KEY_ENV);
    expect(JSON.stringify(configuration)).not.toContain("EXTRA_SECRET");
    expect(configuration.createMainTutor({ workspace: "/tmp/workbook", log: { info() {}, error() {} }, sessionFactory: async () => ({ prompt: async () => "ok", compact: async () => ({ summary: "ok" }), dispose() {} }) })).toBeDefined();
    expect(configuration.createPracticeCoach({ workspace: "/tmp/workbook", log: { info() {}, error() {} }, sessionFactory: async () => ({ prompt: async () => "ok", dispose() {} }) })).toBeDefined();
    expect(() => createAuthoredWorkbookRunnerModelConfiguration(request, { ...summary, repeat: 2 })).toThrow(AuthoredWorkbookEvalPreflightError);
    expect(JSON.stringify(summary)).not.toContain(secret);
  });

  it("produces a strictly public summary with budget warning, release budget, and same env identities", async () => {
    const events: string[] = [];
    const summary = await runAuthoredWorkbookEvalPreflight(validRequest({
      scenarioIds: ["primer-validation-misconception", "lesson-001-headless-boundary"],
      costBudget: { maxPaidModelCalls: 35, maxEstimatedTokens: 70_000, estimatedTokensPerPaidCall: AUTHORED_PREFLIGHT_MIN_TOKENS_PER_PAID_CALL }
    }), { operations: recordingOperations(events) });

    expect(summary.scenarioIds).toEqual(["primer-validation-misconception", "lesson-001-headless-boundary"]);
    expect(summary.configuredModelIdentities).toEqual([
      { role: "Main Tutor", provider: "anthropic", id: "claude-sonnet-4-5" },
      { role: "Practice Coach", provider: "openai", id: "gpt-5-mini" },
      { role: "Judge", provider: "google", id: "gemini-3-pro" }
    ]);
    expect(summary.selectedModelIdentities).toEqual([
      { role: "Main Tutor", provider: "anthropic-selected", id: "claude-sonnet-4-5-selected" },
      { role: "Practice Coach", provider: "openai-selected", id: "gpt-5-mini-selected" },
      { role: "Judge", provider: "google", id: "gemini-3-pro" }
    ]);
    expect(summary.counts.paidReleaseCallsByRole).toEqual({ "Main Tutor": 27, "Practice Coach": 3, Judge: 2 });
    expect(summary.counts.expectedPaidPreflightCalls).toBe(3);
    expect(summary.counts.expectedPaidReleaseCalls).toBe(32);
    expect(summary.counts.expectedPaidModelCallsTotal).toBe(35);
    expect(summary.counts.expectedEstimatedTokensTotal).toBe(70_000);
    expect(summary.expectedBudgetFlags).toEqual({});
    expect(summary.expectedCapabilityFlags).toEqual({});
    expect(summary.warnings.join("\n")).toContain("Main Tutor, Practice Coach, and Judge");
    expect(summary.warnings.join("\n")).toContain("model-token");

    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(privatePath);
    expect(serialized).not.toMatch(/prompt|response|diagnostic|stderr/i);
  });

  it("snapshots only needed config keys and ignores later global env changes", () => {
    const env = { PATH: "p", HOME: "h", OPENCODE_API_KEY: secret, EVAL_JUDGE_COMMAND: "judge", TUTOR_MODEL: "anthropic/a", PRACTICE_COACH_MODEL: "openai/b", EVAL_JUDGE_MODEL: "google/c", EXTRA_SECRET: "no" };
    const snapshot = snapshotAuthoredWorkbookEvalEnvironment(env);
    env.TUTOR_MODEL = "changed/after";
    expect(snapshot.TUTOR_MODEL).toBe("anthropic/a");
    expect(snapshot.EXTRA_SECRET).toBeUndefined();
  });

  it("matches supported Node/npm version ranges", () => {
    expect(satisfiesVersionRange("v24.2.0", ">=24.2.0 <25")).toBe(true);
    expect(satisfiesVersionRange("24.14.1", ">=24.2.0 <25")).toBe(true);
    expect(satisfiesVersionRange("25.0.0", ">=24.2.0 <25")).toBe(false);
    expect(satisfiesVersionRange("10.9.0", ">=11.0.0")).toBe(false);
  });
});
