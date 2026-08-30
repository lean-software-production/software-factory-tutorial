import { describe, expect, it } from "vitest";
import type { WorkbookTimelineRecord } from "../../src/workbook/timeline.js";
import { selectV2Scenarios } from "../run.js";
import { buildV2JudgePrompt, createV2Report, verifyV2JudgeResult } from "../v2/judge.js";
import { clueCommand, deterministicV2Gate, exactCommand, findV2Scenario, satisfactoryEditorDraft, v2Scenarios } from "../v2/scenarios.js";
import { createEmptyV2SessionTrace, projectV2JudgeTrace } from "../v2/session.js";
import type { V2SessionTrace } from "../v2/types.js";

const lessonId = "001-live-session";
function event(event: Record<string, unknown>): WorkbookTimelineRecord {
  return { id: "fixture", sequence: 1, at: "2026-08-20T00:00:00.000Z", ...event } as WorkbookTimelineRecord;
}

function baseTrace(scenarioId: string): V2SessionTrace {
  const trace = createEmptyV2SessionTrace(scenarioId);
  trace.publicStates.push({
    label: "initial",
    state: { workbook: { title: "V2 Live Evaluator Workbook" }, progress: { activeLessonId: lessonId, activeBlockId: "orientation", completedLessons: [], blocks: [] }, chapters: [] }
  });
  trace.events.push(event({ type: "session_started" }), event({ type: "workbook_introduction_completed" }), event({ type: "block_continued", lessonId, blockId: "orientation" }));
  return trace;
}

function editorFeedbackTrace(): V2SessionTrace {
  const trace = baseTrace("v2-editor-feedback-locked");
  trace.publicStates.push({
    label: "editor-practice:feedback",
    state: {
      progress: {
        activeLessonId: lessonId,
        activeBlockId: "editor-practice",
        completedLessons: [],
        blocks: [{ id: "editor-practice", type: "editor-practice", active: true, completed: false, editorStatus: "feedback", revision: 1, checkpoint: { status: "feedback", feedback: "Name editor-artifacts/evaluator-editor.txt and explain the promotion intent.", evidence: { kind: "editor", text: "This is a vague draft." } } }]
      },
      chapters: [{ lesson: { blocks: [{ id: "editor-practice", type: "editor-practice", markdown: "Write a short draft for `editor-artifacts/evaluator-editor.txt`." }] } }]
    }
  });
  return trace;
}

function editorUnlockedTrace(scenarioId = "v2-editor-unlocked"): V2SessionTrace {
  const trace = baseTrace(scenarioId);
  trace.events.push(event({ type: "editor_practice_unlocked", lessonId, blockId: "editor-practice", revisionId: 1, path: "editor-artifacts/evaluator-editor.txt" }));
  trace.publicStates.push({
    label: "editor-practice:unlocked",
    state: {
      progress: {
        activeLessonId: lessonId,
        activeBlockId: "exact-command",
        completedLessons: [],
        blocks: [
          { id: "editor-practice", type: "editor-practice", active: false, completed: true, editorStatus: "unlocked", revision: 1 },
          { id: "exact-command", type: "terminal-practice", active: true, completed: false }
        ]
      }
    }
  });
  trace.artifacts.push({ path: "editor-artifacts/evaluator-editor.txt", content: satisfactoryEditorDraft });
  return trace;
}

function exactCommandTrace(scenarioId = "v2-exact-command-success"): V2SessionTrace {
  const trace = editorUnlockedTrace(scenarioId);
  trace.terminalTranscript.push(
    { blockId: "exact-command", direction: "input", text: `${exactCommand}\r` },
    { blockId: "exact-command", direction: "output", text: "command block complete\r\n" },
    { blockId: "exact-command", direction: "observer", text: "created and printed the command artifact" }
  );
  trace.events.push(
    event({ type: "observation_verified", lessonId, blockId: "exact-command", source: "terminal_observer", summary: "created and printed the command artifact", terminalHtml: "command block complete" }),
    event({ type: "block_completed", lessonId, blockId: "exact-command" })
  );
  trace.artifacts.push({ path: "factory/.tmp/evaluator-command.txt", content: "command block complete\n" });
  return trace;
}

