import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PublicWorkbookState } from "../../../tutorial-engine/src/workbook/public-contract.js";
import type { WorkbookTimelineRecord } from "../../../tutorial-engine/src/workbook/timeline.js";
import { createEmptyAuthoredWorkbookEvalSessionTrace, projectAuthoredWorkbookEvalTrace } from "../public-trace.js";
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
  createAuthoredWorkbookEvalReportBundleObjects,
  writeAuthoredWorkbookEvalGateDiagnostic,
  writeAuthoredWorkbookEvalReportBundle,
  type AuthoredWorkbookEvalModelIdentities
} from "../reports.js";
import { AUTHORED_WORKBOOK_EVAL_MARKERS } from "../types.js";

const tempRoots: string[] = [];
const lessonId = "001-public-contract";

function record(event: Record<string, unknown>): WorkbookTimelineRecord {
  return { id: "raw-event-id-secret", sequence: 99, at: "2026-08-29T00:00:00.000Z", ...event } as WorkbookTimelineRecord;
}

function publicState(note = "Visible public Tutor prose can mention Coach handoff, terminal-command-submitted, and JSON-looking \"tutor\":."): PublicWorkbookState {
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
    mainTutor: { requested: "anthropic/claude", selected: "anthropic/claude-4" },
    practiceCoach: { requested: "openai/gpt", selected: "openai/gpt-5" },
    judge: { requested: "google/gemini", selected: "google/gemini-2.5" }
  };
}

