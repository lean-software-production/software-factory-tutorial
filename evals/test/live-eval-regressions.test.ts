import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deterministicGate } from "../harness/assertions.js";
import { activateLesson, applyCanonicalPatch, matchesArtifactState } from "../harness/workspace.js";
import { advanceHandsOnDriver, beginHandsOnDriver, EvalTimeoutError, foldSnapshotEvents, selectDelegationChoice } from "../harness/session.js";
import { shouldRetry } from "../harness/retry.js";
import { correctFactory, scenarios, type Scenario } from "../scenarios/lesson-001/scenarios.js";
import type { SessionTrace } from "../harness/session.js";
import { loadLesson } from "../../tutorial-engine/src/lesson/load.js";

const mistakeScenarios = scenarios.filter((scenario) => scenario.mode === "mistake");

function traceFor(scenario: Scenario): SessionTrace {
  return {
    startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
    messages: [],
    patchPairs: [{ patch: "defect", learnerMessage: "I've made the step. Please give feedback.", tutorEvents: [], completionChoiceId: "choice-1", correctionCheckpointEvent: 4, correctionCheckpointChoiceId: "correction-choice" }],
    snapshots: Object.fromEntries(scenario.patches.map((patch) => [patch.name, patch.files])), 
    events: [
      { type: "snapshot", title: "Test", runState: "idle", events: [], validationCommands: [], progress: [] },
      { type: "choice", id: "choice-1", question: "Continue?", options: [{ id: "hands-on", label: "I’ll do it", icon: "do" }] },
      { type: "choice-resolved", id: "choice-1", optionId: "hands-on" },
      { type: "audit", id: "read-1", tool: "read", paths: [Object.keys(scenario.patches.find((patch) => patch.name === "defect")?.files ?? {})[0] ?? "factory/factory.sh"], mutation: false, outcome: "ok" },
      { type: "choice", id: "correction-choice", question: "Correct it?", options: [{ id: "confirm", label: "I’ve made this step", icon: "confirm" }] }
    ]
  };
}

