import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authoredWorkbookReleaseBudget,
  createAuthoredWorkbookRunDependencies,
  createDefaultAuthoredWorkbookRunDependencies,
  defaultAuthoredWorkbookRunPrimitives,
  formatAuthoredWorkbookRunUsage,
  invokeAuthoredWorkbookCli,
  parseAuthoredWorkbookRunArgs,
  runAuthoredWorkbookEvalBatch,
  type AuthoredWorkbookRunDependencies,
  type AuthoredWorkbookRunInvocation
} from "../run.js";
import { AUTHORED_WORKBOOK_SCENARIOS, authoredWorkbookScenarioById } from "../scenarios.js";
import { authoredWorkbookEvalStabilityPassed } from "../reports.js";
import { createEmptyAuthoredWorkbookEvalSessionTrace, type AuthoredWorkbookEvalSessionTrace, type AuthoredWorkbookEvalTrace } from "../public-trace.js";
import { AUTHORED_PREFLIGHT_MIN_TOKENS_PER_PAID_CALL, createAuthoredWorkbookRunnerModelConfiguration, type AuthoredWorkbookEvalPreflightRequest, type AuthoredWorkbookEvalPublicSummary } from "../preflight.js";
import { DefaultMainWorkbookTutor } from "../../../tutorial-engine/src/workbook/tutor.js";
import { FastPracticeCoach } from "../../../tutorial-engine/src/workbook/practice-coach.js";

const env = {
  TUTOR_MODEL: "anthropic/claude-opus",
  PRACTICE_COACH_MODEL: "openai/gpt-mini",
  EVAL_JUDGE_MODEL: "openai/gpt-judge",
  EVAL_JUDGE_COMMAND: "judge",
  OPENCODE_API_KEY: "test-key",
  PATH: "/bin",
  HOME: "/tmp"
};

function request(ids = ["primer-validation-misconception"], repeat: 1 | 2 | 3 = 1): AuthoredWorkbookEvalPreflightRequest {
  return {
    scenarios: ids.map((id) => ({ id, expectedModelCalls: { mainTutor: 1, practiceCoach: 0, judge: 1, total: 2 }, expectedBudgetFlags: {}, expectedCapabilityFlags: {} })),
    repeat,
    costBudget: { maxPaidModelCalls: 20, maxEstimatedTokens: 40_000, estimatedTokensPerPaidCall: 2_000 },
    expectedCosts: { paidPreflightCallsByRole: { "Main Tutor": 1, "Practice Coach": 1, Judge: 1 }, paidReleaseCallsByRole: { "Main Tutor": 1, "Practice Coach": 0, Judge: 1 }, expectedPaidPreflightCalls: 3, expectedPaidReleaseCalls: 2, expectedPaidModelCallsTotal: 5, estimatedTokensPerPaidCall: 2_000, expectedEstimatedTokensTotal: 10_000, releaseScenarioCount: ids.length, releaseRunCount: ids.length * repeat },
    models: { mainTutor: { provider: "anthropic", id: "claude-opus", identity: "anthropic/claude-opus" }, practiceCoach: { provider: "openai", id: "gpt-mini", identity: "openai/gpt-mini" }, judge: { provider: "openai", id: "gpt-judge", identity: "openai/gpt-judge" } },
    environment: env,
    repositoryRoot: process.cwd(),
    nodeRange: ">=0.0.0",
    npmRange: ">=0.0.0",
    workbookTerminalImage: "lean-software-production/workbook-terminal:latest",
    opencodeApiKeyEnv: "OPENCODE_API_KEY",
    judgeCommandEnv: "EVAL_JUDGE_COMMAND"
  } as AuthoredWorkbookEvalPreflightRequest;
}

function summary(ids = ["primer-validation-misconception"], repeat: 1 | 2 | 3 = 1): AuthoredWorkbookEvalPublicSummary {
  return {
    scenarioIds: ids,
    repeat,
    configuredModelIdentities: [
      { role: "Main Tutor", provider: "anthropic", id: "claude-opus" },
      { role: "Practice Coach", provider: "openai", id: "gpt-mini" },
      { role: "Judge", provider: "openai", id: "gpt-judge" }
    ],
    selectedModelIdentities: [
      { role: "Main Tutor", provider: "anthropic", id: "claude-opus" },
      { role: "Practice Coach", provider: "openai", id: "gpt-mini" },
      { role: "Judge", provider: "openai", id: "gpt-judge" }
    ],
    judge: { commandLabel: "configured-command", model: "openai/gpt-judge", capabilities: { jsonObject: true } },
    counts: {} as AuthoredWorkbookEvalPublicSummary["counts"],
    expectedBudgetFlags: {},
    expectedCapabilityFlags: {},
    warnings: []
  };
}