function projectedTrace() {
  const trace = createEmptyAuthoredWorkbookEvalSessionTrace("post-lesson-001");
  trace.publicStates.push({ label: "visible", state: publicState() });
  trace.terminalTranscript.push({ blockId: "terminal", direction: "input", text: "npm test\r", at: "terminal-at-secret" });
  trace.reflections.push({ blockId: "reflection", role: "tutor", text: "Visible tutor reply.", at: "reflection-at-secret" });
  trace.editors.push({ blockId: "editor", revision: 1, status: "feedback", feedback: "Visible editor feedback.", at: "editor-at-secret" });
  trace.internalEvents.push(
    record({ type: "terminal-command-submitted", attemptId: "attempt-command-secret", command: "echo command-secret", terminalSessionId: "terminal-session-secret" }),
    record({ type: "terminal-coach-handoff-recorded", attemptId: "attempt-handoff-secret", text: "private-handoff-secret" }),
    record({ type: "attempt_accepted", lessonId, blockId: "terminal", kind: "terminal", attemptId: "attempt-accepted-secret", evidenceRef: "evidence-secret", summary: "private-summary-secret", path: "/tmp/private-session-path" }),
    record({ type: "future-private-event", text: "future-private-event-secret" })
  );
  trace.artifacts.push({ path: "factory/.tmp/public.txt", content: "Visible artifact can mention Coach handoff.\n" });
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
    "attempt-command-secret", "command-secret", "terminal-session-secret", "attempt-handoff-secret", "private-handoff-secret",
    "attempt-accepted-secret", "evidence-secret", "private-summary-secret", "future-private-event-secret",
    "raw-event-id-secret", "terminal-at-secret", "reflection-at-secret", "editor-at-secret", "private gate assertion name secret",
    "private gate assertion detail secret", "/tmp/private-session-path", "/tmp/private-gate-path", "OPENCODE_API_KEY", "sk-secret-token",
    "tutor prompt secret", "coach response secret", "private steering secret"
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
      internalEvents: [{ type: "terminal-coach-handoff-recorded", text: "top-level-internal-secret" }],
      events: [{ type: "terminal-command-submitted", text: "top-level-events-secret" }],
      handoffs: [{ text: "top-level-handoff-secret" }],
      credentials: { OPENCODE_API_KEY: "sk-secret-token" },
      paths: { absolute: "/tmp/private-session-path" },
      tutorPrompt: "tutor prompt secret",
      coachResponse: "coach response secret",
      privateSteering: "private steering secret",
      config: { secret: "config-secret" }
    };

    const prompt = buildAuthoredWorkbookJudgePrompt({
      ...scenario(),
      tutorFrontmatter: "frontmatter-secret",
      criteria: scenario().criteria.map((criterion) => ({ ...criterion, privateRubric: "private-rubric-secret" }))
    } as unknown as AuthoredWorkbookEvalScenarioPublicDescriptor, unsafeTrace, gate());

    expect(prompt).toContain("Return JSON only");
    expect(prompt).toContain("Visible artifact can mention Coach handoff");
    expect(prompt).toContain("\"value\"");
    expect(prompt).toContain("\"public-contract\"");
    expect(prompt).toContain("JSON-looking \\\"tutor\\\":");
    expectNoPrivate(prompt);
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
    const judgeInput = await readFile(join(result.directory, "judge-input.txt"), "utf8");

    for (const envelope of [traceEnvelope, judgeEnvelope, report, metadata]) expect(envelope).toMatchObject(AUTHORED_WORKBOOK_EVAL_MARKERS);
    expect(report).toMatchObject({ runId, files: { trace: "trace.json", judgeInput: "judge-input.txt", judge: "judge.json" } });
    expect(report).not.toHaveProperty("trace");
    expect(report).not.toHaveProperty("judgeInput");
    expect(report).not.toHaveProperty("judge");
    expect(metadata).toMatchObject({ files: AUTHORED_WORKBOOK_REPORT_FILENAMES, diagnosticStatus: { gate: "not-written", failure: "not-written", cleanupFailure: "not-written" } });
    expect(judgeInput).toBe(prompt);
    expect(summary).toContain("Judge verdict: **100%** (pass)");
    expectNoPrivate({ traceEnvelope, judgeEnvelope, report, metadata, summary, judgeInput });

    await expect(pathExists(join(result.directory, AUTHORED_WORKBOOK_LOCAL_DIAGNOSTIC_FILENAMES.gate))).resolves.toBe(false);
    const diagnosticStatus = await writeAuthoredWorkbookEvalGateDiagnostic(result.directory, gate(false));
    expect(diagnosticStatus).toBe("written");
    const diagnostic = await readFile(join(result.directory, AUTHORED_WORKBOOK_LOCAL_DIAGNOSTIC_FILENAMES.gate), "utf8");
    expect(diagnostic).toContain("private gate assertion detail secret");
    expect(JSON.stringify(await readJson<Record<string, unknown>>(join(result.directory, "metadata.json")))).not.toContain(AUTHORED_WORKBOOK_LOCAL_DIAGNOSTIC_FILENAMES.gate);
  });

  it("rejects mismatched injected prompts, invalid judge results, failed gates, bad run ids, and unsafe model identities", () => {
    const trace = projectedTrace();
    const prompt = buildAuthoredWorkbookJudgePrompt(scenario(), trace, gate());
    const base = { runId: "run-002", scenario: scenario(), trace, gate: gate(), judgeInput: prompt, judge: judgeResult(), modelIdentities: modelIdentities() };

    expect(() => createAuthoredWorkbookEvalReportBundleObjects({ ...base, judgeInput: "raw prompt secret attempt-command-secret" })).toThrow("Judge input does not match the sanitized authored workbook judge prompt.");
    expect(() => createAuthoredWorkbookEvalReportBundleObjects({ ...base, judge: { criteria: { ...judgeResult().criteria, "public-contract": { score: 2, citations: [999], rationale: "bad" } }, summary: "bad" } })).toThrow(/unknown trace citation/i);
    expect(() => createAuthoredWorkbookEvalReportBundleObjects({ ...base, gate: gate(false) })).toThrow(/deterministic gate failed/i);
    expect(() => createAuthoredWorkbookEvalReportBundleObjects({ ...base, runId: "../private" })).toThrow(/run id/i);
    expect(() => createAuthoredWorkbookEvalReportBundleObjects({ ...base, modelIdentities: { ...modelIdentities(), judge: { requested: "google/gemini", selected: "google/gemini\nOPENCODE_API_KEY=sk-secret-token" } } })).toThrow(/model identity/i);
  });
});
