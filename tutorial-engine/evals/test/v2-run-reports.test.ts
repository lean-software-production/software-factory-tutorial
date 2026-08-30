import { mkdtemp, readFile, rm, writeFile as nodeWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createV2LatestReport, runV2EvalOnce, type V2EvalRunnerDependencies, type V2EvalRunResult } from "../run.js";
import { buildV2JudgePrompt, createV2Report, verifyV2JudgeResult } from "../v2/judge.js";
import { findV2Scenario, type V2GateResult } from "../v2/scenarios.js";
import { projectV2JudgeTrace } from "../v2/session.js";
import { V2_ENGINE_EVAL_MARKERS, type EvaluationWorkspace, type V2SessionTrace } from "../v2/types.js";

const tempRoots: string[] = [];
const scenario = findV2Scenario("v2-exact-command-success");
const engineRoot = resolve(import.meta.dirname, "../..");

function passingGate(): V2GateResult {
  return { passed: true, assertions: [{ name: "synthetic gate", passed: true, detail: "ok" }] };
}

function failingGate(): V2GateResult {
  return { passed: false, assertions: [{ name: "synthetic gate", passed: false, detail: "terminal-review-requested review-request-secret" }] };
}

function fakeWorkspace(options: { startFails?: boolean; closeFails?: boolean } = {}): EvaluationWorkspace {
  const sessions = [{
    contentRoot: "/tmp/dead-content-root",
    sessionId: "session-stable-id",
    sessionRoot: "/tmp/dead-session-root",
    workspacesRoot: "/tmp/dead-workspaces-root",
    workspaceRoots: { "refactor-line": "/tmp/dead-workspace-root" }
  }];
  return {
    repositoryRoot: "/tmp/dead-repository-root",
    root: "/tmp/dead-content-root",
    webRoot: "/tmp/dead-web-root",
    sessions,
    latestSession() { return sessions.at(-1)!; },
    async startServer() {
      if (options.startFails) throw new Error("startup failed");
      return { url: "http://workbook.invalid", host: "127.0.0.1", port: 0, close: async () => {} };
    },
    async close() {
      if (options.closeFails) throw new Error("cleanup failed");
    }
  };
}

async function tempReportsRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "v2-run-reports-test-"));
  tempRoots.push(root);
  return root;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function serialize(value: unknown): string {
  return JSON.stringify(value);
}

function expectNoPrivateRawEvents(value: unknown): void {
  const text = typeof value === "string" ? value : serialize(value);
  expect(text).not.toContain("review-request-secret");
  expect(text).not.toContain("private-review-secret");
  expect(text).not.toContain("attempt-secret");
  expect(text).not.toContain("evidence-secret");
  expect(text).not.toContain("terminal-session-secret");
}

async function runWithTrace(reportsRoot: string, overrides: V2EvalRunnerDependencies = {}): Promise<V2EvalRunResult> {
  return runV2EvalOnce(scenario, 1, {
    engineRoot,
    reportsRoot,
    dependencies: {
      createEvaluationWorkspace: async () => fakeWorkspace(),
      gitRevision: () => "test-git-revision",
      now: (() => {
        const dates = [new Date("2026-08-20T00:00:00.000Z"), new Date("2026-08-20T00:00:01.000Z")];
        return () => dates.shift() ?? new Date("2026-08-20T00:00:02.000Z");
      })(),
      runV2ScenarioSession: async ({ trace }) => {
        trace.publicStates.push({ label: "public", state: { progress: { activeBlockId: "exact-command" } } });
        trace.events.push(
          { id: "raw-id", sequence: 1, at: "2026-08-20T00:00:00.000Z", type: "terminal-review-requested", lessonId: "001-live-session", blockId: "exact-command", attemptId: "attempt-secret", evidenceRef: "evidence-secret", requestId: "review-request-secret", mode: "automatic", callNumber: 1 } as V2SessionTrace["events"][number],
          { id: "raw-id", sequence: 2, at: "2026-08-20T00:00:00.000Z", type: "terminal-command-submitted", lessonId: "001-live-session", blockId: "exact-command", command: "echo secret", attemptId: "attempt-secret", terminalSessionId: "terminal-session-secret" } as V2SessionTrace["events"][number],
          { id: "raw-id", sequence: 3, at: "2026-08-20T00:00:00.000Z", type: "block_completed", lessonId: "001-live-session", blockId: "exact-command" } as V2SessionTrace["events"][number]
        );
        return trace;
      },
      deterministicV2Gate: () => passingGate(),
      judgeV2TraceFromPrompt: async (_prompt, trace) => verifyV2JudgeResult({
        dimensions: {
          protocolUse: { score: 2, citations: [0], rationale: "public" },
          tutorQuality: { score: 2, citations: [1], rationale: "projected" },
          criteriaFit: { score: 2, citations: [0, 1], rationale: "both" }
        },
        summary: "ok"
      }, trace),
      ...overrides
    }
  });
}

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

