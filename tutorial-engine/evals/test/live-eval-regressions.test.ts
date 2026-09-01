import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { WorkbookTimelineRecord } from "../../src/workbook/timeline.js";
import { buildV2JudgePrompt, createV2Report, verifyV2JudgeResult } from "../v2/judge.js";
import { deterministicV2Gate, findV2Scenario, satisfactoryEditorDraft, v2Scenarios } from "../v2/scenarios.js";
import { createEmptyV2SessionTrace, projectV2JudgeTrace } from "../v2/session.js";
import type { V2GateResult } from "../v2/scenarios.js";
import type { V2SessionTrace } from "../v2/types.js";

const lessonId = "001-live-session";
const exactCommand = "mkdir -p factory/.tmp && printf 'command block complete\\n' > factory/.tmp/evaluator-command.txt && cat factory/.tmp/evaluator-command.txt";

function event(event: Record<string, unknown>): WorkbookTimelineRecord {
  return { id: "fixture", sequence: 1, at: "2026-08-20T00:00:00.000Z", ...event } as WorkbookTimelineRecord;
}

function auditableTrace(): V2SessionTrace {
  const trace = createEmptyV2SessionTrace("v2-exact-command-success");
  trace.publicStates.push({
    label: "editor:editor-practice:reviewed:1",
    state: {
      workbook: { title: "V2 Live Evaluator Workbook" },
      progress: {
        activeLessonId: lessonId,
        activeBlockId: "exact-command",
        completedLessons: [],
        blocks: [
          { id: "editor-practice", type: "editor-practice", completed: true, active: false, editorStatus: "unlocked", revision: 1 },
          { id: "exact-command", type: "terminal-practice", completed: false, active: true }
        ]
      }
    }
  });
  trace.publicStates.push({
    label: "terminal:exact-command:verified",
    state: {
      workbook: { title: "V2 Live Evaluator Workbook" },
      progress: {
        activeLessonId: lessonId,
        activeBlockId: "exact-command",
        completedLessons: [],
        blocks: [
          { id: "editor-practice", type: "editor-practice", completed: true, active: false, editorStatus: "unlocked", revision: 1 },
          { id: "exact-command", type: "terminal-practice", completed: false, active: true }
        ]
      }
    }
  });
  trace.editors.push({ blockId: "editor-practice", revision: 1, status: "unlocked" });
  trace.terminalTranscript.push(
    { blockId: "exact-command", direction: "input", text: `${exactCommand}\r` },
    { blockId: "exact-command", direction: "output", text: "command block complete\r\n" },
    { blockId: "exact-command", direction: "observer", text: "created and printed the command artifact" }
  );
  trace.reflections.push(
    { blockId: "reflection", role: "learner", text: "The public workbook state showed the command block." },
    { blockId: "reflection", role: "tutor", text: "That is visible learner-facing guidance." }
  );
  trace.events.push(
    event({ type: "attempt_accepted", lessonId, blockId: "editor-practice", attemptId: "editor-attempt", version: 1, kind: "editor", summary: "Editor accepted." }),
    event({ type: "attempt_accepted", lessonId, blockId: "exact-command", attemptId: "terminal-attempt", version: 1, kind: "terminal", summary: "created and printed the command artifact" }),
    event({ type: "block_completed", lessonId, blockId: "exact-command" })
  );
  trace.artifacts.push(
    { path: "editor-artifacts/evaluator-editor.txt", content: satisfactoryEditorDraft },
    { path: "factory/.tmp/evaluator-command.txt", content: "command block complete\n" }
  );
  return trace;
}

function passingGate(trace: V2SessionTrace): V2GateResult {
  const gate = deterministicV2Gate(findV2Scenario(trace.scenarioId), trace);
  expect(gate.assertions.filter((assertion) => !assertion.passed)).toEqual([]);
  return gate;
}

