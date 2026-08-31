import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { chmod, link, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PublicWorkbookState } from "../../../tutorial-engine/src/workbook/public-contract.js";
import type { WorkbookTimelineRecord } from "../../../tutorial-engine/src/workbook/timeline.js";
import { createEmptyAuthoredWorkbookEvalSessionTrace, projectAuthoredWorkbookEvalTrace, projectAuthoredWorkbookEvalTraceForJudge } from "../public-trace.js";
import {
  AUTHORED_WORKBOOK_JUDGE_PROMPT_MAX_BYTES,
  AUTHORED_WORKBOOK_JUDGE_STDOUT_MAX_BYTES,
  authoredWorkbookJudgeVerdict,
  buildAuthoredWorkbookJudgePrompt,
  copyAuthoredWorkbookEvalScenarioPublicDescriptor,
  invokeAuthoredWorkbookJudgeCommand,
  judgeAuthoredWorkbookTrace,
  projectAuthoredWorkbookGateForPublicReport,
  verifyAuthoredWorkbookJudgeResult,
  type AuthoredWorkbookEvalGateResult,
  type AuthoredWorkbookEvalJudgeResult,
  type AuthoredWorkbookEvalScenarioPublicDescriptor
} from "../judge.js";
import {
  AUTHORED_WORKBOOK_LOCAL_DIAGNOSTIC_FILENAMES,
  AUTHORED_WORKBOOK_REPORT_FILENAMES,
  atomicWriteText,
  createAuthoredWorkbookEvalReportBundleObjects,
  authoredWorkbookEvalLocalDiagnosticText,
  authoredWorkbookEvalStabilityPassed,
  authoredWorkbookEvalStatusAfterCleanup,
  createAuthoredWorkbookEvalFailureMetadataEnvelope,
  createAuthoredWorkbookEvalLatestEnvelope,
  createAuthoredWorkbookEvalLatestRunEntry,
  writeAuthoredWorkbookEvalFailureDiagnostic,
  writeAuthoredWorkbookEvalGateDiagnostic,
  writeAuthoredWorkbookEvalLatestEnvelope,
  writeAuthoredWorkbookEvalFailureMetadata,
  writeAuthoredWorkbookEvalReportBundle,
  type AuthoredWorkbookEvalModelIdentities
} from "../reports.js";
import { AUTHORED_WORKBOOK_EVAL_MARKERS } from "../types.js";

const tempRoots: string[] = [];
const lessonId = "001-public-contract";

function record(event: Record<string, unknown>): WorkbookTimelineRecord {
  return { id: "raw-event-id-secret", sequence: 99, at: "2026-08-29T00:00:00.000Z", ...event } as WorkbookTimelineRecord;
}

function privateFinishedEvidence(): Record<string, unknown> {
  return {
    kind: "finished",
    command: "echo finished-command-secret",
    interactions: [{ kind: "input", data: "finished-interaction-input-secret" }, { kind: "output", data: "finished-interaction-output-secret" }],
    exitStatus: 0,
    transcriptSnapshot: { label: "finished-transcript-label-secret", transcript: "finished-transcript-body-secret", truncated: false }
  };
}

function publicState(note = "Visible public Tutor prose can mention terminal lifecycle, terminal-command-submitted, and JSON-looking \"tutor\":."): PublicWorkbookState {
  return {
    workbook: { title: "Public workbook" },
    introduction: "Intro",
    introductionComplete: true,
    chapters: [],
    progress: {
      activeLessonId: lessonId,
      activeBlockId: "lesson--001-public-contract--terminal",
      completedLessons: [],
      blocks: [],
      reflections: {},
      reflectionConversations: {}
    },
    adapter: { note, tutor: { text: note } },
    timeline: [{ type: "message", id: "public-message", sequence: 1, at: "browser-public-at", lessonId, blockId: "visible", role: "assistant", source: "main_tutor", presentation: "chat", text: note }]
  } as unknown as PublicWorkbookState;
}

function scenario(): AuthoredWorkbookEvalScenarioPublicDescriptor {
  return {
    id: "post-lesson-001",
    title: "Post-Lesson 001 authored workbook",
    description: "Evaluate the authored learner session.",
    criteria: [
      { id: "public-contract", title: "Public contract", description: "The session relies on learner-visible workbook state." },
      { id: "learner-progress", title: "Learner progress", description: "The learner makes credible progress through the task." }
    ]
  };
}

function gate(passed = true): AuthoredWorkbookEvalGateResult {
  return { passed, assertions: [{ name: "private gate assertion name secret", passed, detail: "private gate assertion detail secret /tmp/private-gate-path" }] };
}

function modelIdentities(): AuthoredWorkbookEvalModelIdentities {
  return {
    "Main Tutor": { requested: "anthropic/claude", selected: "anthropic/claude-4" },
    Judge: { requested: "google/gemini", selected: "google/gemini-2.5" }
  };
}

function projectedTrace() {
  const trace = createEmptyAuthoredWorkbookEvalSessionTrace("post-lesson-001");
  trace.publicStates.push({ label: "visible", state: publicState() });
  trace.terminalTranscript.push({ blockId: "terminal", direction: "input", text: "npm test\r", at: "terminal-at-secret" });
  trace.reflections.push({ blockId: "reflection", role: "tutor", text: "Visible tutor reply.", at: "reflection-at-secret" });
  trace.editors.push({ blockId: "editor", revision: 1, status: "feedback", feedback: "Visible editor feedback.", at: "editor-at-secret" });
  trace.internalEvents.push(
    record({ type: "terminal-command-submitted", attemptId: "attempt-command-secret", lessonId, blockId: "terminal", command: "echo command-secret", terminalSessionId: "terminal-session-secret" }),
    record({ type: "terminal-command-finished", attemptId: "attempt-command-secret", evidence: privateFinishedEvidence() }),
    record({ type: "terminal-feedback-recorded", attemptId: "attempt-feedback-secret", text: "private-feedback-secret" }),
    record({ type: "attempt_accepted", lessonId, blockId: "terminal", kind: "terminal", attemptId: "attempt-accepted-secret", summary: "private-summary-secret", path: "/tmp/private-session-path" }),
    record({ type: "future-private-event", text: "future-private-event-secret" })
  );
  trace.artifacts.push({ path: "factory/.tmp/public.txt", content: "Visible artifact can mention terminal lifecycle.\n" });
  return projectAuthoredWorkbookEvalTrace(trace);
}

function judgeResult(): AuthoredWorkbookEvalJudgeResult {
  return {
    criteria: {
      "public-contract": { score: 2, citations: [0, 1], rationale: "The public state and terminal transcript support the criterion." },
      "learner-progress": { score: 2, citations: [2, 3, 4, 5], rationale: "Reflection, editor feedback, progression, and artifact evidence show progress." }
    },
    summary: "The public trace supports both criteria."
  };
}