describe("v2 live eval report markers and metadata", () => {
  it("writes namespace/schema markers on success metadata, report, and latest envelope", async () => {
    const reportsRoot = await tempReportsRoot();
    const result = await runWithTrace(reportsRoot);
    const metadata = await readJson<Record<string, unknown>>(join(result.directory, "metadata.json"));
    const report = await readJson<Record<string, unknown>>(join(result.directory, "report.json"));
    const judgeInput = await readFile(join(result.directory, "judge-input.txt"), "utf8");
    const latest = createV2LatestReport([{ scenario: scenario.id, runs: [result] }], "2026-08-20T00:00:02.000Z");

    expect(result).toMatchObject({ scenario: scenario.id, passed: true, status: "passed", reportDirectory: expect.stringContaining(result.runId) });
    expect(result.reportDirectory).not.toMatch(/^\//);
    expect(metadata).toMatchObject({ ...V2_ENGINE_EVAL_MARKERS, scenario: scenario.id, status: "passed", lifecycle: expect.objectContaining({ deterministicGate: "passed", judge: "completed", report: "written" }) });
    expect(metadata).not.toHaveProperty("contentRoot");
    expect(metadata).not.toHaveProperty("workspaceRoots");
    expect(metadata).not.toHaveProperty("sessionRoot");
    expect(metadata).toMatchObject({ identifiers: { sessionId: "session-stable-id", workspaceIds: ["refactor-line"] } });
    expect(report).toMatchObject({ ...V2_ENGINE_EVAL_MARKERS, scenario: expect.objectContaining({ id: scenario.id }) });
    expect(latest).toMatchObject({ ...V2_ENGINE_EVAL_MARKERS, generatedAt: "2026-08-20T00:00:02.000Z", results: [{ scenario: scenario.id }] });
    expect(latest.results[0]?.runs[0]).not.toHaveProperty("directory");
    expectNoPrivateRawEvents(metadata);
    expectNoPrivateRawEvents(report);
    expectNoPrivateRawEvents(judgeInput);
    expectNoPrivateRawEvents(latest);
  });

  it("writes failure metadata when workspace creation fails", async () => {
    const reportsRoot = await tempReportsRoot();
    const result = await runV2EvalOnce(scenario, 1, {
      engineRoot,
      reportsRoot,
      dependencies: {
        createEvaluationWorkspace: async () => { throw new Error("workspace creation failed"); },
        gitRevision: () => "test-git-revision"
      }
    });
    const metadata = await readJson<Record<string, unknown>>(join(result.directory, "metadata.json"));

    expect(result).toMatchObject({ passed: false, status: "failed", error: "Evaluation failed while creating the disposable workspace; diagnostic status is recorded in metadata." });
    expect(metadata).toMatchObject({ ...V2_ENGINE_EVAL_MARKERS, status: "failed", failureStage: "workspace-creation", lifecycle: expect.objectContaining({ workspace: "failed", server: "not-started", deterministicGate: "not-run", judge: "not-run" }) });
  });

  it("writes failure metadata when server startup fails after session creation", async () => {
    const reportsRoot = await tempReportsRoot();
    const result = await runV2EvalOnce(scenario, 1, {
      engineRoot,
      reportsRoot,
      dependencies: {
        createEvaluationWorkspace: async () => fakeWorkspace({ startFails: true }),
        gitRevision: () => "test-git-revision"
      }
    });
    const metadata = await readJson<Record<string, unknown>>(join(result.directory, "metadata.json"));

    expect(result).toMatchObject({ passed: false, status: "failed", error: "Evaluation failed while starting the workbook server; diagnostic status is recorded in metadata." });
    expect(metadata).toMatchObject({ ...V2_ENGINE_EVAL_MARKERS, status: "failed", failureStage: "server-startup", identifiers: { sessionId: "session-stable-id", workspaceIds: ["refactor-line"] }, lifecycle: expect.objectContaining({ workspace: "closed", server: "failed", session: "not-started", deterministicGate: "not-run", judge: "not-run" }) });
  });

  it("writes deterministic gate failure metadata and never calls the judge", async () => {
    const reportsRoot = await tempReportsRoot();
    let judgeCalls = 0;
    const result = await runWithTrace(reportsRoot, {
      deterministicV2Gate: () => failingGate(),
      judgeV2TraceFromPrompt: async () => {
        judgeCalls += 1;
        throw new Error("judge must not run");
      }
    });
    const metadata = await readJson<Record<string, unknown>>(join(result.directory, "metadata.json"));
    const latest = createV2LatestReport([{ scenario: scenario.id, runs: [result] }]);

    expect(judgeCalls).toBe(0);
    expect(result).toMatchObject({ passed: false, status: "failed", error: "Deterministic gate failed before judge invocation; diagnostic status is recorded in metadata." });
    expect(metadata).toMatchObject({ ...V2_ENGINE_EVAL_MARKERS, status: "failed", failureStage: "deterministic-gate", lifecycle: expect.objectContaining({ deterministicGate: "failed", judge: "not-run", report: "not-written" }) });
    expectNoPrivateRawEvents(metadata);
    expectNoPrivateRawEvents(latest);
  });

  it("writes judge failure metadata with a sanitized public error summary", async () => {
    const reportsRoot = await tempReportsRoot();
    const result = await runWithTrace(reportsRoot, {
      judgeV2TraceFromPrompt: async () => { throw new Error("judge saw terminal-review-requested review-request-secret attempt-secret"); }
    });
    const metadata = await readJson<Record<string, any>>(join(result.directory, "metadata.json"));
    const latest = createV2LatestReport([{ scenario: scenario.id, runs: [result] }]);

    expect(result).toMatchObject({ passed: false, status: "failed" });
    expect(result.error).toBe("Evaluation failed during judge invocation or judge verdict; diagnostic status is recorded in metadata.");
    expect(metadata).toMatchObject({ ...V2_ENGINE_EVAL_MARKERS, status: "failed", failureStage: "judge", lifecycle: expect.objectContaining({ deterministicGate: "passed", judge: "failed", report: "not-written" }) });
    expect(metadata.failure.message).toBe("Evaluation failed during judge invocation or judge verdict; diagnostic status is recorded in metadata.");
    expectNoPrivateRawEvents(metadata);
    expectNoPrivateRawEvents(latest);
  });

  it("writes report failure metadata without advertising missing report files", async () => {
    const reportsRoot = await tempReportsRoot();
    const result = await runWithTrace(reportsRoot, {
      createV2Report: () => { throw new Error("report writer failed"); }
    });
    const metadata = await readJson<Record<string, any>>(join(result.directory, "metadata.json"));

    expect(result).toMatchObject({ passed: false, status: "failed", error: "Evaluation failed while writing report artifacts; diagnostic status is recorded in metadata." });
    expect(result).not.toHaveProperty("reportFile");
    expect(metadata).toMatchObject({ failureStage: "report", lifecycle: expect.objectContaining({ judge: "completed", report: "not-written" }) });
    expect(metadata.files).not.toHaveProperty("report");
  });

  it("writes unexpected session exception metadata", async () => {
    const reportsRoot = await tempReportsRoot();
    const result = await runWithTrace(reportsRoot, {
      runV2ScenarioSession: async () => { throw new Error("session failed"); }
    });
    const metadata = await readJson<Record<string, unknown>>(join(result.directory, "metadata.json"));

    expect(result).toMatchObject({ passed: false, status: "failed", error: "Evaluation failed while driving the scenario session; diagnostic status is recorded in metadata." });
    expect(metadata).toMatchObject({ ...V2_ENGINE_EVAL_MARKERS, status: "failed", failureStage: "session", lifecycle: expect.objectContaining({ session: "failed", deterministicGate: "not-run", judge: "not-run" }) });
  });

  it("does not let cleanup failures mask the original failure metadata", async () => {
    const reportsRoot = await tempReportsRoot();
    const result = await runV2EvalOnce(scenario, 1, {
      engineRoot,
      reportsRoot,
      dependencies: {
        createEvaluationWorkspace: async () => fakeWorkspace({ closeFails: true }),
        gitRevision: () => "test-git-revision",
        runV2ScenarioSession: async ({ trace }) => trace,
        deterministicV2Gate: () => failingGate()
      }
    });
    const metadata = await readJson<Record<string, any>>(join(result.directory, "metadata.json"));

    expect(result).toMatchObject({ passed: false, status: "failed", error: "Deterministic gate failed before judge invocation; diagnostic status is recorded in metadata." });
    expect(metadata).toMatchObject({ failureStage: "deterministic-gate", files: expect.objectContaining({ failure: "failure.txt", cleanupFailure: "cleanup-failure.txt" }) });
    expectNoPrivateRawEvents(metadata);
  });

  it("writes leaked-resource locations only to cleanup diagnostics", async () => {
    const reportsRoot = await tempReportsRoot();
    const result = await runWithTrace(reportsRoot, {
      createEvaluationWorkspace: async () => fakeWorkspace({ closeFails: true })
    });
    const metadata = await readJson<Record<string, any>>(join(result.directory, "metadata.json"));
    const failure = await readFile(join(result.directory, "failure.txt"), "utf8");
    const latest = createV2LatestReport([{ scenario: scenario.id, runs: [result] }]);

    expect(result).toMatchObject({ passed: false, status: "failed", error: "Evaluation failed during cleanup; diagnostic status is recorded in metadata." });
    expect(failure).toContain("cleanup failed");
    expect(failure).toContain("Leaked-resource locations");
    expect(failure).toContain("serverUrl: http://workbook.invalid");
    expect(failure).toContain("repositoryRoot: /tmp/dead-repository-root");
    expect(failure).toContain("contentRoot: /tmp/dead-content-root");
    expect(failure).toContain("sessionRoot: /tmp/dead-session-root");
    expect(failure).toContain("workspaceRoot.refactor-line: /tmp/dead-workspace-root");
    expect(JSON.stringify(metadata)).not.toContain("/tmp/dead");
    expect(JSON.stringify(metadata)).not.toContain("http://workbook.invalid");
    expect(JSON.stringify(latest)).not.toContain("/tmp/dead");
    expect(JSON.stringify(latest)).not.toContain("http://workbook.invalid");
  });

  it("returns a failed run result without advertising metadata when metadata writing fails", async () => {
    const reportsRoot = await tempReportsRoot();
    const result = await runWithTrace(reportsRoot, {
      writeFile: async (path, data) => {
        if (path.endsWith("metadata.json")) throw new Error("metadata write failed");
        await nodeWriteFile(path, data);
      }
    });
    const latest = createV2LatestReport([{ scenario: scenario.id, runs: [result] }]);

    expect(result).toMatchObject({ passed: false, status: "failed", failureStage: "metadata", error: "Evaluation completed but per-run metadata could not be written." });
    expect(result).not.toHaveProperty("metadataFile");
    expect(latest.results[0]?.runs[0]).toMatchObject({ failureStage: "metadata" });
    expect(latest.results[0]?.runs[0]).not.toHaveProperty("metadataFile");
    expect(latest).toMatchObject(V2_ENGINE_EVAL_MARKERS);
  });

  it("keeps report construction independently marked and private-event free", () => {
    const trace = projectV2JudgeTrace({
      scenarioId: scenario.id,
      publicStates: [{ label: "public", state: { progress: { activeBlockId: "exact-command" } } }],
      terminalTranscript: [],
      reflections: [],
      editors: [],
      events: [
        { id: "raw-id", sequence: 1, at: "2026-08-20T00:00:00.000Z", type: "terminal-feedback-recorded", attemptId: "attempt-secret", text: "review-request-secret" } as V2SessionTrace["events"][number],
        { id: "raw-id", sequence: 2, at: "2026-08-20T00:00:00.000Z", type: "block_completed", lessonId: "001-live-session", blockId: "exact-command" } as V2SessionTrace["events"][number]
      ],
      artifacts: []
    });
    const gate: V2GateResult = { passed: true, assertions: [{ name: "raw assertion name secret", passed: true, detail: "terminal-review-requested review-request-secret" }] };
    const judge = verifyV2JudgeResult({
      dimensions: {
        protocolUse: { score: 2, citations: [0], rationale: "public" },
        tutorQuality: { score: 2, citations: [1], rationale: "progress" },
        criteriaFit: { score: 2, citations: [0, 1], rationale: "both" }
      },
      summary: "ok"
    }, trace);
    const prompt = buildV2JudgePrompt(scenario, trace, gate);
    const unsafeJudge = {
      ...judge,
      raw: "terminal-review-requested",
      dimensions: {
        ...judge.dimensions,
        protocolUse: { ...judge.dimensions.protocolUse, extra: "review-request-secret" }
      }
    };
    const report = createV2Report({ scenario, trace, gate, judgeInput: prompt, judge: unsafeJudge as typeof judge, tutorModel: "tutor", judgeModel: "judge" });

    expect(report).toMatchObject(V2_ENGINE_EVAL_MARKERS);
    expect(report.gate).toEqual({
      passed: true,
      assertionCount: 1,
      failureCount: 0,
      assertions: [{ index: 0, passed: true }],
      detailPolicy: "assertion-details-omitted-from-public-report"
    });
    expectNoPrivateRawEvents(report);
    expect(JSON.stringify(report)).not.toContain("raw assertion name secret");
  });
});