function publicTraceFrom(trace: AuthoredWorkbookEvalSessionTrace): AuthoredWorkbookEvalTrace {
  return {
    scenarioId: trace.scenarioId,
    publicStates: [],
    terminalTranscript: trace.terminalTranscript.map(({ blockId, direction, text }) => blockId ? { blockId, direction, text } : { direction, text }),
    reflections: trace.reflections.map(({ blockId, role, text }) => ({ blockId, role, text })),
    editors: [],
    progressionEvents: trace.internalEvents as AuthoredWorkbookEvalTrace["progressionEvents"],
    artifacts: trace.artifacts
  };
}

function makeDeps(options: { failGate?: boolean; judgePass?: boolean; abortOnDrive?: AbortController; cleanupFails?: boolean } = {}) {
  const events: string[] = [];
  const latest: any[] = [];
  const writes: any[] = [];
  const kept: string[] = [];
  let preflightCalls = 0;
  let judgeCalls = 0;
  const deps: Partial<AuthoredWorkbookRunDependencies> = {
    preflight: async () => { events.push("preflight"); preflightCalls += 1; return summary(); },
    validatePreflightRequest: () => request(),
    createWorkspace: async ({ scenario, keepWorkspace }) => {
      events.push(`workspace:${scenario.id}`);
      const sessions: any[] = [];
      return {
        repositoryRoot: `/private/tmp/${scenario.id}`,
        root: "/tmp/root",
        webRoot: "/tmp/web",
        sourceTutorialRoot: "/tmp/source",
        provenance: {},
        sessions,
        latestSession: () => sessions.at(-1),
        startServer: async () => { throw new Error("startServer dependency must be used"); },
        assertGuardedStateUnchanged: async () => undefined,
        close: async () => { events.push(`workspace.close:${keepWorkspace}`); if (options.cleanupFails) throw new Error("cleanup boom"); }
      } as any;
    },
    startServer: async ({ workspace }) => {
      events.push("server");
      (workspace.sessions as any[]).push({ sessionRoot: "/tmp/session", workspaceRoots: { "refactor-line": "/tmp/session/refactor-line" } });
      return { url: "http://127.0.0.1:1", port: 1, host: "127.0.0.1", close: async () => { events.push("server.close"); } };
    },
    createCommandStubs: async ({ scenario }) => {
      events.push(`stubs:${scenario.id}`);
      if (scenario.stubLessonNumber === undefined) return undefined;
      return { runId: "123e4567-e89b-42d3-a456-426614174000", hostEvidencePath: "/tmp/evidence", containerShellActivation: "export PATH=/workspace/factory/.tmp/authored-eval-command-stubs/bin:$PATH", close: async () => { events.push("stubs.close"); } } as any;
    },
    createDriver: ({ trace }) => fakeDriver(trace, events, options.abortOnDrive),
    createGateEvidenceCollector: ({ trace, commandStubHandle }) => ({
      captureBaseline: async () => { events.push("baseline"); return {}; },
      captureGateCheckpoint: async (label: string) => { events.push(`checkpoint:${label}`); trace.internalEvents.push({ type: "observation_verified", lessonId: "004-feed-the-findings-back", blockId: "lesson--004-feed-the-findings-back--implementation-order" } as any); },
      collectGateInput: async () => { events.push("gate-input"); return { trace: publicTraceFrom(trace), commandInvocations: [], artifactSnapshots: [], workspaceFileSnapshots: [], rawEvents: trace.internalEvents, facts: { authoredSourceChanged: false, disposableCurriculumChanged: false, lessonJumpStarted: false, commandStubsCreated: commandStubHandle !== undefined, learnerWorkspaceChangedOutsideAllowlist: [], lesson001CalculatorBeforeSha256: "same", lesson001CalculatorAfterSha256: "same" } } as any; }
    } as any),
    judge: async ({ scenario }) => {
      events.push("judge");
      judgeCalls += 1;
      return { judgeInput: "prompt", judge: { criteria: Object.fromEntries(scenario.criteria.map((criterion) => [criterion.id, { score: options.judgePass === false ? 0 : 2, citations: [0], rationale: "ok" }])), summary: "ok" } as any };
    },
    writeSuccess: async ({ runId, bundle }) => { events.push(`write-success:${runId}`); writes.push({ kind: "success", bundle }); return { directory: `/reports/${runId}` }; },
    writeFailure: async ({ runId, status }) => { events.push(`write-failure:${status}`); writes.push({ kind: "failure", status }); return { directory: `/reports/${runId}` }; },
    writeLatest: async ({ runs }) => { events.push("latest"); latest.push(...runs); },
    writeGateDiagnostic: async () => { events.push("gate-diagnostic"); },
    writeFailureDiagnostic: async () => { events.push("failure-diagnostic"); },
    writeCleanupDiagnostic: async () => { events.push("cleanup-diagnostic"); },
    nowRunId: (scenarioId, repetition) => `${scenarioId}-${repetition}`,
    onKeptWorkspace: (path) => { kept.push(path); },
    log: (line) => { events.push(`log:${line}`); },
    error: (line) => { events.push(`error:${line}`); }
  };
  return { deps, events, latest, writes, kept, get preflightCalls() { return preflightCalls; }, get judgeCalls() { return judgeCalls; } };
}