function serialize(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

async function pathExists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function expectNoPrivate(value: unknown): void {
  const text = serialize(value);
  for (const secret of [
    "frontmatter-secret", "lesson-spec-secret", "private-rubric-secret", "prerequisite-internal-secret",
    "attempt-command-secret", "command-secret", "terminal-session-secret", "attempt-finished-secret", "finished-command-secret",
    "finished-interaction-input-secret", "finished-interaction-output-secret", "finished-transcript-label-secret", "finished-transcript-body-secret",
    "attempt-feedback-secret", "private-feedback-secret",
    "attempt-accepted-secret", "private-summary-secret", "future-private-event-secret",
    "raw-event-id-secret", "terminal-at-secret", "reflection-at-secret", "editor-at-secret", "private gate assertion name secret",
    "private gate assertion detail secret", "/tmp/private-session-path", "/tmp/private-gate-path", "OPENCODE_API_KEY", "sk-secret-token",
    "tutor prompt secret", "terminal feedback private secret", "private steering secret"
  ]) expect(text).not.toContain(secret);
}

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

describe("authored workbook judge prompt and result validation", () => {
  it("rebuilds scenario descriptors and drops frontmatter, specs, rubrics, prerequisite internals, and extras", () => {
    const copied = copyAuthoredWorkbookEvalScenarioPublicDescriptor({
      ...scenario(),
      tutorFrontmatter: "frontmatter-secret",
      lessonSpecs: [{ text: "lesson-spec-secret" }],
      prerequisites: { detail: "prerequisite-internal-secret" },
      criteria: scenario().criteria.map((criterion) => ({ ...criterion, privateRubric: "private-rubric-secret" }))
    });

    expect(copied).toEqual(scenario());
    expectNoPrivate(copied);
    expect(() => copyAuthoredWorkbookEvalScenarioPublicDescriptor({ ...scenario(), criteria: [{ ...scenario().criteria[0]!, id: "Bad_Id" }] })).toThrow(/criterion id/i);
    expect(() => copyAuthoredWorkbookEvalScenarioPublicDescriptor({ ...scenario(), criteria: [scenario().criteria[0]!, scenario().criteria[0]!] })).toThrow(/Duplicate scenario criterion id/);
  });

  it("builds a JSON-only prompt from rebuilt scenario, public trace, prompt citations, and public gate projection", () => {
    const unsafeTrace = {
      ...projectedTrace(),
      internalEvents: [{ type: "terminal-feedback-recorded", attemptId: "top-level-internal-attempt-secret", text: "top-level-internal-secret" }],
      events: [{ type: "terminal-command-submitted", text: "top-level-events-secret" }],
      terminalLifecycle: [{ text: "top-level-lifecycle-secret" }],
      credentials: { OPENCODE_API_KEY: "sk-secret-token" },
      paths: { absolute: "/tmp/private-session-path" },
      tutorPrompt: "tutor prompt secret",
      terminalFeedback: "terminal feedback private secret",
      privateSteering: "private steering secret",
      config: { secret: "config-secret" }
    };

    const prompt = buildAuthoredWorkbookJudgePrompt({
      ...scenario(),
      tutorFrontmatter: "frontmatter-secret",
      criteria: scenario().criteria.map((criterion) => ({ ...criterion, privateRubric: "private-rubric-secret" }))
    } as unknown as AuthoredWorkbookEvalScenarioPublicDescriptor, unsafeTrace, gate());

    expect(prompt).toContain("Return JSON only");
    expect(prompt).toContain("Visible artifact can mention terminal lifecycle");
    expect(prompt).not.toContain("\"value\"");
    expect(prompt).toContain("Trace citation index");
    expect(prompt).toContain("\"public-contract\"");
    expect(prompt).toContain("terminalTranscript");
    expectNoPrivate(prompt);
  });

  it("compacts repeated complete public states below the Judge prompt bound", () => {
    const trace = projectedTrace();
    const bulk = "state-bulk-private-field-should-not-reach-judge ".repeat(2_000);
    trace.publicStates = Array.from({ length: 40 }, (_, index) => ({
      label: `poll-${index}`,
      state: {
        ...publicState(`visible timeline ${index % 2}`),
        chapters: [{ id: "chapter", title: "Chapter", lessonNumber: 1, lesson: { id: lessonId, title: "Lesson", dek: "dek", introduction: bulk, durationMinutes: 1, outcomes: ["outcome"], blocks: [{ id: "block", type: "terminal-practice", title: "Practice", markdown: bulk }] } }],
        timeline: []
      } as PublicWorkbookState
    }));

    expect(Buffer.byteLength(JSON.stringify(trace), "utf8")).toBeGreaterThan(AUTHORED_WORKBOOK_JUDGE_PROMPT_MAX_BYTES);
    const judgeTrace = projectAuthoredWorkbookEvalTraceForJudge(trace);
    const prompt = buildAuthoredWorkbookJudgePrompt(scenario(), trace, gate());

    expect(judgeTrace.publicStates).toHaveLength(1);
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(AUTHORED_WORKBOOK_JUDGE_PROMPT_MAX_BYTES);
    expect(prompt).not.toContain("state-bulk-private-field-should-not-reach-judge");
  });

  it("keeps exact structural public state evidence in the Judge trace", () => {
    const trace = projectedTrace();
    trace.publicStates = [{
      label: "terminal-complete",
      state: {
        ...publicState("timeline prose is represented structurally"),
        progress: {
          ...publicState().progress,
          activeBlockId: "terminal-block",
          completedBlocks: ["terminal-block"],
          workAcceptedBlocks: ["terminal-block"],
          readyBlocks: ["reflection-block"],
          canComplete: { blockId: "terminal-block", eligible: true },
          blocks: [{ id: "terminal-block", type: "terminal-practice", title: "Run the line", ready: true, active: false, completed: true, verified: true, emerged: true, workAccepted: true, checkpoint: { status: "accepted", successMessage: "accepted in public state", evidence: { kind: "terminal", text: "bulky evidence text omitted from state projection" } }, terminal: { phase: "complete", message: "Terminal accepted exactly." }, terminalRevision: 3, terminalSnapshot: { transcript: "snapshot transcript is summarized" } }]
        },
        completion: { complete: true, anchorId: "terminal-block", summary: "summary text summarized" }
      } as PublicWorkbookState
    }];

    const judgeTrace = projectAuthoredWorkbookEvalTraceForJudge(trace);
    expect(judgeTrace.publicStates[0]?.state).toMatchObject({
      active: { lessonId, blockId: "terminal-block" },
      completedBlocks: ["terminal-block"],
      workAcceptedBlocks: ["terminal-block"],
      readyBlocks: ["reflection-block"],
      progressBlocks: [{ id: "terminal-block", completed: true, verified: true, workAccepted: true, terminal: { phase: "complete", message: "Terminal accepted exactly." }, checkpoint: { status: "accepted", successMessage: { bytes: Buffer.byteLength("accepted in public state", "utf8") }, evidence: { kind: "terminal", text: { bytes: Buffer.byteLength("bulky evidence text omitted from state projection", "utf8") } } } }],
      completion: { complete: true, anchorId: "terminal-block", summary: { bytes: Buffer.byteLength("summary text summarized", "utf8") } }
    });
    expect(JSON.stringify(judgeTrace)).not.toContain("snapshot transcript is summarized");
  });

  it("verifies citations against the compacted Judge trace the prompt exposes", () => {
    const trace = projectedTrace();
    trace.publicStates = [
      { label: "first", state: { ...publicState("same structural state"), timeline: [], chapters: [{ id: "chapter", title: "Chapter", lessonNumber: 1, lesson: { id: lessonId, title: "Lesson", dek: "dek", introduction: "first bulk", durationMinutes: 1, outcomes: [], blocks: [] } }] } as PublicWorkbookState },
      { label: "second", state: { ...publicState("same structural state"), timeline: [], chapters: [{ id: "chapter", title: "Chapter", lessonNumber: 1, lesson: { id: lessonId, title: "Lesson", dek: "dek", introduction: "second bulk", durationMinutes: 1, outcomes: [], blocks: [] } }] } as PublicWorkbookState }
    ];
    trace.terminalTranscript = [{ blockId: "terminal", direction: "output", text: "visible output" }];
    trace.reflections = [];
    trace.editors = [];
    trace.progressionEvents = [];
    trace.artifacts = [];

    const prompt = buildAuthoredWorkbookJudgePrompt(scenario(), trace, gate());
    const citations = JSON.parse(prompt.match(/Trace citation index[\s\S]*?\n(\[[\s\S]*?\])\n\nStructural deterministic gate summary/)?.[1] ?? "[]") as Array<{ id: number; kind: string }>;

    expect(citations.map((citation) => [citation.id, citation.kind])).toEqual([[0, "publicState"], [1, "terminalTranscript"]]);
    expect(() => verifyAuthoredWorkbookJudgeResult({ criteria: { "public-contract": { score: 2, citations: [0], rationale: "state" }, "learner-progress": { score: 2, citations: [1], rationale: "terminal" } }, summary: "ok" }, scenario(), trace)).not.toThrow();
    expect(() => verifyAuthoredWorkbookJudgeResult({ criteria: { "public-contract": { score: 2, citations: [2], rationale: "old full-trace citation" }, "learner-progress": { score: 2, citations: [1], rationale: "terminal" } }, summary: "bad" }, scenario(), trace)).toThrow(/unknown trace citation/i);
  });

  it("rejects lesson jump events before Judge-specific projection in every event-bearing form", () => {
    const trace = projectedTrace();
    expect(() => buildAuthoredWorkbookJudgePrompt(scenario(), { ...trace, progressionEvents: [{ type: "lesson_jump_started", lessonId: "jump" } as any] }, gate())).toThrow(/lesson_jump_started/);
    expect(() => buildAuthoredWorkbookJudgePrompt(scenario(), { ...trace, internalEvents: [{ type: "lesson_jump_started", lessonId: "jump" }] } as any, gate())).toThrow(/lesson_jump_started/);
    expect(() => buildAuthoredWorkbookJudgePrompt(scenario(), { ...trace, events: [{ type: "lesson_jump_started", lessonId: "jump" }] } as any, gate())).toThrow(/lesson_jump_started/);
    expect(() => buildAuthoredWorkbookJudgePrompt(scenario(), { ...trace, publicStates: [{ label: "raw", state: { ...publicState(), timeline: [{ type: "lesson_jump_started", id: "raw", sequence: 1, at: "public-at", lessonId, blockId: "block" } as any] } as PublicWorkbookState }] }, gate())).toThrow(/Invalid public state trace entry/);
  });

  it("omits private and bulky browser-public state fields from Judge and report inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "authored-judge-state-private-"));
    tempRoots.push(root);
    const trace = projectedTrace();
    trace.publicStates = [{
      label: "private-bulk",
      state: {
        ...publicState("timeline-private-secret"),
        adapter: { note: "adapter-note-private-secret", modelBackedHelp: true } as any,
        chapters: [{ id: "chapter", title: "Chapter", lessonNumber: 1, lesson: { id: lessonId, title: "Lesson", dek: "dek-private-secret", introduction: "lesson-introduction-private-secret", durationMinutes: 1, outcomes: [], blocks: [{ id: "block", type: "narrative", title: "Narrative", markdown: "block-markdown-private-secret" }] } }]
      } as PublicWorkbookState
    }];
    const prompt = buildAuthoredWorkbookJudgePrompt(scenario(), trace, gate());
    const objects = createAuthoredWorkbookEvalReportBundleObjects({ runId: "private-state", scenario: scenario(), trace, gate: gate(), judgeInput: prompt, judge: judgeResult(), modelIdentities: modelIdentities() });
    const promptTrace = JSON.parse(prompt.match(/Allowlisted Judge-specific structural public workbook trace[\s\S]*?:\n(\{[\s\S]*?\})\n\nTrace citation index/)?.[1] ?? "{}");
    const serialized = JSON.stringify({ prompt, trace: objects.traceEnvelope.trace });

    expect(promptTrace).toEqual(objects.traceEnvelope.trace);
    for (const secret of ["timeline-private-secret", "adapter-note-private-secret", "dek-private-secret", "lesson-introduction-private-secret", "block-markdown-private-secret"]) expect(serialized).not.toContain(secret);
    expect(serialized).toContain("modelBackedHelp");
  });

  it("projects deterministic gates without assertion names or details", () => {
    const publicGate = projectAuthoredWorkbookGateForPublicReport(gate(false));

    expect(publicGate).toEqual({
      passed: false,
      assertionCount: 1,
      failureCount: 1,
      assertions: [{ index: 0, passed: false }],
      detailPolicy: "assertion-details-omitted-from-public-report"
    });
    expectNoPrivate(publicGate);
  });

  it("validates the exact dynamic criterion key set, citations, bounded text, and verdict convention", () => {
    const trace = projectedTrace();
    const verified = verifyAuthoredWorkbookJudgeResult(judgeResult(), scenario(), trace);

    expect(verified).toEqual(judgeResult());
    expect(authoredWorkbookJudgeVerdict(verified)).toEqual({ passed: true, percentage: 1, rule: "all-criteria-positive-and-aggregate-at-least-80-percent" });
    expect(() => verifyAuthoredWorkbookJudgeResult({ criteria: { "public-contract": judgeResult().criteria["public-contract"] }, summary: "missing" }, scenario(), trace)).toThrow(/Invalid judge criteria/);
    expect(() => verifyAuthoredWorkbookJudgeResult({ ...judgeResult(), criteria: { ...judgeResult().criteria, extra: judgeResult().criteria["public-contract"] } }, scenario(), trace)).toThrow(/Invalid judge criteria/);
    expect(() => verifyAuthoredWorkbookJudgeResult({ criteria: { ...judgeResult().criteria, "public-contract": { score: 2, citations: [999], rationale: "bad" } }, summary: "bad" }, scenario(), trace)).toThrow(/unknown trace citation/i);
    expect(() => verifyAuthoredWorkbookJudgeResult({ criteria: { ...judgeResult().criteria, "public-contract": { score: 2, citations: [], rationale: "bad" } }, summary: "bad" }, scenario(), trace)).toThrow(/missing trace citations/i);
    expect(() => verifyAuthoredWorkbookJudgeResult({ ...judgeResult(), raw: "private raw response" }, scenario(), trace)).toThrow(/Invalid judge response/);
    expect(verifyAuthoredWorkbookJudgeResult({ criteria: { ...judgeResult().criteria, "public-contract": { score: 0, citations: [], rationale: "deterministic test has no citation" } }, summary: "ok" }, scenario(), trace, { allowUncitedCriteria: "deterministic-test" }).criteria["public-contract"]?.citations).toEqual([]);
  });

  it("does not call the judge API when the deterministic gate fails", async () => {
    let calls = 0;
    await expect(judgeAuthoredWorkbookTrace({
      scenario: scenario(),
      trace: projectedTrace(),
      gate: gate(false),
      invokeFromPrompt: async () => { calls += 1; throw new Error("should not run"); }
    })).rejects.toThrow("Deterministic gate failed before judge invocation.");
    expect(calls).toBe(0);
  });
});