describe("live-eval regression coverage", () => {
  it.each(mistakeScenarios)("records scenario-specific defect and repair evidence for $id", async (scenario) => {
    const defect = scenario.patches.find((patch) => patch.name === "defect")!;
    const repair = scenario.patches.find((patch) => patch.name === "repair")!;
    expect(matchesArtifactState(defect.files, defect.expectedState)).toBe(true);
    expect(matchesArtifactState(repair.files, repair.expectedState)).toBe(true);

    const workspace = await mkdtemp(join(tmpdir(), "eval-gate-"));
    try {
      await applyCanonicalPatch(workspace, { name: "final", files: { "factory/factory.sh": correctFactory, "factory/refactor.md": "Inspect the calculator and make one small, behaviour-preserving refactoring. Edit files directly. Do not run tests, npm, or shell commands. Keep your response concise.\n" }, preconditions: {}, expectedState: {} });
      const gate = await deterministicGate(scenario, workspace, traceFor(scenario));
      expect(gate.assertions.find((assertion) => assertion.name === "defect snapshot")?.passed).toBe(true);
      expect(gate.assertions.find((assertion) => assertion.name === "repair snapshot")?.passed).toBe(true);
      expect(gate.assertions.find((assertion) => assertion.name === "filesystem operation outcomes")?.passed).toBe(true);

      const rejectedTrace: SessionTrace = {
        ...traceFor(scenario),
        events: [...traceFor(scenario).events, { type: "audit", id: "failed-read", tool: "read", paths: ["README.md"], mutation: false, outcome: "error", message: "Path not found" }]
      };
      const rejectedGate = await deterministicGate(scenario, workspace, rejectedTrace);
      expect(rejectedGate.assertions.find((assertion) => assertion.name === "filesystem operation outcomes")?.passed).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("splits the learner-led factory into canonical atomic edits", () => {
    const happy = scenarios.find((scenario) => scenario.id === "learner-led-happy-path")!;
    expect(happy.patches.map((patch) => patch.name)).toEqual(["loop", "pause", "invoke", "prompt"]);
    expect(happy.patches.every((patch) => Object.keys(patch.files).length === 1)).toBe(true);
  });

  it("activates the declared lesson only in the disposable workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "eval-lesson-"));
    const ledger = "| Iteration | Goal | Status |\n| --- | --- | --- |\n| [001](001.md) | One | Todo |\n| [002](002.md) | Two | Todo |\n";
    await writeFile(join(workspace, "README.md"), "# Test\n");
    await (await import("node:fs/promises")).mkdir(join(workspace, "docs/specs"), { recursive: true });
    await writeFile(join(workspace, "docs/specs/README.md"), ledger);
    try {
      await activateLesson(workspace, "002");
      const activated = await readFile(join(workspace, "docs/specs/README.md"), "utf8");
      expect(activated).toContain("[001](001.md) | One | Done");
      expect(activated).toContain("[002](002.md) | Two | Todo");
      expect((await loadLesson(workspace)).progress.find((item) => item.state === "current")?.id).toBe("002");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("folds snapshot history before waiting on streamed events", () => {
    const choice = { type: "choice" as const, id: "first", question: "Continue?", options: [{ id: "do", label: "I’ll do it", icon: "do" as const }] };
    const events = foldSnapshotEvents([
      { type: "snapshot" as const, title: "Test", runState: "awaiting-choice" as const, events: [choice], validationCommands: [], progress: [] },
      choice
    ]);
    expect(events.filter((event) => event.type === "choice")).toHaveLength(1);
  });

  it("waits for a next-step start choice before applying the next hands-on patch", () => {
    const scenario: Scenario = {
      id: "offline-normal-choice-flow",
      lesson: "001",
      mode: "hands-on",
      description: "Regression fixture for the learner-led live-eval trace",
      patches: [
        { name: "first", files: { "factory/factory.sh": "first" }, message: "ignored", preconditions: {}, expectedState: {}, checkpoint: "guided-step" },
        { name: "second", files: { "factory/factory.sh": "second" }, message: "ignored", preconditions: {}, expectedState: {}, checkpoint: "guided-step" }
      ]
    };
    const completionChoice = (id: string) => ({ type: "choice" as const, id, question: "How's this step going?", options: [
      { id: `${id}-confirm`, label: "I've made this step", icon: "confirm" as const },
      { id: `${id}-show`, label: "Show me exactly what to type", icon: "show" as const },
      { id: `${id}-delegate`, label: "Make this step for me", icon: "automate" as const }
    ] });
    const confirmationChoice = (id: string) => ({ type: "choice" as const, id, question: "Have you finished?", options: [
      { id: `${id}-confirm`, label: "I've made this step", icon: "confirm" as const },
      { id: `${id}-delegate`, label: "Make this step for me", icon: "automate" as const }
    ] });
    const nextStepStart = {
      type: "choice" as const,
      id: "next-start",
      question: "Ready for the next step?",
      options: [
        { id: "next-do", label: "I’ll do it", icon: "do" as const },
        { id: "next-delegate", label: "Make it for me", icon: "automate" as const }
      ]
    };

    let result = advanceHandsOnDriver(beginHandsOnDriver(), scenario, completionChoice("first-instruction"));
    expect(result.actions).toEqual([{ type: "select", choiceId: "first-instruction", optionId: "first-instruction-show" }]);
    result = advanceHandsOnDriver(result.state, scenario, confirmationChoice("first-exact"));
    expect(result.actions).toEqual([
      { type: "apply", patchIndex: 0 },
      { type: "select", choiceId: "first-exact", optionId: "first-exact-confirm" }
    ]);
    expect(result.state).toEqual({ phase: "awaiting-instruction", patchIndex: 1 });

    result = advanceHandsOnDriver(result.state, scenario, nextStepStart);
    expect(result.actions).toEqual([{ type: "select", choiceId: "next-start", optionId: "next-do" }]);
    expect(result.state).toEqual({ phase: "awaiting-instruction", patchIndex: 1 });

    result = advanceHandsOnDriver(result.state, scenario, completionChoice("second-completion"));
    expect(result.actions).toEqual([{ type: "select", choiceId: "second-completion", optionId: "second-completion-show" }]);
    result = advanceHandsOnDriver(result.state, scenario, confirmationChoice("second-confirmation"));
    expect(result.actions).toEqual([
      { type: "apply", patchIndex: 1 },
      { type: "select", choiceId: "second-confirmation", optionId: "second-confirmation-confirm" }
    ]);
    expect(result.state).toEqual({ phase: "awaiting-lesson-completion-pause" });
  });

  it("dispatches every hands-on patch by icon through real observed guidance choices", () => {
    const scenario: Scenario = {
      id: "icon-driven-hands-on-flow",
      lesson: "001",
      mode: "hands-on",
      description: "Regression fixture for the observed show-confirm inspection flow",
      patches: [
        { name: "first", files: { "factory/factory.sh": "first" }, message: "ignored", preconditions: {}, expectedState: {}, checkpoint: "guided-step" },
        { name: "second", files: { "factory/factory.sh": "second" }, message: "ignored", preconditions: {}, expectedState: {}, checkpoint: "guided-step" }
      ]
    };
    const standardGuidance = (id: string) => ({ type: "choice" as const, id, question: "Tutor prose must not matter", options: [
      { id: `${id}-confirm`, label: "Any confirmation wording", icon: "confirm" as const },
      { id: `${id}-show`, label: "Any exact-guidance wording", icon: "show" as const },
      { id: `${id}-delegate`, label: "Any delegation wording", icon: "automate" as const }
    ] });
    const confirmationOnly = (id: string) => ({ type: "choice" as const, id, question: "Tutor prose must not matter", options: [
      { id: `${id}-confirm`, label: "Any confirmation wording", icon: "confirm" as const },
      { id: `${id}-delegate`, label: "Any delegation wording", icon: "automate" as const }
    ] });
    const pause = { type: "choice" as const, id: "lesson-complete", question: "Tutor prose must not matter", options: [
      { id: "lesson-complete-pause", label: "Any pause wording", icon: "pause" as const }
    ] };

    let result = advanceHandsOnDriver(beginHandsOnDriver(), scenario, standardGuidance("first-guidance"));
    expect(result.actions).toEqual([{ type: "select", choiceId: "first-guidance", optionId: "first-guidance-show" }]);
    result = advanceHandsOnDriver(result.state, scenario, confirmationOnly("first-confirmation"));
    expect(result.actions).toEqual([
      { type: "apply", patchIndex: 0 },
      { type: "select", choiceId: "first-confirmation", optionId: "first-confirmation-confirm" }
    ]);

    // The tutor inspects and gives feedback, then offers the same real-world
    // guidance shape for the next atomic patch rather than a fresh do choice.
    result = advanceHandsOnDriver(result.state, scenario, standardGuidance("second-guidance"));
    expect(result.actions).toEqual([{ type: "select", choiceId: "second-guidance", optionId: "second-guidance-show" }]);
    result = advanceHandsOnDriver(result.state, scenario, confirmationOnly("second-confirmation"));
    expect(result.actions).toEqual([
      { type: "apply", patchIndex: 1 },
      { type: "select", choiceId: "second-confirmation", optionId: "second-confirmation-confirm" }
    ]);
    result = advanceHandsOnDriver(result.state, scenario, pause);
    expect(result.actions).toEqual([{ type: "select", choiceId: "lesson-complete", optionId: "lesson-complete-pause" }]);
    expect(result.state).toEqual({ phase: "complete" });
  });

  it("uses a do icon as a hands-on start fallback without parsing its label", () => {
    const scenario: Scenario = {
      id: "icon-driven-do-fallback", lesson: "001", mode: "hands-on", description: "Regression fixture",
      patches: [{ name: "only", files: {}, message: "ignored", preconditions: {}, expectedState: {}, checkpoint: "guided-step" }]
    };
    const result = advanceHandsOnDriver(beginHandsOnDriver(), scenario, {
      type: "choice", id: "start", question: "Tutor prose must not matter", options: [
        { id: "start-do", label: "Unexpected hands-on label", icon: "do" },
        { id: "start-delegate", label: "Unexpected delegation label", icon: "automate" }
      ]
    });
    expect(result.actions).toEqual([{ type: "select", choiceId: "start", optionId: "start-do" }]);
    expect(result.state).toEqual({ phase: "awaiting-instruction", patchIndex: 0 });
  });

  it("retains the defect audit and correction checkpoint workflow", () => {
    const scenario: Scenario = {
      id: "offline-defect-choice-flow",
      lesson: "001",
      mode: "mistake",
      description: "Regression fixture",
      patches: [
        { name: "defect", files: { "factory/factory.sh": "broken" }, message: "ignored", preconditions: {}, expectedState: {}, checkpoint: "guided-step" },
        { name: "repair", files: { "factory/factory.sh": "fixed" }, message: "ignored", preconditions: {}, expectedState: {}, checkpoint: "correction" }
      ]
    };
    const choice = (id: string) => ({ type: "choice" as const, id, question: "Continue?", options: [
      { id: `${id}-confirm`, label: "I’ve made this step", icon: "confirm" as const },
      { id: `${id}-show`, label: "Show me exactly what to type", icon: "show" as const },
      { id: `${id}-delegate`, label: "Make this step for me", icon: "automate" as const }
    ] });
    const confirmationChoice = (id: string) => ({ type: "choice" as const, id, question: "Continue?", options: [
      { id: `${id}-confirm`, label: "I’ve made this step", icon: "confirm" as const },
      { id: `${id}-delegate`, label: "Make this step for me", icon: "automate" as const }
    ] });

    let result = advanceHandsOnDriver(beginHandsOnDriver(), scenario, choice("instruction"));
    expect(result.actions).toEqual([{ type: "select", choiceId: "instruction", optionId: "instruction-show" }]);
    result = advanceHandsOnDriver(result.state, scenario, confirmationChoice("exact"));
    expect(result.actions).toEqual([
      { type: "apply", patchIndex: 0 },
      { type: "select", choiceId: "exact", optionId: "exact-confirm" }
    ]);
    expect(result.state).toEqual({ phase: "awaiting-defect-audit", patchIndex: 0 });

    expect(() => advanceHandsOnDriver(result.state, scenario, { type: "audit", id: "grep", tool: "grep", paths: ["factory/factory.sh"], mutation: false, outcome: "ok" })).toThrow("Expected an audited read");
    result = advanceHandsOnDriver(result.state, scenario, { type: "audit", id: "read", tool: "read", paths: ["factory/factory.sh"], mutation: false, outcome: "ok" });
    expect(result.actions).toEqual([]);
    expect(result.state).toEqual({ phase: "awaiting-correction-instruction", patchIndex: 1 });
    result = advanceHandsOnDriver(result.state, scenario, choice("correction"));
    expect(result.actions).toEqual([{ type: "select", choiceId: "correction", optionId: "correction-show" }]);
    result = advanceHandsOnDriver(result.state, scenario, confirmationChoice("correction-confirmation"));
    expect(result.actions).toEqual([
      { type: "apply", patchIndex: 1 },
      { type: "select", choiceId: "correction-confirmation", optionId: "correction-confirmation-confirm" }
    ]);
    expect(result.state).toEqual({ phase: "awaiting-lesson-completion-pause" });
  });

  it("uses a final pause icon as successful delegation completion without loosening intermediate delegation choices", () => {
    const choice = (options: Array<{ id: string; label: string; icon: "show" | "automate" | "pause" }>) => ({ type: "choice" as const, id: "choice", question: "Continue?", options });

    expect(selectDelegationChoice(choice([
      { id: "delegate", label: "Make it for me", icon: "automate" },
      { id: "pause", label: "A label the driver must not parse", icon: "pause" }
    ]))).toEqual({ kind: "delegate", optionId: "delegate" });
    expect(selectDelegationChoice(choice([
      { id: "review", label: "Review the finished factory.sh", icon: "show" },
      { id: "pause", label: "A label the driver must not parse", icon: "pause" }
    ]))).toEqual({ kind: "pause", optionId: "pause" });
    expect(() => selectDelegationChoice(choice([{ id: "other", label: "Automate differently", icon: "automate" }]))).toThrow("unsupported delegation choice");
  });

  it("matches next-step start choices despite straight or curly apostrophes", () => {
    const scenario: Scenario = {
      id: "apostrophe-choice", lesson: "001", mode: "hands-on", description: "Regression fixture",
      patches: [{ name: "complete", files: {}, message: "ignored", preconditions: {}, expectedState: {}, checkpoint: "guided-step" }]
    };
    const choice = {
      type: "choice" as const, id: "typed", question: "Continue?", options: [
        { id: "hands-on", label: "I'll do it", icon: "do" as const },
        { id: "delegate", label: "Make it for me", icon: "automate" as const }
      ]
    };
    const result = advanceHandsOnDriver({ phase: "awaiting-instruction", patchIndex: 0 }, scenario, choice);
    expect(result.actions).toEqual([{ type: "select", choiceId: "typed", optionId: "hands-on" }]);
  });

  it("retries only provider failures and timeouts before model output", () => {
    expect(shouldRetry(new EvalTimeoutError("before output", false))).toBe(true);
    expect(shouldRetry(new EvalTimeoutError("after output", true))).toBe(false);
    expect(shouldRetry(new Error("provider returned 429"))).toBe(true);
  });
});