function fakeDriver(trace: AuthoredWorkbookEvalSessionTrace, events: string[], abortOnDrive?: AbortController): any {
  const canonical = (blockId = "factory-vs-repl") => blockId.includes("--") ? blockId : `lesson--what-is-a-factory--${blockId}`;
  const push = (type: string, extra: Record<string, unknown> = {}) => {
    const blockId = canonical(String(extra.blockId ?? "factory-vs-repl"));
    trace.internalEvents.push({ type, lessonId: "what-is-a-factory", ...extra, blockId } as any);
  };
  const state = (blockId = "factory-vs-repl", status = "accepted") => ({ progress: { blocks: [{ id: canonical(blockId), checkpoint: { status } }] } });
  return {
    completeIntroduction: async () => { events.push("drive:intro"); push("workbook_introduction_completed"); return state(); },
    continueBlock: async (blockId: string) => { events.push(`drive:continue:${blockId}`); push("block_continued", { blockId: canonical(blockId) }); return state(blockId); },
    submitReflection: async (blockId: string, response: string) => { events.push(`drive:reflection:${blockId}`); const id = canonical(blockId); trace.reflections.push({ blockId: id, role: "learner", text: response }); trace.reflections.push({ blockId: id, role: "tutor", text: "Tutor feedback: use validation rather than trust." }); push("reflection_submitted", { blockId: id }); push("reflection_reply_recorded", { blockId: id }); if (abortOnDrive) { abortOnDrive.abort(); throw new Error("aborted by test"); } return state(blockId, "feedback"); },
    submitReflectionFollowUp: async (blockId: string, response: string) => { const id = canonical(blockId); trace.reflections.push({ blockId: id, role: "learner", text: response }); trace.reflections.push({ blockId: id, role: "tutor", text: "accepted" }); push("reflection_follow_up_submitted", { blockId: id }); push("reflection_reply_recorded", { blockId: id }); return state(blockId, "accepted"); },
    completeReflection: async (blockId: string) => { push("reflection_completed", { blockId: canonical(blockId) }); return state(blockId); },
    submitTerminalCommand: async (blockId: string, command: string) => { trace.terminalTranscript.push({ blockId, direction: "input", text: command }); trace.terminalTranscript.push({ blockId, direction: "output", text: "ok" }); push("attempt_accepted", { blockId, kind: "terminal" }); return state(blockId, "feedback"); },
    completeTerminalBlock: async (blockId: string) => { push("block_completed", { blockId }); return state(blockId); }
  };
}

function invocation(ids = ["primer-validation-misconception"], repeat: 1 | 2 | 3 = 1): AuthoredWorkbookRunInvocation {
  return { scope: ids.length === 1 ? "scenario" : "all", scenarioIds: ids as any, repeat, keepWorkspace: false, preflightInput: { scenarioIds: ids, repeat, costBudget: { maxPaidModelCalls: 20, maxEstimatedTokens: 40_000 }, environment: env }, preflightRequest: request(ids, repeat), preflightSummary: summary(ids, repeat) };
}