function clueOnlyTrace(): V2SessionTrace {
  const trace = exactCommandTrace("v2-clue-only-task");
  trace.publicStates.push({
    label: "clue-only-visible",
    state: {
      progress: { activeLessonId: lessonId, activeBlockId: "clue-only", completedLessons: [], blocks: [] },
      chapters: [{ lesson: { blocks: [{ id: "clue-only", type: "terminal-practice", markdown: "Create `factory/.tmp/evaluator-clue.txt` and print it back with a command that reads the file." }] } }]
    }
  });
  trace.terminalTranscript.push(
    { blockId: "clue-only", direction: "input", text: `${clueCommand}\r` },
    { blockId: "clue-only", direction: "output", text: "clue block complete\r\n" },
    { blockId: "clue-only", direction: "observer", text: "created and printed the clue artifact" }
  );
  trace.events.push(
    event({ type: "observation_verified", lessonId, blockId: "clue-only", source: "terminal_observer", summary: "created and printed the clue artifact", terminalHtml: "clue block complete" }),
    event({ type: "block_completed", lessonId, blockId: "clue-only" })
  );
  trace.artifacts.push({ path: "factory/.tmp/evaluator-clue.txt", content: "clue block complete\n" });
  return trace;
}

function allGateAssertionsPass(trace: V2SessionTrace) {
  const scenario = findV2Scenario(trace.scenarioId);
  const gate = deterministicV2Gate(scenario, trace);
  expect(gate.assertions.filter((assertion) => !assertion.passed).map((assertion) => `${assertion.name}: ${assertion.detail}`)).toEqual([]);
  return gate;
}