describe("live v2 evaluator regressions", () => {
  it("documents exact live command usage, prerequisites, scenario selection, cost, and report files", async () => {
    const readme = await readFile("evals/README.md", "utf8");

    expect(readme).toContain("# Synthetic tutorial-engine mechanics evals");
    expect(readme).toContain("not any consuming workbook's authored curriculum");
    expect(readme).toContain("npm run eval -- --scenario v2-exact-command-success");
    expect(readme).toContain("npm run eval -- --all --yes");
    expect(readme).toContain("npm run eval -- --release");
    expect(readme).toContain("npm run eval:release");
    expect(readme).not.toContain("eval:engine");
    expect(readme).not.toContain("temporary compatibility alias");
    expect(readme).toContain("EVAL_JUDGE_MODEL");
    expect(readme).toContain("TUTOR_MODEL");
    expect(readme).toContain("OPENCODE_API_KEY");
    expect(readme).toContain("build:workbook-terminal");
    expect(readme).toMatch(/paid|cost|tokens/i);
    expect(readme).toContain("Main Tutor");
    expect(readme).toContain("Judge");
    expect(readme).toContain("evals/reports/<run-id>/");
    expect(readme).not.toContain("root `evals/workbook/reports/`");
    expect(readme).not.toContain("eval:workbook");
    expect(readme).not.toContain("reserved and unwired");
    expect(readme).not.toContain("future authored-workbook");
    expect(readme).toContain("bounded release profile");
    expect(readme).toContain("v2-editor-feedback-locked` and `v2-transition-completion` exactly once each");
    expect(readme).toContain("evals/reports/<run-id>/trace.json");
    expect(readme).toContain("evals/reports/<run-id>/judge-input.txt");
    expect(readme).toContain("evals/reports/latest.json");
    expect(readme).toContain("The runner copies `evals/workbook/` into a disposable temporary content root");
    expect(readme).toContain("Raw `workbook/events.jsonl` rows remain internal and gate-only");
    expect(readme).toContain("allowlisted public judge trace");
    expect(readme).toContain("projected structural progression events");
    expect(readme).not.toContain("public workbook events");
    for (const scenario of v2Scenarios) expect(readme).toContain(scenario.id);
  });

  it("keeps the judge input auditable about the checked trace boundary", () => {
    const trace = auditableTrace();
    const scenario = findV2Scenario(trace.scenarioId);
    const gate = passingGate(trace);
    const judgeTrace = projectV2JudgeTrace(trace);
    const judgeInput = buildV2JudgePrompt(scenario, judgeTrace, gate);

    expect(judgeInput).toContain(scenario.criteria[0]!);
    expect(judgeInput).toContain("terminal:exact-command:verified");
    expect(judgeInput).toContain("command block complete");
    expect(judgeInput).toContain("The public workbook state showed the command block.");
    expect(judgeInput).toContain("factory/.tmp/evaluator-command.txt");
    expect(judgeInput).toContain("Allowlisted public judge trace");
    expect(judgeInput).toContain("projected structural workbook progression events");
    expect(judgeInput).not.toContain("durable workbook timeline records from workbook/events.jsonl");
    expect(judgeInput).not.toContain("not all learner-visible");
    expect(judgeInput).not.toContain("Recorded public trace");

    const judge = verifyV2JudgeResult({
      dimensions: {
        protocolUse: { score: 2, citations: [0], rationale: "The public state was recorded." },
        tutorQuality: { score: 2, citations: [1], rationale: "The terminal transcript was recorded." },
        criteriaFit: { score: 2, citations: [4], rationale: "The artifact snapshot was recorded." }
      },
      summary: "The judge received the checked learner trace."
    }, judgeTrace);
    const report = createV2Report({ scenario, trace: judgeTrace, gate, judge, judgeInput, tutorModel: "tutor-model", judgeModel: "judge-model" });

    expect(report.judgeInput).toEqual({ prompt: judgeInput });
    expect(report.trace).toEqual(judgeTrace);
    expect(report.trace).not.toBe(judgeTrace);
    expect(report.artifacts).toEqual(judgeTrace.artifacts);
  });
});