describe("authored workbook judge command", () => {
  it("uses configured command and model with a minimal child environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "authored-judge-env-"));
    tempRoots.push(root);
    const command = join(root, "env.js");
    await writeFile(command, `#!/usr/bin/env node\nlet stdin="";process.stdin.on("data",c=>stdin+=c);process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({argv:process.argv.slice(2),stdin,env:Object.keys(process.env).sort(),hasSecret:Object.prototype.hasOwnProperty.call(process.env,"OPENCODE_API_KEY"),proxy:Object.keys(process.env).filter(k=>/proxy/i.test(k))}))});\n`, { mode: 0o700 });

    const result = await invokeAuthoredWorkbookJudgeCommand({
      prompt: "prompt body",
      environment: { EVAL_JUDGE_COMMAND: command, EVAL_JUDGE_MODEL: "provider/model", PATH: process.env.PATH, HOME: root, OPENCODE_API_KEY: "sk-secret-token", HTTPS_PROXY: "http://proxy-secret" }
    }) as { argv: string[]; stdin: string; env: string[]; hasSecret: boolean; proxy: string[] };

    expect(result.argv).toEqual(["--model", "provider/model", "-p"]);
    expect(result.stdin).toBe("prompt body");
    expect(result.env.filter((key) => key !== "__CF_USER_TEXT_ENCODING")).toEqual(["HOME", "NO_COLOR", "PATH"]);
    expect(result.hasSecret).toBe(false);
    expect(result.proxy).toEqual([]);
  });

  it("rejects oversized prompts before spawning", async () => {
    const root = await mkdtemp(join(tmpdir(), "authored-judge-oversized-prompt-"));
    tempRoots.push(root);
    const command = join(root, "should-not-run.sh");
    await writeFile(command, "#!/bin/sh\necho spawned > \"$HOME/ran\"\n", { mode: 0o700 });

    await expect(invokeAuthoredWorkbookJudgeCommand({
      prompt: "x".repeat(AUTHORED_WORKBOOK_JUDGE_PROMPT_MAX_BYTES + 1),
      environment: { EVAL_JUDGE_COMMAND: command, EVAL_JUDGE_MODEL: "provider/model", PATH: process.env.PATH, HOME: root }
    })).rejects.toThrow("Judge prompt exceeded the bounded input size limit.");
    await expect(pathExists(join(root, "ran"))).resolves.toBe(false);
  });

  it("sanitizes malformed JSON, stderr, early exits, noisy output, and timeouts", async () => {
    const root = await mkdtemp(join(tmpdir(), "authored-judge-failures-"));
    tempRoots.push(root);
    const malformed = join(root, "malformed.sh");
    const early = join(root, "early.sh");
    const noisy = join(root, "noisy.js");
    const hang = join(root, "hang.sh");
    await writeFile(malformed, "#!/bin/sh\necho 'raw malformed secret {not-json'\necho 'stderr-secret /tmp/private-path' >&2\n", { mode: 0o700 });
    await writeFile(early, "#!/bin/sh\necho 'stderr-secret /tmp/private-path' >&2\nexit 7\n", { mode: 0o700 });
    await writeFile(noisy, `#!/usr/bin/env node\nprocess.stdout.write("A".repeat(${AUTHORED_WORKBOOK_JUDGE_STDOUT_MAX_BYTES + 1}));setTimeout(()=>{}, 10000);\n`, { mode: 0o700 });
    await writeFile(hang, "#!/bin/sh\nsleep 10\n", { mode: 0o700 });
    const env = { EVAL_JUDGE_MODEL: "provider/model", PATH: process.env.PATH, HOME: root };

    await expect(invokeAuthoredWorkbookJudgeCommand({ prompt: "x", environment: { ...env, EVAL_JUDGE_COMMAND: malformed } })).rejects.toThrow("Judge command returned invalid bounded JSON.");
    await expect(invokeAuthoredWorkbookJudgeCommand({ prompt: "x".repeat(Math.floor(AUTHORED_WORKBOOK_JUDGE_PROMPT_MAX_BYTES / 2)), environment: { ...env, EVAL_JUDGE_COMMAND: early } })).rejects.toThrow("Judge command failed before returning a bounded JSON result.");
    await expect(invokeAuthoredWorkbookJudgeCommand({ prompt: "x", environment: { ...env, EVAL_JUDGE_COMMAND: noisy }, timeoutMs: 5_000 })).rejects.toThrow("Judge command exceeded the bounded output size limit.");
    await expect(invokeAuthoredWorkbookJudgeCommand({ prompt: "x", environment: { ...env, EVAL_JUDGE_COMMAND: hang }, timeoutMs: 10 })).rejects.toThrow("Judge command timed out before returning a bounded JSON result.");

    for (const promise of [
      invokeAuthoredWorkbookJudgeCommand({ prompt: "x", environment: { ...env, EVAL_JUDGE_COMMAND: malformed } }).catch((error) => error),
      invokeAuthoredWorkbookJudgeCommand({ prompt: "x", environment: { ...env, EVAL_JUDGE_COMMAND: early } }).catch((error) => error)
    ]) {
      const error = await promise as Error;
      expect(String(error.message)).not.toContain("stderr-secret");
      expect(String(error.message)).not.toContain("raw malformed secret");
      expect(String(error.message)).not.toContain(root);
      expect(String(error.message)).not.toContain("provider/model");
    }
  });

  it("cancels Judge command invocation by closing stdin and killing the child promptly", async () => {
    const kills: string[] = [];
    let stdinClosed = false;
    class FakeChild extends EventEmitter {
      stdout = new PassThrough();
      stderr = new PassThrough();
      stdin = new PassThrough();
      pid = 0;
      constructor() {
        super();
        const originalEnd = this.stdin.end.bind(this.stdin) as typeof this.stdin.end;
        this.stdin.end = ((...args: any[]) => { stdinClosed = true; return originalEnd(...args as [any]); }) as typeof this.stdin.end;
      }
      kill(signal?: NodeJS.Signals): boolean {
        kills.push(signal ?? "SIGTERM");
        this.emit("close", null, signal);
        return true;
      }
    }
    const child = new FakeChild();
    const controller = new AbortController();
    const pending = invokeAuthoredWorkbookJudgeCommand({
      prompt: "prompt",
      environment: { EVAL_JUDGE_COMMAND: "judge", EVAL_JUDGE_MODEL: "provider/model", PATH: process.env.PATH, HOME: "/tmp" },
      signal: controller.signal,
      timeoutMs: 5_000,
      spawnProcess: (() => child) as any
    });

    controller.abort();
    await expect(pending).rejects.toThrow("Judge command cancelled before returning a bounded JSON result.");
    expect(stdinClosed).toBe(true);
    expect(kills).toContain("SIGTERM");
    expect(child.listenerCount("close")).toBe(0);
    expect(controller.signal).toBeDefined();
  });
});