describe("v2 live evaluator scenarios", () => {
  it("declares the live v2 scenarios and selects them from evals/run.ts", () => {
    expect(v2Scenarios.map((scenario) => scenario.id)).toEqual([
      "v2-exact-command-success",
      "v2-editor-feedback-locked",
      "v2-editor-unlocked",
      "v2-clue-only-task",
      "v2-reflection-follow-up",
      "v2-transition-completion"
    ]);
    expect(selectV2Scenarios(["--scenario", "v2-exact-command-success"]).map((scenario) => scenario.id)).toEqual(["v2-exact-command-success"]);
    expect(selectV2Scenarios(["--all"]).map((scenario) => scenario.id)).toEqual(v2Scenarios.map((scenario) => scenario.id));
  });

  it("continues the accepted editor block before submitting terminal commands", () => {
    const actions = findV2Scenario("v2-exact-command-success").actions;
    const editorIndex = actions.findIndex((action) => action.type === "editor" && action.blockId === "editor-practice");
    const editorContinueIndex = actions.findIndex((action, index) => index > editorIndex && action.type === "continue" && action.blockId === "editor-practice");
    const terminalIndex = actions.findIndex((action) => action.type === "terminal" && action.blockId === "exact-command");

    expect(editorIndex).toBeGreaterThan(-1);
    expect(editorContinueIndex).toBeGreaterThan(editorIndex);
    expect(terminalIndex).toBeGreaterThan(editorContinueIndex);
  });

  it("gates exact command success on the recorded command, output, verification, completion, and artifact", () => {
    const trace = exactCommandTrace();
    const gate = allGateAssertionsPass(trace);
    expect(gate.assertions.map((assertion) => assertion.name)).toContain("exact command input");

    const wrong = exactCommandTrace();
    wrong.terminalTranscript[0] = { blockId: "exact-command", direction: "input", text: "cat factory/.tmp/evaluator-command.txt\r" };
    const failed = deterministicV2Gate(findV2Scenario(wrong.scenarioId), wrong);
    expect(failed.assertions.find((assertion) => assertion.name === "exact command input")?.passed).toBe(false);
  });

  it("accepts canonical live attempt-accepted events in the exact command gate", () => {
    const trace = exactCommandTrace();
    trace.events = trace.events.filter((entry) => entry.type !== "editor_practice_unlocked" && entry.type !== "observation_verified");
    trace.events.unshift(event({ type: "attempt_accepted", lessonId, blockId: "lesson--001-live-session--editor-practice", attemptId: "editor-attempt", version: 1, kind: "editor", summary: "Editor accepted." }));
    trace.events.unshift(event({ type: "attempt_accepted", lessonId, blockId: "lesson--001-live-session--exact-command", attemptId: "terminal-attempt", version: 1, kind: "terminal", summary: "Terminal accepted." }));
    trace.editors.push({ blockId: "lesson--001-live-session--editor-practice", revision: 1, status: "unlocked" });
    trace.terminalTranscript = trace.terminalTranscript.map((entry) => ({ ...entry, blockId: entry.blockId === "exact-command" ? "lesson--001-live-session--exact-command" : entry.blockId }));

    allGateAssertionsPass(trace);
  });

  it("does not fail deterministic gates because private terminal lifecycle rows remain internal", () => {
    const trace = exactCommandTrace();
    trace.events.push(event({ type: "terminal-coach-handoff-recorded", attemptId: "private-attempt", outcome: "ready", text: "This is private tutor guidance in a gate-only terminal lifecycle row." }));

    allGateAssertionsPass(trace);
  });

  it("gates incomplete editor drafts on public feedback without unlocking", () => {
    const trace = editorFeedbackTrace();
    allGateAssertionsPass(trace);

    const topLevelOnlyFeedback = editorFeedbackTrace();
    const topLevelOnlyBlock = (topLevelOnlyFeedback.publicStates[1]!.state as any).progress.blocks[0];
    const feedback = topLevelOnlyBlock.checkpoint.feedback;
    delete topLevelOnlyBlock.checkpoint;
    topLevelOnlyBlock.feedback = feedback;
    const topLevelOnlyFailed = deterministicV2Gate(findV2Scenario(topLevelOnlyFeedback.scenarioId), topLevelOnlyFeedback);
    expect(topLevelOnlyFailed.assertions.find((assertion) => assertion.name === "editor feedback visible")?.passed).toBe(false);

    const missingFeedback = baseTrace("v2-editor-feedback-locked");
    const failed = deterministicV2Gate(findV2Scenario(missingFeedback.scenarioId), missingFeedback);
    expect(failed.assertions.find((assertion) => assertion.name === "editor feedback visible")?.passed).toBe(false);

    const feedbackStatusOnly = baseTrace("v2-editor-feedback-locked");
    feedbackStatusOnly.publicStates.push({
      label: "editor-practice:feedback-status-only",
      state: {
        progress: {
          activeLessonId: lessonId,
          activeBlockId: "editor-practice",
          completedLessons: [],
          blocks: [{ id: "editor-practice", type: "editor-practice", active: true, completed: false, editorStatus: "feedback", revision: 1 }]
        }
      }
    });
    const statusOnlyFailed = deterministicV2Gate(findV2Scenario(feedbackStatusOnly.scenarioId), feedbackStatusOnly);
    expect(statusOnlyFailed.assertions.find((assertion) => assertion.name === "editor feedback visible")?.passed).toBe(false);

    const publicVocabulary = editorFeedbackTrace();
    (publicVocabulary.publicStates[1]!.state as any).progress.blocks[0].checkpoint.feedback = "Private editor criterion can appear as public learner-visible prose; terminal-command-submitted and Coach handoff can too.";
    const vocabularyGate = deterministicV2Gate(findV2Scenario(publicVocabulary.scenarioId), publicVocabulary);
    expect(vocabularyGate.assertions.find((assertion) => assertion.name === "checked trace uses projected judge structure")?.passed).toBe(true);
  });

  it("gates satisfactory editor drafts on unlock and promoted artifact", () => {
    const trace = editorUnlockedTrace();
    allGateAssertionsPass(trace);

    const missingArtifact = editorUnlockedTrace();
    missingArtifact.artifacts = [];
    const failed = deterministicV2Gate(findV2Scenario(missingArtifact.scenarioId), missingArtifact);
    expect(failed.assertions.find((assertion) => assertion.name === "editor-artifacts/evaluator-editor.txt artifact")?.passed).toBe(false);
  });

  it("keeps raw timeline fields out of deterministic gate details", () => {
    const trace = editorUnlockedTrace();
    const unlock = trace.events.find((item) => item.type === "editor_practice_unlocked") as any;
    unlock.path = "path-secret-from-raw-event";
    unlock.revisionId = 99;

    const failed = deterministicV2Gate(findV2Scenario(trace.scenarioId), trace);
    const detail = failed.assertions.find((assertion) => assertion.name === "editor unlocked")?.detail ?? "";

    expect(detail).toContain("expectedPath=false");
    expect(detail).toContain("expectedRevision=false");
    expect(detail).not.toContain("path-secret-from-raw-event");
    expect(detail).not.toContain("revision=99");
  });

  it("gates a clue-only task on public clues, learner-chosen command, output, completion, and artifact", () => {
    const trace = clueOnlyTrace();
    allGateAssertionsPass(trace);

    const wrongPath = clueOnlyTrace();
    wrongPath.terminalTranscript = wrongPath.terminalTranscript.map((entry) => entry.blockId === "clue-only" && entry.direction === "input"
      ? { ...entry, text: "mkdir -p .tmp && printf 'clue block complete\\n' > .tmp/evaluator-clue.txt && cat .tmp/evaluator-clue.txt\r" }
      : entry);
    const wrongPathFailed = deterministicV2Gate(findV2Scenario(wrongPath.scenarioId), wrongPath);
    expect(wrongPathFailed.assertions.find((assertion) => assertion.name === "clue-only learner command")?.passed).toBe(false);

    const publicVocabulary = clueOnlyTrace();
    (publicVocabulary.publicStates[2]!.state as any).chapters[0].lesson.blocks[0].markdown += "\nPublic prose may mention terminal-command-submitted, Coach handoff, \"tutor\":, and unrelated shell-looking text such as printf 'hello\\n' > notes/example.txt && cat notes/example.txt.";
    const vocabularyGate = deterministicV2Gate(findV2Scenario(publicVocabulary.scenarioId), publicVocabulary);
    expect(vocabularyGate.assertions.find((assertion) => assertion.name === "clue-only public prompt")?.passed).toBe(true);

    const exposedCommand = clueOnlyTrace();
    (exposedCommand.publicStates[2]!.state as any).chapters[0].lesson.blocks[0].markdown += `\nDo not include this canonical solution in the public prompt: ${clueCommand}`;
    const exposedCommandGate = deterministicV2Gate(findV2Scenario(exposedCommand.scenarioId), exposedCommand);
    const exposedCommandAssertion = exposedCommandGate.assertions.find((assertion) => assertion.name === "clue-only public prompt");
    expect(exposedCommandAssertion?.passed).toBe(false);
    expect(exposedCommandAssertion?.detail).toContain("canonical solution command");
  });

  it("gates reflection follow-up on learner, tutor, follow-up, second tutor reply, and completion", () => {
    const trace = clueOnlyTrace();
    trace.scenarioId = "v2-reflection-follow-up";
    trace.reflections.push(
      { blockId: "lesson--001-live-session--reflection", role: "learner", text: "The exact command block gave me the command; the clue block made me choose one." },
      { blockId: "lesson--001-live-session--reflection", role: "tutor", text: "What made the clue-only block different?" },
      { blockId: "lesson--001-live-session--reflection", role: "learner", text: "The clue-only block showed the goal but not an exact shell line." },
      { blockId: "lesson--001-live-session--reflection", role: "tutor", text: "Yes: it used public clues, not private tutor guidance." }
    );
    trace.events.push(
      event({ type: "reflection_submitted", lessonId, blockId: "reflection", response: trace.reflections[0]!.text }),
      event({ type: "reflection_reply_recorded", lessonId, blockId: "reflection", response: trace.reflections[1]!.text }),
      event({ type: "reflection_follow_up_submitted", lessonId, blockId: "reflection", response: trace.reflections[2]!.text }),
      event({ type: "reflection_reply_recorded", lessonId, blockId: "reflection", response: trace.reflections[3]!.text }),
      event({ type: "reflection_completed", lessonId, blockId: "reflection" })
    );

    allGateAssertionsPass(trace);

    const noFollowUp = { ...trace, reflections: trace.reflections.slice(0, 2), events: trace.events.filter((item) => item.type !== "reflection_follow_up_submitted") };
    const failed = deterministicV2Gate(findV2Scenario(noFollowUp.scenarioId), noFollowUp);
    expect(failed.assertions.find((assertion) => assertion.name === "reflection follow-up")?.passed).toBe(false);
  });

  it("gates transition completion on the transition event and completed lesson projection", () => {
    const trace = clueOnlyTrace();
    trace.scenarioId = "v2-transition-completion";
    trace.reflections.push(
      { blockId: "reflection", role: "learner", text: "The exact command block gave me the command; the clue block made me choose one." },
      { blockId: "reflection", role: "tutor", text: "Good distinction." }
    );
    trace.events.push(
      event({ type: "reflection_submitted", lessonId, blockId: "reflection", response: trace.reflections[0]!.text }),
      event({ type: "reflection_reply_recorded", lessonId, blockId: "reflection", response: trace.reflections[1]!.text }),
      event({ type: "reflection_completed", lessonId, blockId: "reflection" }),
      event({ type: "block_continued", lessonId, blockId: "transition" })
    );
    trace.publicStates.push({
      label: "transition-complete",
      state: {
        progress: {
          activeLessonId: lessonId,
          activeBlockId: "transition",
          completedLessons: [lessonId],
          blocks: [{ id: "transition", type: "narrative", completed: true, active: false }]
        }
      }
    });

    allGateAssertionsPass(trace);

    const incomplete = { ...trace, publicStates: trace.publicStates.slice(0, -1) };
    const failed = deterministicV2Gate(findV2Scenario(incomplete.scenarioId), incomplete);
    expect(failed.assertions.find((assertion) => assertion.name === "transition completed")?.passed).toBe(false);
  });

  it("builds a real-judge prompt and report from only scenario criteria plus the trace", () => {
    const trace = exactCommandTrace();
    const scenario = findV2Scenario(trace.scenarioId);
    const gate = allGateAssertionsPass(trace);
    const judgeTrace = projectV2JudgeTrace(trace);
    const prompt = buildV2JudgePrompt(scenario, judgeTrace, gate);

    expect(prompt).toContain(scenario.criteria[0]!);
    expect(prompt).toContain("terminalTranscript");
    expect(prompt).toContain("projected structural workbook progression events");
    expect(prompt).toContain("Allowlisted public judge trace");
    expect(prompt).not.toContain("durable workbook timeline records from workbook/events.jsonl");
    expect(prompt).not.toContain("not all learner-visible");
    expect(prompt).not.toContain("Recorded public trace");
    expect(prompt).not.toContain("Active specification");

    const judge = verifyV2JudgeResult({
      dimensions: {
        protocolUse: { score: 2, citations: [0], rationale: "The tutor waited for recorded evidence." },
        tutorQuality: { score: 2, citations: [1], rationale: "The tutor summarized the completed command." },
        criteriaFit: { score: 2, citations: [2], rationale: "The criteria were met." }
      },
      summary: "The session meets the scenario criteria."
    }, judgeTrace);
    expect(() => verifyV2JudgeResult({ ...judge, dimensions: { ...judge.dimensions, protocolUse: { score: 2, citations: [99], rationale: "bad" } } }, judgeTrace)).toThrow(/unknown trace citation/i);

    const report = createV2Report({ scenario, trace: judgeTrace, gate, judgeInput: prompt, judge, tutorModel: "tutor-model", judgeModel: "judge-model" });
    expect(report.modelIdentities).toEqual({ tutor: "tutor-model", judge: "judge-model" });
    expect(report.judgeInput).toEqual({ prompt });
    expect(report.trace).toEqual(judgeTrace);
    expect(report.trace).not.toBe(judgeTrace);
    expect(report.judge).toEqual(judge);
    expect(report.judge).not.toBe(judge);
    expect(report.artifacts).toEqual(judgeTrace.artifacts);
  });
});