describe("authored workbook eval CLI parser", () => {
  it("has fixed usage, lists without side effects, and rejects invalid flags with code 2", async () => {
    expect(formatAuthoredWorkbookRunUsage()).toContain("--scenario <exact-id>");
    expect(parseAuthoredWorkbookRunArgs(["--scenario", "primer-validation-misconception", "--repeat", "3", "--max-paid-model-calls", "10", "--max-estimated-tokens", "20000"]).scenarioIds).toEqual(["primer-validation-misconception"]);
    for (const bad of [["--scenario"], ["--bogus"], ["--all"], ["--all", "--yes", "--scenario", "primer-validation-misconception"], ["--scenario", "nope"], ["--release", "--repeat", "2"], ["--release", "--keep-workspace"], ["--scenario", "primer-validation-misconception", "--scenario", "lesson-001-headless-boundary"]]) {
      expect(() => parseAuthoredWorkbookRunArgs(bad)).toThrow();
    }
    const fakes = makeDeps();
    const code = await invokeAuthoredWorkbookCli({ argv: ["--list"], dependencies: fakes.deps, installSignalHandlers: false });
    expect(code).toBe(0);
    expect(fakes.preflightCalls).toBe(0);
    expect(fakes.events.filter((event) => event.startsWith("workspace"))).toEqual([]);
  });
});