describe("authored workbook report bundle", () => {
  it("re-verifies prompt and judge, writes exact curated files, and keeps diagnostics separate", async () => {
    const root = await mkdtemp(join(tmpdir(), "authored-report-bundle-"));
    tempRoots.push(root);
    const runId = "run-001";
    const trace = projectedTrace();
    const prompt = buildAuthoredWorkbookJudgePrompt(scenario(), trace, gate());
    const result = await writeAuthoredWorkbookEvalReportBundle({
      reportsRoot: root,
      runId,
      scenario: { ...scenario(), tutorFrontmatter: "frontmatter-secret" } as unknown as AuthoredWorkbookEvalScenarioPublicDescriptor,
      trace: { ...trace, credentials: { token: "sk-secret-token" } } as typeof trace,
      gate: gate(),
      judgeInput: prompt,
      judge: judgeResult(),
      modelIdentities: { ...modelIdentities(), command: "private command secret" } as unknown as AuthoredWorkbookEvalModelIdentities
    });

    expect(result.files).toEqual(AUTHORED_WORKBOOK_REPORT_FILENAMES);
    const names = await Promise.all(Object.values(AUTHORED_WORKBOOK_REPORT_FILENAMES).map(async (file) => [file, await pathExists(join(result.directory, file))] as const));
    expect(Object.fromEntries(names)).toEqual(Object.fromEntries(Object.values(AUTHORED_WORKBOOK_REPORT_FILENAMES).map((file) => [file, true])));

    const traceEnvelope = await readJson<Record<string, unknown>>(join(result.directory, "trace.json"));
    const judgeEnvelope = await readJson<Record<string, unknown>>(join(result.directory, "judge.json"));
    const report = await readJson<Record<string, unknown>>(join(result.directory, "report.json"));
    const metadata = await readJson<Record<string, unknown>>(join(result.directory, "metadata.json"));
    const summary = await readFile(join(result.directory, "summary.md"), "utf8");
    const judgeInputEnvelope = await readJson<Record<string, unknown>>(join(result.directory, "judge-input.json"));

    for (const envelope of [traceEnvelope, judgeInputEnvelope, judgeEnvelope, report, metadata]) expect(envelope).toMatchObject(AUTHORED_WORKBOOK_EVAL_MARKERS);
    expect(report).toMatchObject({ runId, files: { trace: "trace.json", judgeInput: "judge-input.json", judge: "judge.json" } });
    expect(report).not.toHaveProperty("trace");
    expect(report).not.toHaveProperty("judgeInput");
    expect(report).not.toHaveProperty("judge");
    expect(metadata).toMatchObject({ files: AUTHORED_WORKBOOK_REPORT_FILENAMES, status: "completed", outcome: "passed", modelIdentities: modelIdentities() });
    expect(judgeInputEnvelope).toMatchObject({ prompt, traceFile: "trace.json" });
    expect(summary).toContain("Judge verdict: **100%** (pass)");
    expectNoPrivate({ traceEnvelope, judgeInputEnvelope, judgeEnvelope, report, metadata, summary });

    await expect(pathExists(join(result.directory, AUTHORED_WORKBOOK_LOCAL_DIAGNOSTIC_FILENAMES.gate))).resolves.toBe(false);
    const diagnosticStatus = await writeAuthoredWorkbookEvalGateDiagnostic(result.directory, gate(false));
    expect(diagnosticStatus).toBe("written");
    const diagnostic = await readFile(join(result.directory, AUTHORED_WORKBOOK_LOCAL_DIAGNOSTIC_FILENAMES.gate), "utf8");
    expect(diagnostic).toContain("private gate assertion detail secret");
    expect(JSON.stringify(await readJson<Record<string, unknown>>(join(result.directory, "metadata.json")))).not.toContain(AUTHORED_WORKBOOK_LOCAL_DIAGNOSTIC_FILENAMES.gate);

    await expect(writeAuthoredWorkbookEvalReportBundle({
      reportsRoot: root,
      runId,
      scenario: scenario(),
      trace,
      gate: gate(),
      judgeInput: prompt,
      judge: judgeResult(),
      modelIdentities: modelIdentities()
    })).rejects.toThrow(/already exists/i);
  });

  it("rejects mismatched injected prompts, invalid judge results, failed gates, bad run ids, and unsafe model identities", () => {
    const trace = projectedTrace();
    const prompt = buildAuthoredWorkbookJudgePrompt(scenario(), trace, gate());
    const base = { runId: "run-002", scenario: scenario(), trace, gate: gate(), judgeInput: prompt, judge: judgeResult(), modelIdentities: modelIdentities() };

    expect(() => createAuthoredWorkbookEvalReportBundleObjects({ ...base, judgeInput: "raw prompt secret attempt-command-secret" })).toThrow("Judge input does not match the sanitized authored workbook judge prompt.");
    expect(() => createAuthoredWorkbookEvalReportBundleObjects({ ...base, judge: { criteria: { ...judgeResult().criteria, "public-contract": { score: 2, citations: [999], rationale: "bad" } }, summary: "bad" } })).toThrow(/unknown trace citation/i);
    expect(() => createAuthoredWorkbookEvalReportBundleObjects({ ...base, gate: gate(false) })).toThrow(/deterministic gate failed/i);
    expect(() => createAuthoredWorkbookEvalReportBundleObjects({ ...base, runId: "../private" })).toThrow(/run id/i);
    expect(() => createAuthoredWorkbookEvalReportBundleObjects({ ...base, modelIdentities: { ...modelIdentities(), Judge: { requested: "google/gemini", selected: "google/gemini\nOPENCODE_API_KEY=sk-secret-token" } } })).toThrow(/model identity/i);
  });

  it("rolls back every partially written success bundle so failure metadata can reuse the run id", async () => {
    const root = await mkdtemp(join(tmpdir(), "authored-report-rollback-"));
    tempRoots.push(root);
    const trace = projectedTrace();
    const prompt = buildAuthoredWorkbookJudgePrompt(scenario(), trace, gate());

    for (let failAfter = 1; failAfter <= Object.keys(AUTHORED_WORKBOOK_REPORT_FILENAMES).length; failAfter += 1) {
      const runId = `rollback-${failAfter}`;
      let writes = 0;
      await expect(writeAuthoredWorkbookEvalReportBundle({
        reportsRoot: root,
        runId,
        scenario: scenario(),
        trace,
        gate: gate(),
        judgeInput: prompt,
        judge: judgeResult(),
        modelIdentities: modelIdentities(),
        writeText: async (path, data) => {
          writes += 1;
          await writeFile(path, data, { mode: 0o600 });
          if (writes === failAfter) throw new Error("simulated partial write");
        }
      })).rejects.toThrow("simulated partial write");
      await expect(pathExists(join(root, runId))).resolves.toBe(false);
      await expect(writeAuthoredWorkbookEvalFailureMetadata({ reportsRoot: root, runId, scenarioId: scenario().id, status: "report", modelIdentities: modelIdentities() })).resolves.toMatchObject({ files: { metadata: "metadata.json" } });
    }
  });

  it("sanitizes native filesystem errors from public report APIs", async () => {
    const root = await mkdtemp(join(tmpdir(), "authored-report-fs-error-"));
    tempRoots.push(root);
    const native = Object.assign(new Error(`EIO native path leak ${root}`), { code: "EIO", path: join(root, "private-path"), syscall: "write" });
    await expect(atomicWriteText(join(root, "missing", "file.json"), "{}\n")).rejects.toThrow("Unable to write authored workbook report file.");
    await expect(writeAuthoredWorkbookEvalFailureMetadata({
      reportsRoot: root,
      runId: "native-error",
      scenarioId: scenario().id,
      status: "setup",
      modelIdentities: modelIdentities(),
      writeText: async () => { throw native; }
    })).rejects.toThrow("Unable to write authored workbook report artifacts.");
    let error: Error | undefined;
    try {
      await writeAuthoredWorkbookEvalFailureMetadata({
        reportsRoot: root,
        runId: "native-error-2",
        scenarioId: scenario().id,
        status: "setup",
        modelIdentities: modelIdentities(),
        writeText: async () => { throw native; }
      });
    } catch (caught) {
      error = caught as Error;
    }
    expect(error?.message).not.toContain(root);
    expect(error?.message).not.toContain("EIO");
    expect(error?.message).not.toContain("private-path");
  });

  it("creates sanitized failure metadata without advertising local diagnostics or judge artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "authored-report-failure-"));
    tempRoots.push(root);
    const written = await writeAuthoredWorkbookEvalFailureMetadata({
      reportsRoot: root,
      runId: "gate-failure-001",
      scenarioId: scenario().id,
      status: "gate",
      modelIdentities: modelIdentities()
    });
    const metadata = await readJson<Record<string, unknown>>(join(written.directory, "metadata.json"));
    const metadataObject = createAuthoredWorkbookEvalFailureMetadataEnvelope({
      runId: "gate-failure-002",
      scenarioId: scenario().id,
      status: "cleanup",
      modelIdentities: modelIdentities(),
      publicMessage: "caller-controlled prose ignored",
      lifecycle: { completed: "yes", interrupted: "yes" },
      verdict: { passed: true, percentage: 1, rule: "all-criteria-positive-and-aggregate-at-least-80-percent" },
      files: AUTHORED_WORKBOOK_REPORT_FILENAMES
    } as unknown as Parameters<typeof createAuthoredWorkbookEvalFailureMetadataEnvelope>[0]);

    expect(metadata).toMatchObject({ ...AUTHORED_WORKBOOK_EVAL_MARKERS, status: "gate", outcome: "failed", files: { metadata: "metadata.json" } });
    expect(JSON.stringify(metadata)).not.toContain("gate.json");
    expect(JSON.stringify(metadata)).not.toContain("failure.txt");
    expect(JSON.stringify(metadata)).not.toContain("/tmp/private-gate-path");

    expect(metadataObject).toMatchObject({ ...AUTHORED_WORKBOOK_EVAL_MARKERS, status: "cleanup", verdict: { passed: false, percentage: 0, rule: "not-judged" }, lifecycle: { completed: "no", interrupted: "no", cleanup: "failed" }, files: { metadata: "metadata.json" } });
    await expect(pathExists(join(written.directory, "judge-input.json"))).resolves.toBe(false);
    await expect(pathExists(join(written.directory, "judge.json"))).resolves.toBe(false);
    await expect(pathExists(join(written.directory, "report.json"))).resolves.toBe(false);
    await expect(pathExists(join(written.directory, "summary.md"))).resolves.toBe(false);

    const directory = written.directory;
    await expect(writeAuthoredWorkbookEvalGateDiagnostic(directory, gate(false))).resolves.toBe("written");
    await expect(writeAuthoredWorkbookEvalFailureDiagnostic(directory, authoredWorkbookEvalLocalDiagnosticText("raw stack /tmp/private-path OPENCODE_API_KEY=sk-secret-token"))).resolves.toBe("written");
    expect(await readFile(join(directory, "gate.json"), "utf8")).toContain("/tmp/private-gate-path");
  });

  it("creates atomic marked latest envelopes from attempted runs only and preserves prior latest on failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "authored-latest-"));
    tempRoots.push(root);
    const trace = projectedTrace();
    const prompt = buildAuthoredWorkbookJudgePrompt(scenario(), trace, gate());
    await writeAuthoredWorkbookEvalReportBundle({
      reportsRoot: root,
      runId: "run-001",
      scenario: scenario(),
      trace,
      gate: gate(),
      judgeInput: prompt,
      judge: judgeResult(),
      modelIdentities: modelIdentities()
    });
    await writeAuthoredWorkbookEvalFailureMetadata({
      reportsRoot: root,
      runId: "run-002",
      scenarioId: scenario().id,
      repetition: 2,
      status: "interrupted",
      modelIdentities: modelIdentities()
    });
    const success = createAuthoredWorkbookEvalLatestRunEntry({
      scenario: scenario().id,
      repetition: 1,
      status: "completed",
      verdict: { passed: true, percentage: 1, rule: "all-criteria-positive-and-aggregate-at-least-80-percent" },
      reportDirectory: "run-001",
      files: AUTHORED_WORKBOOK_REPORT_FILENAMES
    });
    const interrupted = createAuthoredWorkbookEvalLatestRunEntry({
      scenario: scenario().id,
      repetition: 2,
      status: "interrupted",
      verdict: { passed: false, percentage: 0, rule: "not-judged" },
      reportDirectory: "run-002",
      files: { metadata: "metadata.json" }
    });
    const latest = createAuthoredWorkbookEvalLatestEnvelope({ generatedAt: "2026-08-29T00:00:00.000Z", invocation: { scope: "scenario", scenarioIds: [scenario().id], repeat: 2 }, runs: [success, interrupted] });

    expect(Object.isFrozen(latest.runs[0]!.files)).toBe(true);
    expect(latest).toMatchObject({ ...AUTHORED_WORKBOOK_EVAL_MARKERS, invocation: { repeat: 2 } });
    expect(latest.runs[0]).toMatchObject({ ...AUTHORED_WORKBOOK_EVAL_MARKERS, scenario: scenario().id, files: AUTHORED_WORKBOOK_REPORT_FILENAMES });
    expect(JSON.stringify(latest)).not.toContain("gate.json");
    expect(JSON.stringify(latest)).not.toContain("/tmp/");
    await writeAuthoredWorkbookEvalLatestEnvelope(root, latest);
    const prior = await readFile(join(root, "latest.json"), "utf8");
    await expect(writeAuthoredWorkbookEvalLatestEnvelope(root, latest, async () => { throw new Error("boom"); })).rejects.toThrow("Unable to update authored workbook latest report.");
    await expect(readFile(join(root, "latest.json"), "utf8")).resolves.toBe(prior);

    const alias = join(root, "latest-alias.json");
    await expect(writeAuthoredWorkbookEvalLatestEnvelope(root, latest, async (path, data) => {
      await writeFile(path, data);
      await link(path, alias);
    })).rejects.toThrow("Unable to update authored workbook latest report.");
    await expect(readFile(join(root, "latest.json"), "utf8")).resolves.toBe(prior);
    expect(JSON.stringify(await readJson<Record<string, unknown>>(join(root, "latest.json")))).not.toContain("latest-alias");

    const missing = createAuthoredWorkbookEvalLatestEnvelope({ invocation: { scope: "scenario", scenarioIds: [scenario().id], repeat: 1 }, runs: [createAuthoredWorkbookEvalLatestRunEntry({ ...success, reportDirectory: "missing-run" })] });
    await expect(writeAuthoredWorkbookEvalLatestEnvelope(root, missing)).rejects.toThrow("Unable to update authored workbook latest report.");
    await expect(readFile(join(root, "latest.json"), "utf8")).resolves.toBe(prior);

    expect(() => createAuthoredWorkbookEvalLatestEnvelope({ invocation: { scope: "scenario", scenarioIds: [scenario().id], repeat: 2 }, runs: [success, success] })).toThrow(/duplicate/i);
    expect(() => createAuthoredWorkbookEvalLatestEnvelope({ invocation: { scope: "scenario", scenarioIds: [scenario().id], repeat: 1 }, runs: [createAuthoredWorkbookEvalLatestRunEntry({ ...success, reportDirectory: "/tmp/private" })] })).toThrow(/directory/i);
    expect(() => createAuthoredWorkbookEvalLatestRunEntry({ ...success, status: "gate", verdict: { passed: false, percentage: 0, rule: "not-judged" }, files: AUTHORED_WORKBOOK_REPORT_FILENAMES })).toThrow(/curated files/i);
    expect(() => createAuthoredWorkbookEvalLatestEnvelope({ invocation: { scope: "release", scenarioIds: [scenario().id], repeat: 2 }, runs: [] })).toThrow(/release/i);
  });

  it("rejects adversarial latest metadata identity changes without replacing prior latest", async () => {
    const root = await mkdtemp(join(tmpdir(), "authored-latest-adversarial-"));
    tempRoots.push(root);
    const trace = projectedTrace();
    const prompt = buildAuthoredWorkbookJudgePrompt(scenario(), trace, gate());
    await writeAuthoredWorkbookEvalReportBundle({
      reportsRoot: root,
      runId: "run-001",
      scenario: scenario(),
      trace,
      gate: gate(),
      judgeInput: prompt,
      judge: judgeResult(),
      modelIdentities: modelIdentities()
    });
    const success = createAuthoredWorkbookEvalLatestRunEntry({
      scenario: scenario().id,
      repetition: 1,
      status: "completed",
      verdict: { passed: true, percentage: 1, rule: "all-criteria-positive-and-aggregate-at-least-80-percent" },
      reportDirectory: "run-001",
      files: AUTHORED_WORKBOOK_REPORT_FILENAMES
    });
    const latest = createAuthoredWorkbookEvalLatestEnvelope({ generatedAt: "2026-08-29T00:00:00.000Z", invocation: { scope: "scenario", scenarioIds: [scenario().id], repeat: 1 }, runs: [success] });
    await writeAuthoredWorkbookEvalLatestEnvelope(root, latest);
    const prior = await readFile(join(root, "latest.json"), "utf8");
    const metadataPath = join(root, "run-001", "metadata.json");
    const originalMetadataText = await readFile(metadataPath, "utf8");
    const originalMetadata = JSON.parse(originalMetadataText) as Record<string, unknown>;
    const writeMetadata = async (value: unknown): Promise<void> => {
      await atomicWriteText(metadataPath, `${JSON.stringify(value, null, 2)}\n`);
    };
    const expectLatestRejectedAndUnchanged = async (mutate: () => Promise<(() => Promise<void>) | void>, candidate = latest): Promise<void> => {
      const cleanup = await mutate();
      try {
        let rejected: unknown;
        try {
          await writeAuthoredWorkbookEvalLatestEnvelope(root, candidate);
        } catch (error) {
          rejected = error;
        }
        expect(rejected).toBeInstanceOf(Error);
        expect((rejected as Error).message).toBe("Unable to update authored workbook latest report.");
        expect(String(rejected)).not.toContain("private-secret");
        expect(String(rejected)).not.toContain("OPENCODE_API_KEY");
        await expect(readFile(join(root, "latest.json"), "utf8")).resolves.toBe(prior);
      } finally {
        await cleanup?.();
        await writeMetadata(originalMetadata);
      }
    };

    await expectLatestRejectedAndUnchanged(async () => writeMetadata({ ...originalMetadata, scenario: "other-public-scenario" }));
    await expectLatestRejectedAndUnchanged(async () => writeMetadata({ ...originalMetadata, repetition: 2 }));
    await expectLatestRejectedAndUnchanged(async () => writeMetadata(createAuthoredWorkbookEvalFailureMetadataEnvelope({ runId: "run-001", scenarioId: scenario().id, status: "gate", modelIdentities: modelIdentities() })));
    await expectLatestRejectedAndUnchanged(async () => writeMetadata({ ...originalMetadata, outcome: "failed", verdict: { passed: false, percentage: 0.8, rule: "all-criteria-positive-and-aggregate-at-least-80-percent" } }));
    await expectLatestRejectedAndUnchanged(async () => writeMetadata({ ...originalMetadata, verdict: { passed: false, percentage: 1, rule: "all-criteria-positive-and-aggregate-at-least-80-percent" } }));
    await expectLatestRejectedAndUnchanged(async () => writeMetadata({ ...originalMetadata, namespace: "tutorial-engine/evals/v2" }));
    await expectLatestRejectedAndUnchanged(async () => writeMetadata({ ...originalMetadata, privateStack: "/tmp/private-secret OPENCODE_API_KEY=sk-secret" }));
    await expectLatestRejectedAndUnchanged(async () => {
      await atomicWriteText(metadataPath, "{not json\n");
    });
    await expectLatestRejectedAndUnchanged(async () => {
      await writeFile(metadataPath, "x".repeat(4 * 1024 * 1024 + 1));
      await chmod(metadataPath, 0o600);
    });
    const differingButValidLatest = createAuthoredWorkbookEvalLatestEnvelope({
      generatedAt: "2026-08-29T00:00:00.000Z",
      invocation: { scope: "scenario", scenarioIds: [scenario().id], repeat: 1 },
      runs: [createAuthoredWorkbookEvalLatestRunEntry({ ...success, verdict: { passed: false, percentage: 0.8, rule: "all-criteria-positive-and-aggregate-at-least-80-percent" } })]
    });
    await expectLatestRejectedAndUnchanged(async () => undefined, differingButValidLatest);

    const alias = join(root, "metadata-hardlink-alias.json");
    await expectLatestRejectedAndUnchanged(async () => {
      await link(metadataPath, alias);
      return async () => { await rm(alias, { force: true }); };
    });

    await expect(writeAuthoredWorkbookEvalLatestEnvelope(root, latest, async (path, data) => {
      await atomicWriteText(path, data);
      await writeMetadata({ ...originalMetadata, outcome: "failed", verdict: { passed: false, percentage: 0.8, rule: "all-criteria-positive-and-aggregate-at-least-80-percent" } });
    })).rejects.toThrow("Unable to update authored workbook latest report.");
    await expect(readFile(join(root, "latest.json"), "utf8")).resolves.toBe(prior);
    await writeMetadata(originalMetadata);

    expect(() => createAuthoredWorkbookEvalLatestRunEntry({ ...success, verdict: { passed: false, percentage: 1, rule: "all-criteria-positive-and-aggregate-at-least-80-percent" } })).toThrow(/verdict/i);
    expect(() => createAuthoredWorkbookEvalLatestEnvelope({
      invocation: { scope: "scenario", scenarioIds: [scenario().id, "other-public-scenario"], repeat: 1 },
      runs: [
        success,
        createAuthoredWorkbookEvalLatestRunEntry({ ...success, scenario: "other-public-scenario", reportDirectory: "run-001" })
      ]
    })).toThrow(/duplicate report/i);
    expect(await readFile(join(root, "latest.json"), "utf8")).toBe(prior);
  });

  it("aggregates stability with one pass, two pass, and two-of-three pass rules", () => {
    expect(authoredWorkbookEvalStabilityPassed([{ passed: true }])).toBe(true);
    expect(authoredWorkbookEvalStabilityPassed([{ passed: false }])).toBe(false);
    expect(authoredWorkbookEvalStabilityPassed([{ passed: true }, { passed: true }])).toBe(true);
    expect(authoredWorkbookEvalStabilityPassed([{ passed: true }, { passed: false }])).toBe(false);
    expect(authoredWorkbookEvalStabilityPassed([{ passed: true }, { passed: false }, { passed: true }])).toBe(true);
    expect(authoredWorkbookEvalStabilityPassed([{ passed: true }, { passed: false }, { passed: false }])).toBe(false);
    expect(authoredWorkbookEvalStatusAfterCleanup({ status: "completed", verdict: { passed: true, percentage: 1, rule: "all-criteria-positive-and-aggregate-at-least-80-percent" }, cleanupFailed: true })).toMatchObject({ status: "cleanup", verdict: { passed: false, percentage: 0, rule: "not-judged" } });
    expect(authoredWorkbookEvalStatusAfterCleanup({ status: "completed", verdict: { passed: false, percentage: 0.5, rule: "all-criteria-positive-and-aggregate-at-least-80-percent" }, cleanupFailed: true })).toMatchObject({ status: "cleanup", verdict: { passed: false, percentage: 0, rule: "not-judged" } });
    expect(authoredWorkbookEvalStatusAfterCleanup({ status: "gate", verdict: { passed: false, percentage: 0, rule: "not-judged" }, cleanupFailed: true })).toMatchObject({ status: "gate", verdict: { passed: false, percentage: 0, rule: "not-judged" } });
  });
});
