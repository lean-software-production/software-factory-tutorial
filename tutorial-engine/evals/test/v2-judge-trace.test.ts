import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkbookTimelineRecord } from "../../src/workbook/timeline.js";
import { buildV2JudgePrompt, createV2Report, enumerateTraceCitations, invokeJudgeCommand, probeV2JudgeCommandModel, verifyV2JudgeResult, V2_JUDGE_PROMPT_MAX_BYTES, V2_JUDGE_STDOUT_MAX_BYTES } from "../v2/judge.js";
import { findV2Scenario } from "../v2/scenarios.js";
import { createEmptyV2SessionTrace, projectV2JudgeTrace } from "../v2/session.js";

const lessonId = "001-live-session";

async function pathExists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch { return false; }
}

function record(event: Record<string, unknown>): WorkbookTimelineRecord {
  return { id: "raw-id", sequence: 1, at: "2026-08-20T00:00:00.000Z", ...event } as WorkbookTimelineRecord;
}

function finishedEvidence(secret: string) {
  return {
    kind: "finished",
    command: `echo command-${secret}`,
    interactions: [
      { kind: "input", data: `echo input-${secret}\r` },
      { kind: "output", data: `output-${secret}\r\n` }
    ],
    exitStatus: 0,
    transcriptSnapshot: { label: `snapshot-${secret}`, transcript: `transcript-snapshot-${secret}`, truncated: false }
  };
}