describe("authored workbook eval orchestration", () => {
  it("preflights exactly once before creating run artifacts and preserves previous latest on preflight failure", async () => {
    const fakes = makeDeps();
    fakes.deps.preflight = async () => { fakes.events.push("preflight"); throw new Error("preflight failed"); };
    const root = await mkdtemp(join(tmpdir(), "authored-run-test-"));
    await writeFile(join(root, "latest.json"), "previous", "utf8");
    const code = await invokeAuthoredWorkbookCli({ argv: ["--scenario", "primer-validation-misconception", "--max-paid-model-calls", "20", "--max-estimated-tokens", "40000"], env, dependencies: fakes.deps, reportsRoot: root, installSignalHandlers: false });
    expect(code).toBe(1);
    expect(fakes.events).toContain("preflight");
    expect(fakes.events.some((event) => event.startsWith("workspace"))).toBe(false);
    await expect(readFile(join(root, "latest.json"), "utf8")).resolves.toBe("previous");
  });

  it("runs selected scenario repetitions sequentially with fresh workspace/session and writes latest after the batch", async () => {
    const fakes = makeDeps();
    const code = await runAuthoredWorkbookEvalBatch(invocation(["primer-validation-misconception"], 2), { dependencies: fakes.deps });
    expect(code).toBe(0);
    expect(fakes.events.filter((event) => event.startsWith("workspace:primer"))).toHaveLength(2);
    expect(fakes.events.indexOf("latest")).toBeGreaterThan(fakes.events.lastIndexOf("write-success:primer-validation-misconception-2"));
    expect(fakes.latest.map((entry) => [entry.scenario, entry.repetition, entry.reportDirectory])).toEqual([
      ["primer-validation-misconception", 1, "primer-validation-misconception-1"],
      ["primer-validation-misconception", 2, "primer-validation-misconception-2"]
    ]);
  });

  it("uses catalog order for --release and --all selections", () => {
    expect(parseAuthoredWorkbookRunArgs(["--release", "--max-paid-model-calls", "99", "--max-estimated-tokens", "999999"]).scenarioIds).toEqual(AUTHORED_WORKBOOK_SCENARIOS.map((scenario) => scenario.id));
    expect(parseAuthoredWorkbookRunArgs(["--all", "--yes", "--repeat", "2", "--max-paid-model-calls", "99", "--max-estimated-tokens", "999999"]).repeat).toBe(2);
  });

  it("derives the bare --release budget from the authored catalog before preflight and without side effects", async () => {
    const derived = authoredWorkbookReleaseBudget();
    expect(Object.isFrozen(derived)).toBe(true);
    expect(derived).toEqual({
      maxPaidModelCalls: AUTHORED_WORKBOOK_SCENARIOS.reduce((total, scenario) => total + scenario.expectedModelCalls.total, 0) + 3,
      maxEstimatedTokens: (AUTHORED_WORKBOOK_SCENARIOS.reduce((total, scenario) => total + scenario.expectedModelCalls.total, 0) + 3) * AUTHORED_PREFLIGHT_MIN_TOKENS_PER_PAID_CALL
    });

    const events: string[] = [];
    let validatedInput: any;
    let preflightInput: any;
    const fakes = makeDeps();
    fakes.deps.validatePreflightRequest = (input) => { events.push("validate"); validatedInput = input; return request([...input.scenarioIds] as string[], input.repeat as 1); };
    fakes.deps.preflight = async (input) => { events.push("preflight"); preflightInput = input; throw new Error("stop after injected preflight"); };
    fakes.deps.createWorkspace = async () => { events.push("workspace"); throw new Error("no runner side effects in this test"); };

    const code = await invokeAuthoredWorkbookCli({ argv: ["--release"], env, dependencies: fakes.deps, installSignalHandlers: false });
    expect(code).toBe(1);
    expect(events).toEqual(["validate", "preflight"]);
    expect(validatedInput.costBudget).toEqual(derived);
    expect(preflightInput.costBudget).toEqual(derived);
    expect(validatedInput.scenarioIds).toEqual(AUTHORED_WORKBOOK_SCENARIOS.map((scenario) => scenario.id));
  });

  it("accepts only explicit --release budget overrides at or above the derived budget", async () => {
    const derived = authoredWorkbookReleaseBudget();
    const below = makeDeps();
    below.deps.validatePreflightRequest = () => { throw new Error("validate must not run for too-low release budget"); };
    below.deps.preflight = async () => { throw new Error("preflight must not run for too-low release budget"); };
    await expect(invokeAuthoredWorkbookCli({ argv: ["--release", "--max-paid-model-calls", String(derived.maxPaidModelCalls - 1), "--max-estimated-tokens", String(derived.maxEstimatedTokens)], env, dependencies: below.deps, installSignalHandlers: false })).resolves.toBe(2);

    let accepted: any;
    const above = makeDeps();
    above.deps.validatePreflightRequest = (input) => { accepted = input; return request([...input.scenarioIds] as string[], 1); };
    above.deps.preflight = async () => { throw new Error("stop after validating explicit budget"); };
    await expect(invokeAuthoredWorkbookCli({ argv: ["--release", "--max-paid-model-calls", String(derived.maxPaidModelCalls + 2), "--max-estimated-tokens", String((derived.maxPaidModelCalls + 2) * AUTHORED_PREFLIGHT_MIN_TOKENS_PER_PAID_CALL)], env, dependencies: above.deps, installSignalHandlers: false })).resolves.toBe(1);
    expect(accepted.costBudget).toEqual({ maxPaidModelCalls: derived.maxPaidModelCalls + 2, maxEstimatedTokens: (derived.maxPaidModelCalls + 2) * AUTHORED_PREFLIGHT_MIN_TOKENS_PER_PAID_CALL });
  });

  it("creates no stubs for primer/L001 and creates current stubs plus checkpoint activation for post-L001", async () => {
    const l001 = makeDeps();
    await runAuthoredWorkbookEvalBatch(invocation(["lesson-001-headless-boundary"], 1), { dependencies: l001.deps });
    expect(l001.events).toContain("stubs:lesson-001-headless-boundary");
    expect(l001.judgeCalls).toBe(0);

    const post = makeDeps();
    await runAuthoredWorkbookEvalBatch(invocation(["lessons-003-004-evidence-feedback"], 1), { dependencies: post.deps });
    expect(post.events).toContain("stubs:lessons-003-004-evidence-feedback");
    expect(post.events).toContain("checkpoint:lessons003004:after-multiply-only");
    expect(post.events.indexOf("baseline")).toBeLessThan(post.events.indexOf("drive:intro"));
  });

  it("runs deterministic gate before Judge, calls Judge zero times on gate failure, and once on pass", async () => {
    const fail = makeDeps();
    await runAuthoredWorkbookEvalBatch(invocation(), { dependencies: fail.deps });
    expect(fail.events.indexOf("gate-input")).toBeLessThan(fail.events.indexOf("judge"));
    expect(fail.judgeCalls).toBe(1);

    const bad = makeDeps();
    bad.deps.createGateEvidenceCollector = ({ trace }) => ({ captureBaseline: async () => {}, captureGateCheckpoint: async () => {}, collectGateInput: async () => ({ trace: { ...publicTraceFrom(trace), reflections: [], progressionEvents: [] }, commandInvocations: [], artifactSnapshots: [], workspaceFileSnapshots: [], rawEvents: [], facts: { authoredSourceChanged: false, disposableCurriculumChanged: false, lessonJumpStarted: false, commandStubsCreated: false, learnerWorkspaceChangedOutsideAllowlist: [] } }) } as any);
    const code = await runAuthoredWorkbookEvalBatch(invocation(), { dependencies: bad.deps });
    expect(code).toBe(1);
    expect(bad.judgeCalls).toBe(0);
    expect(bad.writes[0]).toMatchObject({ kind: "failure", status: "gate" });
  });

  it("cleans up in strict order, lets cleanup override only success, and warns privately for keep-workspace", async () => {
    const kept = makeDeps();
    const inv = { ...invocation(), keepWorkspace: true };
    await runAuthoredWorkbookEvalBatch(inv, { dependencies: kept.deps });
    expect(kept.kept[0]).toContain("/private/tmp/primer-validation-misconception");
    expect(kept.events.filter((event) => /close/.test(event))).toEqual(["server.close", "workspace.close:true"]);

    const cleanup = makeDeps({ cleanupFails: true });
    const code = await runAuthoredWorkbookEvalBatch(invocation(), { dependencies: cleanup.deps });
    expect(code).toBe(1);
    expect(cleanup.writes[0]).toMatchObject({ kind: "failure", status: "cleanup" });
    expect(cleanup.events).toContain("cleanup-diagnostic");
  });

  it("stops scheduling on interruption, writes attempted state, returns signal code, and removes listeners", async () => {
    const controller = new AbortController();
    const fakes = makeDeps({ abortOnDrive: controller });
    const before = process.listenerCount("SIGINT");
    const code = await runAuthoredWorkbookEvalBatch(invocation(["primer-validation-misconception", "lesson-001-headless-boundary"], 1), { dependencies: fakes.deps, signal: controller.signal, signalCode: () => 130 });
    expect(code).toBe(130);
    expect(fakes.writes[0]).toMatchObject({ kind: "failure", status: "interrupted" });
    expect(fakes.events.some((event) => event.includes("lesson-001"))).toBe(false);
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("turns success report write failures into report-status metadata and keeps later runs going", async () => {
    const fakes = makeDeps();
    let firstSuccess = true;
    fakes.deps.writeSuccess = async ({ runId }) => {
      fakes.events.push(`write-success-attempt:${runId}`);
      if (firstSuccess) { firstSuccess = false; throw new Error("raw fs path /private/tmp/report secret"); }
      return { directory: `/reports/${runId}` };
    };
    fakes.deps.writeFailure = async ({ runId, status }) => { fakes.events.push(`write-failure:${runId}:${status}`); return { directory: `/reports/${runId}` }; };
    const code = await runAuthoredWorkbookEvalBatch(invocation(["primer-validation-misconception"], 2), { dependencies: fakes.deps });

    expect(code).toBe(1);
    expect(fakes.events).toContain("write-failure:primer-validation-misconception-1:report");
    expect(fakes.events.filter((event) => event.startsWith("workspace:primer-validation-misconception"))).toHaveLength(2);
    expect(fakes.latest.map((entry) => [entry.scenario, entry.repetition, entry.status, entry.verdict.rule])).toEqual([
      ["primer-validation-misconception", 1, "report", "not-judged"],
      ["primer-validation-misconception", 2, "completed", "all-criteria-positive-and-aggregate-at-least-80-percent"]
    ]);
  });

  it("omits latest entries for unreported failure metadata writes while preserving batch continuation", async () => {
    const fakes = makeDeps();
    fakes.deps.writeFailure = async ({ status }) => { fakes.events.push(`write-failure-attempt:${status}`); throw new Error("raw fs path /private/tmp/report secret"); };
    fakes.deps.createGateEvidenceCollector = ({ trace }) => ({ captureBaseline: async () => {}, captureGateCheckpoint: async () => {}, collectGateInput: async () => ({ trace: { ...publicTraceFrom(trace), reflections: [], progressionEvents: [] }, commandInvocations: [], artifactSnapshots: [], workspaceFileSnapshots: [], rawEvents: [], facts: { authoredSourceChanged: false, disposableCurriculumChanged: false, lessonJumpStarted: false, commandStubsCreated: false, learnerWorkspaceChangedOutsideAllowlist: [] } }) } as any);
    const code = await runAuthoredWorkbookEvalBatch(invocation(["primer-validation-misconception", "lesson-001-headless-boundary"], 1), { dependencies: fakes.deps });

    expect(code).toBe(1);
    expect(fakes.events.filter((event) => event.startsWith("write-failure-attempt:gate"))).toHaveLength(2);
    expect(fakes.events).not.toContain("latest");
    expect(fakes.events.some((event) => event.startsWith("workspace:lesson-001-headless-boundary"))).toBe(true);
  });

  it("keeps sanitized unreported results when latest writing fails after valid on-disk entries", async () => {
    const fakes = makeDeps();
    fakes.deps.writeLatest = async ({ runs }) => { fakes.latest.push(...runs); throw new Error("latest raw /private/tmp/report secret"); };
    const code = await runAuthoredWorkbookEvalBatch(invocation(), { dependencies: fakes.deps });
    expect(code).toBe(1);
    expect(fakes.latest).toHaveLength(1);
    expect(fakes.events.find((event) => event.startsWith("error:"))).not.toMatch(/private\/tmp|secret/);
  });

  it("uses report-helper stability rules", async () => {
    expect(authoredWorkbookEvalStabilityPassed([{ passed: true }])).toBe(true);
    expect(authoredWorkbookEvalStabilityPassed([{ passed: true }, { passed: false }])).toBe(false);
    expect(authoredWorkbookEvalStabilityPassed([{ passed: true }, { passed: false }, { passed: true }])).toBe(true);
    const fakes = makeDeps({ judgePass: false });
    await expect(runAuthoredWorkbookEvalBatch(invocation(), { dependencies: fakes.deps })).resolves.toBe(1);
  });

  it("composes production runner dependencies from injectable low-level primitives", async () => {
    const defaults = defaultAuthoredWorkbookRunPrimitives;
    expect(defaults.runPreflight).toBeDefined();
    expect(defaults.Driver.name).toBe("AuthoredWorkbookDriver");

    const modelConfiguration = createAuthoredWorkbookRunnerModelConfiguration(request(), summary());
    const mainTutor = modelConfiguration.createMainTutor({ workspace: "/tmp/workbook", sessionFactory: async () => ({ prompt: async () => "ok", compact: async () => ({ summary: "ok" }), dispose() {} }) });
    const coach = modelConfiguration.createPracticeCoach({ workspace: "/tmp/workbook", sessionFactory: async () => ({ prompt: async () => "ok", dispose() {} }) });
    expect(mainTutor).toBeInstanceOf(DefaultMainWorkbookTutor);
    expect(coach).toBeInstanceOf(FastPracticeCoach);
    mainTutor.dispose();
    coach.dispose();

    const events: string[] = [];
    let uuid = 0;
    class RecordingPrimitiveDriver {
      constructor(options: { trace: AuthoredWorkbookEvalSessionTrace; privateTerminalShellPrefix?: string }) {
        events.push(`driver:${options.privateTerminalShellPrefix ?? "none"}`);
        return fakeDriver(options.trace, events) as any;
      }
    }
    const primitiveDeps = createAuthoredWorkbookRunDependencies({
      ...defaults,
      createWorkspace: (async (options: any) => {
        events.push(`primitive:workspace:${options.keepWorkspace}:${options.selection.parts[0].id}`);
        const sessions: any[] = [];
        return {
          repositoryRoot: "/workspace/root",
          root: "/workspace/root",
          webRoot: "/workspace/web",
          sourceTutorialRoot: "/source/tutorial",
          provenance: {},
          sessions,
          latestSession: () => sessions.at(-1),
          startServer: async (serverOptions: any) => {
            events.push(`primitive:startServer:${serverOptions.embeddedTerminal}:${serverOptions.mainTutor instanceof DefaultMainWorkbookTutor}:${serverOptions.practiceCoach instanceof FastPracticeCoach}`);
            sessions.push({ sessionRoot: "/session", workspaceRoots: { "refactor-line": "/session/refactor-line" } });
            return { url: "http://127.0.0.1:1", close: async () => { events.push("primitive:server.close"); } };
          },
          close: async () => { events.push("primitive:workspace.close"); }
        };
      }) as any,
      Driver: RecordingPrimitiveDriver as any,
      createGateEvidenceCollector: ((input: any) => { events.push(`primitive:gateCollector:${!!input.commandStubHandle}`); return { captureBaseline: async () => { events.push("primitive:baseline"); }, captureGateCheckpoint: async () => undefined, collectGateInput: async () => ({ trace: publicTraceFrom(input.trace), commandInvocations: [], artifactSnapshots: [], workspaceFileSnapshots: [], rawEvents: [], facts: { authoredSourceChanged: false, disposableCurriculumChanged: false, lessonJumpStarted: false, commandStubsCreated: false, learnerWorkspaceChangedOutsideAllowlist: [], lesson001CalculatorBeforeSha256: "same", lesson001CalculatorAfterSha256: "same" } }) }; }) as any,
      buildJudgePrompt: ((scenario: any) => (events.push(`primitive:prompt:${scenario.id}`), "prompt")) as any,
      invokeJudgeCommand: (async (requestArg: any) => { events.push(`primitive:invokeJudge:${requestArg.model}:${requestArg.signal instanceof AbortSignal}`); return { criteria: Object.fromEntries(authoredWorkbookScenarioById("primer-validation-misconception").criteria.map((criterion: any) => [criterion.id, { score: 2, citations: [], rationale: "ok" }])), summary: "ok" }; }) as any,
      verifyJudgeResult: ((raw: any) => (events.push("primitive:verify"), raw)) as any,
      writeReportBundle: (async (inputArg: any) => { events.push(`primitive:writeSuccess:${inputArg.runId}:${inputArg.scenario.id}`); return { directory: `/reports/${inputArg.runId}` }; }) as any,
      writeFailureMetadata: (async (inputArg: any) => { events.push(`primitive:writeFailure:${inputArg.runId}:${inputArg.status}`); return { directory: `/reports/${inputArg.runId}` }; }) as any,
      createLatestEnvelope: ((inputArg: any) => (events.push(`primitive:latestEnvelope:${inputArg.runs.map((run: any) => run.status).join(",")}`), { runs: inputArg.runs })) as any,
      writeLatestEnvelope: (async (_root: string, envelope: any) => { events.push(`primitive:latestWrite:${envelope.runs.length}`); }) as any,
      randomUUID: (() => `uuid-${++uuid}`) as any,
      log: (line) => { events.push(`log:${line}`); },
      error: (line) => { events.push(`error:${line}`); }
    });

    await expect(runAuthoredWorkbookEvalBatch(invocation(["primer-validation-misconception"], 1), { dependencies: primitiveDeps })).resolves.toBe(0);
    expect(events.filter((event) => event.startsWith("primitive:") || event.startsWith("driver:"))).toEqual([
      "primitive:workspace:false:what-is-a-factory",
      "primitive:startServer:true:true:true",
      "primitive:gateCollector:false",
      "primitive:baseline",
      "driver:none",
      "primitive:prompt:primer-validation-misconception",
      "primitive:invokeJudge:openai/gpt-judge:true",
      "primitive:verify",
      "primitive:server.close",
      "primitive:workspace.close",
      "primitive:writeSuccess:primer-validation-misconception-1-uuid-1:primer-validation-misconception",
      "primitive:latestEnvelope:completed",
      "primitive:latestWrite:1"
    ]);

    events.length = 0;
    primitiveDeps.createGateEvidenceCollector = ({ trace }: any) => ({ captureBaseline: async () => { events.push("primitive:baseline"); }, captureGateCheckpoint: async () => undefined, collectGateInput: async () => ({ trace: { ...publicTraceFrom(trace), reflections: [], progressionEvents: [] }, commandInvocations: [], artifactSnapshots: [], workspaceFileSnapshots: [], rawEvents: [], facts: { authoredSourceChanged: false, disposableCurriculumChanged: false, lessonJumpStarted: false, commandStubsCreated: false, learnerWorkspaceChangedOutsideAllowlist: [] } }) } as any);
    await expect(runAuthoredWorkbookEvalBatch(invocation(["primer-validation-misconception"], 1), { dependencies: primitiveDeps })).resolves.toBe(1);
    expect(events).toContain("primitive:writeFailure:primer-validation-misconception-1-uuid-2:gate");
    expect(events.some((event) => event.startsWith("primitive:invokeJudge"))).toBe(false);
  });
});