describe("v2 public judge trace projection", () => {
  it("bounds judge command lifetime and rejects with a fixed sanitized error", async () => {
    const root = await mkdtemp(join(tmpdir(), "v2-judge-timeout-"));
    const command = join(root, "hang.sh");
    await writeFile(command, "#!/bin/sh\nsleep 10\n", { mode: 0o700 });
    try {
      await expect(invokeJudgeCommand({
        prompt: "not recorded",
        model: "provider/model",
        environment: { EVAL_JUDGE_MODEL: "provider/model", EVAL_JUDGE_COMMAND: command, PATH: process.env.PATH, HOME: process.env.HOME },
        timeoutMs: 10
      })).rejects.toThrow("Judge command timed out before returning a bounded JSON result.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects oversized judge prompts before spawning and keeps the error fixed", async () => {
    const root = await mkdtemp(join(tmpdir(), "v2-judge-oversized-prompt-"));
    const command = join(root, "should-not-run.sh");
    await writeFile(command, "#!/bin/sh\necho spawned > \"$HOME/ran\"\n", { mode: 0o700 });
    try {
      await expect(invokeJudgeCommand({
        prompt: "x".repeat(V2_JUDGE_PROMPT_MAX_BYTES + 1),
        model: "provider/model",
        environment: { EVAL_JUDGE_MODEL: "provider/model", EVAL_JUDGE_COMMAND: command, PATH: process.env.PATH, HOME: root }
      })).rejects.toThrow("Judge prompt exceeded the bounded input size limit.");
      await expect(pathExists(join(root, "ran"))).resolves.toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("kills noisy judge stdout after the byte bound without retaining raw output", async () => {
    const root = await mkdtemp(join(tmpdir(), "v2-judge-noisy-stdout-"));
    const command = join(root, "noisy.js");
    await writeFile(command, `#!/usr/bin/env node\nprocess.stdout.write("A".repeat(${V2_JUDGE_STDOUT_MAX_BYTES + 1}));\nsetTimeout(() => {}, 10000);\n`, { mode: 0o700 });
    try {
      await expect(invokeJudgeCommand({
        prompt: "not recorded",
        model: "provider/model",
        environment: { EVAL_JUDGE_MODEL: "provider/model", EVAL_JUDGE_COMMAND: command, PATH: process.env.PATH, HOME: process.env.HOME },
        timeoutMs: 5_000
      })).rejects.toThrow("Judge command exceeded the bounded output size limit.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("wraps malformed judge JSON in a fixed response-free error", async () => {
    const root = await mkdtemp(join(tmpdir(), "v2-judge-malformed-json-"));
    const command = join(root, "malformed.sh");
    await writeFile(command, "#!/bin/sh\necho 'raw malformed secret {not-json'\n", { mode: 0o700 });
    try {
      await expect(invokeJudgeCommand({
        prompt: "not recorded",
        model: "provider/model",
        environment: { EVAL_JUDGE_MODEL: "provider/model", EVAL_JUDGE_COMMAND: command, PATH: process.env.PATH, HOME: process.env.HOME }
      })).rejects.toThrow("Judge command returned invalid bounded JSON.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("handles early-exit stdin errors through sanitized one-shot settlement", async () => {
    const root = await mkdtemp(join(tmpdir(), "v2-judge-early-exit-"));
    const command = join(root, "early-exit.sh");
    await writeFile(command, "#!/bin/sh\nexit 7\n", { mode: 0o700 });
    try {
      await expect(invokeJudgeCommand({
        prompt: "x".repeat(Math.floor(V2_JUDGE_PROMPT_MAX_BYTES / 2)),
        model: "provider/model",
        environment: { EVAL_JUDGE_MODEL: "provider/model", EVAL_JUDGE_COMMAND: command, PATH: process.env.PATH, HOME: process.env.HOME }
      })).rejects.toThrow("Judge command failed before returning a bounded JSON result.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports only structural judge command labels in successful preflight", async () => {
    const root = await mkdtemp(join(tmpdir(), "v2-judge-label-"));
    const command = join(root, "judge.sh");
    await writeFile(command, "#!/bin/sh\nprintf '{\"ok\":true}'\n", { mode: 0o700 });
    try {
      await expect(probeV2JudgeCommandModel({ EVAL_JUDGE_MODEL: "provider/model", EVAL_JUDGE_COMMAND: `${command} --private-arg`, PATH: process.env.PATH, HOME: process.env.HOME })).resolves.toEqual({
        commandLabel: "configured-command",
        model: "provider/model",
        capabilities: { jsonObject: true }
      });
      await expect(probeV2JudgeCommandModel({ EVAL_JUDGE_MODEL: "provider/model", PATH: root, HOME: process.env.HOME }, { timeoutMs: 10 })).rejects.toThrow("Judge command/model preflight failed for default-pi/provider/model.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drops every private terminal lifecycle variant from trace, prompt, and report", () => {
    const trace = createEmptyV2SessionTrace("v2-exact-command-success");
    trace.publicStates.push({ label: "public", state: { progress: { activeBlockId: "exact-command" } } });
    trace.events.push(
      record({ type: "terminal-command-submitted", attemptId: "attempt-command-secret", lessonId, blockId: "exact-command", command: "echo command-secret", terminalSessionId: "terminal-session-secret" }),
      record({ type: "terminal-command-finished", attemptId: "attempt-command-secret", evidence: finishedEvidence("finished-secret") }),
      record({ type: "terminal-transcript-snapshotted", attemptId: "attempt-transcript-secret", lessonId, blockId: "exact-command", transcript: "transcript-secret" }),
      record({ type: "terminal-feedback-recorded", attemptId: "attempt-feedback-secret", text: "feedback-secret" }),
      record({ type: "attempt_accepted", lessonId, blockId: "exact-command", attemptId: "attempt-accepted-secret", version: 1, kind: "terminal", summary: "accepted-summary-secret" })
    );
    trace.artifacts.push({ path: "factory/.tmp/evaluator-command.txt", content: "public artifact\n" });

    const judgeTrace = projectV2JudgeTrace(trace);
    const scenario = findV2Scenario(trace.scenarioId);
    const gate = { passed: true, assertions: [] };
    const prompt = buildV2JudgePrompt(scenario, judgeTrace, gate);
    const judge = verifyV2JudgeResult({
      dimensions: {
        protocolUse: { score: 2, citations: [0], rationale: "public state" },
        tutorQuality: { score: 2, citations: [1], rationale: "public progression" },
        criteriaFit: { score: 2, citations: [2], rationale: "public artifact" }
      },
      summary: "ok"
    }, judgeTrace);
    const report = createV2Report({ scenario, trace: judgeTrace, gate, judgeInput: prompt, judge, tutorModel: "tutor", judgeModel: "judge" });

    expect(judgeTrace.progressionEvents).toEqual([{ type: "attempt_accepted", lessonId, blockId: "exact-command", kind: "terminal" }]);
    expect(judgeTrace).not.toHaveProperty("events");
    expect(report.trace).not.toHaveProperty("events");

    const publicSerializations = [JSON.stringify(judgeTrace), prompt, JSON.stringify(report)];
    for (const serialized of publicSerializations) {
      expect(serialized).not.toContain("terminal-command-submitted");
      expect(serialized).not.toContain("terminal-command-finished");
      expect(serialized).not.toContain("terminal-transcript-snapshotted");
      expect(serialized).not.toContain("terminal-feedback-recorded");
      expect(serialized).not.toContain("attempt-command-secret");
      expect(serialized).not.toContain("attempt-finished-secret");
      expect(serialized).not.toContain("attempt-transcript-secret");
      expect(serialized).not.toContain("attempt-feedback-secret");
      expect(serialized).not.toContain("attempt-accepted-secret");
      expect(serialized).not.toContain("terminal-session-secret");
      expect(serialized).not.toContain("command-finished-secret");
      expect(serialized).not.toContain("input-finished-secret");
      expect(serialized).not.toContain("output-finished-secret");
      expect(serialized).not.toContain("snapshot-finished-secret");
      expect(serialized).not.toContain("transcript-snapshot-finished-secret");
      expect(serialized).not.toContain("transcript-secret");
      expect(serialized).not.toContain("feedback-secret");
      expect(serialized).not.toContain("accepted-summary-secret");
      expect(serialized).not.toContain("review mode");
    }
  });

  it("drops unknown future events and reconstructs allowlisted events without private extras", () => {
    const trace = createEmptyV2SessionTrace("projection");
    trace.events.push(
      record({ type: "future_private_event", lessonId, blockId: "exact-command", text: "future-event-secret" }),
      record({
        type: "block_completed",
        lessonId,
        blockId: "exact-command",
        response: "response-secret",
        summary: "summary-secret",
        path: "path-secret",
        terminalHtml: "html-secret",
        attemptId: "attempt-secret",
        terminalEvidence: { command: "evidence-command-secret" },
        tutor: "private tutor field"
      })
    );

    const judgeTrace = projectV2JudgeTrace(trace);

    expect(judgeTrace.progressionEvents).toEqual([{ type: "block_completed", lessonId, blockId: "exact-command" }]);
    expect(JSON.stringify(trace.events)).toContain("future-event-secret");
    expect(JSON.stringify(trace.events)).toContain("private tutor field");
    expect(JSON.stringify(judgeTrace)).not.toContain("future-event-secret");
    expect(JSON.stringify(judgeTrace)).not.toContain("response-secret");
    expect(JSON.stringify(judgeTrace)).not.toContain("summary-secret");
    expect(JSON.stringify(judgeTrace)).not.toContain("path-secret");
    expect(JSON.stringify(judgeTrace)).not.toContain("html-secret");
    expect(JSON.stringify(judgeTrace)).not.toContain("attempt-secret");
    expect(JSON.stringify(judgeTrace)).not.toContain("evidence-command-secret");
    expect(JSON.stringify(judgeTrace)).not.toContain("private tutor field");
  });

  it("drops malformed known progression events before trace, prompt, and report serialization", () => {
    const trace = createEmptyV2SessionTrace("v2-exact-command-success");
    trace.publicStates.push({ label: "public", state: { progress: { activeBlockId: "exact-command" } } });
    trace.events.push(
      record({ type: "attempt_accepted", lessonId, blockId: "exact-command", attemptId: "valid-attempt-secret", version: 1, kind: "terminal", summary: "valid accepted summary secret" }),
      record({ type: "attempt_accepted", lessonId, blockId: "exact-command", kind: "terminal", summary: "missing-attempt-secret" }) as WorkbookTimelineRecord,
      record({ type: "attempt_accepted", lessonId, blockId: "exact-command", kind: "not-public-kind", attemptId: "invalid-kind-secret", version: 1, summary: "invalid kind summary secret" }) as WorkbookTimelineRecord,
      record({ type: "block_completed", lessonId: { secret: "object-lesson-secret" }, blockId: "exact-command" }) as WorkbookTimelineRecord,
      record({ type: "reflection_submitted", lessonId, blockId: ["array-block-secret"], response: "response-secret" }) as WorkbookTimelineRecord,
      record({ type: "lesson_jump_started", lessonId: ["array-lesson-secret"] }) as WorkbookTimelineRecord,
      record({ type: "message", lessonId, blockId: "exact-command", text: "message-secret", role: "assistant", source: "main_tutor", presentation: "chat" }),
      record({ type: "block_summarized", lessonId, blockId: "exact-command", text: "block-summary-secret", coveredThroughId: "covered-block-secret" }),
      record({ type: "lesson_summarized", lessonId, text: "lesson-summary-secret", coveredThroughId: "covered-lesson-secret" }),
      record({ type: "workbook_completion_summary", text: "completion-secret" })
    );

    const judgeTrace = projectV2JudgeTrace(trace);
    const scenario = findV2Scenario(trace.scenarioId);
    const gate = { passed: true, assertions: [] };
    const prompt = buildV2JudgePrompt(scenario, judgeTrace, gate);
    const judge = verifyV2JudgeResult({
      dimensions: {
        protocolUse: { score: 2, citations: [0], rationale: "public state" },
        tutorQuality: { score: 2, citations: [1], rationale: "valid event" },
        criteriaFit: { score: 2, citations: [0, 1], rationale: "both" }
      },
      summary: "ok"
    }, judgeTrace);
    const report = createV2Report({ scenario, trace: judgeTrace, gate, judgeInput: prompt, judge, tutorModel: "tutor", judgeModel: "judge" });

    expect(judgeTrace.progressionEvents).toEqual([{ type: "attempt_accepted", lessonId, blockId: "exact-command", kind: "terminal" }]);
    expect(report.scenario).not.toHaveProperty("actions");
    for (const serialized of [JSON.stringify(judgeTrace), prompt, JSON.stringify(report)]) {
      expect(serialized).not.toContain("valid-attempt-secret");
      expect(serialized).not.toContain("valid accepted summary secret");
      expect(serialized).not.toContain("missing-attempt-secret");
      expect(serialized).not.toContain("invalid-kind-secret");
      expect(serialized).not.toContain("invalid kind summary secret");
      expect(serialized).not.toContain("object-lesson-secret");
      expect(serialized).not.toContain("array-block-secret");
      expect(serialized).not.toContain("array-lesson-secret");
      expect(serialized).not.toContain("message-secret");
      expect(serialized).not.toContain("block-summary-secret");
      expect(serialized).not.toContain("covered-block-secret");
      expect(serialized).not.toContain("lesson-summary-secret");
      expect(serialized).not.toContain("covered-lesson-secret");
      expect(serialized).not.toContain("completion-secret");
    }
  });

  it("defensively rebuilds exported prompt and report traces without injected extras or judge-channel timestamps", () => {
    const unsafeTrace = {
      scenarioId: "v2-exact-command-success",
      events: [{ type: "terminal-command-submitted", attemptId: "top-level-events-secret" }],
      publicStates: [{
        label: "browser-public",
        state: {
          customPublicEvidence: { kept: true },
          timeline: [{ id: "public-message-id", at: "public-state-at", text: "browser-public-message" }]
        },
        extra: "public-state-extra-secret"
      }],
      terminalTranscript: [{ blockId: "exact-command", direction: "input", text: "echo ok", at: "terminal-at-secret", html: "terminal-extra-secret" }],
      reflections: [{ blockId: "reflection", role: "learner", text: "learner text", at: "reflection-at-secret", extra: "reflection-extra-secret" }],
      editors: [{ blockId: "editor", revision: 1, status: "feedback", feedback: "revise", at: "editor-at-secret", patch: "editor-extra-secret" }],
      progressionEvents: [{ type: "block_completed", lessonId, blockId: "exact-command", attemptId: "progression-extra-secret", at: "progression-at-secret" }],
      artifacts: [{ path: "factory/.tmp/public.txt", content: "artifact public", at: "artifact-at-secret", extra: "artifact-extra-secret" }]
    } as unknown as ReturnType<typeof projectV2JudgeTrace>;
    const scenario = findV2Scenario("v2-exact-command-success");
    const gate = { passed: true, assertions: [] };

    const citations = enumerateTraceCitations(unsafeTrace);
    const prompt = buildV2JudgePrompt(scenario, unsafeTrace, gate);
    const judge = verifyV2JudgeResult({
      dimensions: {
        protocolUse: { score: 2, citations: [0], rationale: "public state" },
        tutorQuality: { score: 2, citations: [1, 2, 3], rationale: "turns" },
        criteriaFit: { score: 2, citations: [4, 5], rationale: "progress and artifact" }
      },
      summary: "ok"
    }, unsafeTrace);
    expect(() => createV2Report({ scenario, trace: unsafeTrace, gate, judgeInput: "raw prompt secret top-level-events-secret", judge, tutorModel: "tutor", judgeModel: "judge" })).toThrow("Judge input does not match the sanitized v2 judge prompt.");
    const report = createV2Report({ scenario, trace: unsafeTrace, gate, judgeInput: prompt, judge, tutorModel: "tutor", judgeModel: "judge" });

    expect(citations).toHaveLength(6);
    expect(citations[0]).toEqual({
      id: 0,
      kind: "publicState",
      value: { label: "browser-public", state: { customPublicEvidence: { kept: true }, timeline: [{ id: "public-message-id", at: "public-state-at", text: "browser-public-message" }] } }
    });
    expect(report.trace).not.toHaveProperty("events");
    expect(report.trace.terminalTranscript[0]).not.toHaveProperty("at");
    expect(report.trace.reflections[0]).not.toHaveProperty("at");
    expect(report.trace.editors[0]).not.toHaveProperty("at");
    expect(report.trace.progressionEvents[0]).not.toHaveProperty("at");
    expect(report.trace.artifacts[0]).not.toHaveProperty("at");
    expect(report.trace.publicStates[0]?.state).toHaveProperty("customPublicEvidence");
    expect(JSON.stringify(report.trace.publicStates[0]?.state)).toContain("public-state-at");
    expect(prompt).toContain("customPublicEvidence");
    expect(prompt).toContain("public-state-at");
    expect(report.judgeInput).toEqual({ prompt });
    expect(report.scenario).not.toHaveProperty("actions");
    for (const serialized of [JSON.stringify(citations), prompt, JSON.stringify(report)]) {
      expect(serialized).not.toContain("raw prompt secret");
      expect(serialized).not.toContain("top-level-events-secret");
      expect(serialized).not.toContain("public-state-extra-secret");
      expect(serialized).not.toContain("terminal-at-secret");
      expect(serialized).not.toContain("terminal-extra-secret");
      expect(serialized).not.toContain("reflection-at-secret");
      expect(serialized).not.toContain("reflection-extra-secret");
      expect(serialized).not.toContain("editor-at-secret");
      expect(serialized).not.toContain("editor-extra-secret");
      expect(serialized).not.toContain("progression-extra-secret");
      expect(serialized).not.toContain("progression-at-secret");
      expect(serialized).not.toContain("artifact-at-secret");
      expect(serialized).not.toContain("artifact-extra-secret");
    }
  });

  it("fails closed on invalid top-level judge traces with a sanitized message", () => {
    const scenario = findV2Scenario("v2-exact-command-success");
    expect(() => buildV2JudgePrompt(scenario, { scenarioId: "x", publicStates: [] } as unknown as ReturnType<typeof projectV2JudgeTrace>, { passed: true, assertions: [] })).toThrow("Invalid public judge trace.");
  });

  it("keeps whole browser-public states including vocabulary and keys that used to be banned", () => {
    const trace = createEmptyV2SessionTrace("v2-exact-command-success");
    trace.publicStates.push({
      label: "state",
      state: {
        arbitraryPublicField: { nested: ["kept"] },
        timeline: [{ type: "message", id: "public-id", at: "public-at", text: "public tutor failure shown to learner" }],
        tutor: { text: "Public state can mention This is private tutor guidance, Do not reveal an exact command, Follow up until the learner, Private editor criterion, terminal-command-submitted, terminal-command-finished, and JSON-looking \"tutor\":" }
      }
    });

    const judgeTrace = projectV2JudgeTrace(trace);

    expect(judgeTrace.publicStates[0]?.state).toEqual({
      arbitraryPublicField: { nested: ["kept"] },
      timeline: [{ type: "message", id: "public-id", at: "public-at", text: "public tutor failure shown to learner" }],
      tutor: { text: "Public state can mention This is private tutor guidance, Do not reveal an exact command, Follow up until the learner, Private editor criterion, terminal-command-submitted, terminal-command-finished, and JSON-looking \"tutor\":" }
    });
    expect(JSON.stringify(judgeTrace)).toContain("terminal-command-finished");
    expect(JSON.stringify(judgeTrace)).toContain('"tutor"');
  });

  it("allows public text to discuss terminal lifecycle labels while still dropping undeclared structure", () => {
    const trace = createEmptyV2SessionTrace("v2-exact-command-success");
    trace.publicStates.push({ label: "public", state: { note: "The learner says no terminal feedback text was exposed and terminal-command-submitted is only a label they learned about." } });
    trace.terminalTranscript.push({ blockId: "exact-command", direction: "observer", text: "Public observer text can mention terminal-command-finished as vocabulary." });
    trace.artifacts.push({ path: "factory/.tmp/public-vocabulary.txt", content: "No terminal feedback text was exposed; terminal-command-submitted stayed internal.\n" });
    trace.events.push(record({ type: "terminal-feedback-recorded", attemptId: "attempt-secret", text: "private-feedback-secret" }));
    const judgeTrace = projectV2JudgeTrace(trace);
    const unsafeTrace = {
      ...judgeTrace,
      events: [{ type: "terminal-command-submitted", text: "injected-raw-event-secret" }],
      terminalTranscript: judgeTrace.terminalTranscript.map((entry) => ({ ...entry, attemptId: "injected-attempt-secret" })),
      artifacts: judgeTrace.artifacts.map((artifact) => ({ ...artifact, rawEvent: { type: "terminal-command-submitted", text: "injected-artifact-secret" } }))
    } as unknown as typeof judgeTrace;
    const scenario = findV2Scenario(trace.scenarioId);
    const gate = { passed: true, assertions: [{ name: "private assertion secret", passed: true, detail: "private detail secret" }] };
    const prompt = buildV2JudgePrompt(scenario, unsafeTrace, gate);
    const judge = verifyV2JudgeResult({
      dimensions: {
        protocolUse: { score: 2, citations: [0], rationale: "No terminal feedback text was exposed in the public trace; the phrase This is private tutor guidance is only discussed as public prose." },
        tutorQuality: { score: 2, citations: [1], rationale: "terminal-command-submitted and terminal-command-finished were discussed only as public vocabulary, as were Do not reveal an exact command and \"tutor\":." },
        criteriaFit: { score: 2, citations: [2], rationale: "The artifact says no terminal feedback text was exposed and can mention Private editor criterion." }
      },
      summary: "The judge may mention terminal feedback text, terminal-command-submitted, Follow up until the learner, and JSON-looking \"tutor\": as public prose."
    }, unsafeTrace);
    const report = createV2Report({ scenario, trace: unsafeTrace, gate, judgeInput: prompt, judge, tutorModel: "tutor", judgeModel: "judge" });

    expect(prompt).toContain("No terminal feedback text was exposed");
    expect(prompt).toContain("terminal-command-submitted");
    expect(report.judge.summary).toContain("terminal feedback text");
    expect(JSON.stringify(report)).toContain("terminal-command-submitted");
    for (const serialized of [prompt, JSON.stringify(report)]) {
      expect(serialized).not.toContain("private-feedback-secret");
      expect(serialized).not.toContain("injected-raw-event-secret");
      expect(serialized).not.toContain("injected-attempt-secret");
      expect(serialized).not.toContain("injected-artifact-secret");
      expect(serialized).not.toContain("private assertion secret");
      expect(serialized).not.toContain("private detail secret");
    }
  });

  it("validates judge citations against projected citation IDs only", () => {
    const trace = createEmptyV2SessionTrace("citations");
    trace.publicStates.push({ label: "public", state: { progress: { activeBlockId: "exact-command" } } });
    trace.events.push(
      record({ type: "terminal-command-submitted", attemptId: "attempt-secret", lessonId, blockId: "exact-command", command: "echo secret", terminalSessionId: "session-secret" }),
      record({ type: "terminal-command-finished", attemptId: "attempt-secret", evidence: finishedEvidence("citation-secret") }),
      record({ type: "terminal-feedback-recorded", attemptId: "attempt-secret", text: "feedback-secret" }),
      record({ type: "terminal-transcript-snapshotted", attemptId: "attempt-secret", lessonId, blockId: "exact-command", transcript: "transcript-secret" }),
      record({ type: "block_completed", lessonId, blockId: "exact-command" })
    );
    const judgeTrace = projectV2JudgeTrace(trace);
    const projectedIds = enumerateTraceCitations(judgeTrace).map((citation) => citation.id);

    expect(projectedIds).toEqual([0, 1]);
    expect(trace.events).toHaveLength(5);
    expect(verifyV2JudgeResult({
      dimensions: {
        protocolUse: { score: 2, citations: [0], rationale: "public state" },
        tutorQuality: { score: 2, citations: [1], rationale: "public event" },
        criteriaFit: { score: 2, citations: [0, 1], rationale: "both" }
      },
      summary: "ok"
    }, judgeTrace).summary).toBe("ok");
    expect(() => verifyV2JudgeResult({
      dimensions: {
        protocolUse: { score: 2, citations: [4], rationale: "would have been inside the raw event count" },
        tutorQuality: { score: 2, citations: [1], rationale: "public event" },
        criteriaFit: { score: 2, citations: [0], rationale: "public state" }
      },
      summary: "bad"
    }, judgeTrace)).toThrow(/unknown trace citation/i);
    expect(verifyV2JudgeResult({
      dimensions: {
        protocolUse: { score: 2, citations: [0], rationale: "terminal-command-finished is safe as public vocabulary" },
        tutorQuality: { score: 2, citations: [1], rationale: "No terminal feedback text was exposed." },
        criteriaFit: { score: 2, citations: [0], rationale: "public state" }
      },
      summary: "The judge can say terminal-command-submitted was not exposed."
    }, judgeTrace).summary).toContain("terminal-command-submitted");
  });
});
