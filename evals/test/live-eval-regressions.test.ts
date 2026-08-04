import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deterministicGate } from "../harness/assertions.js";
import { activateLesson, applyCanonicalPatch, matchesArtifactState } from "../harness/workspace.js";
import { advanceHandsOnDriver, beginHandsOnDriver, EvalTimeoutError, foldSnapshotEvents, selectDelegationChoice } from "../harness/session.js";
import { shouldRetry } from "../harness/retry.js";
import { scenarios, type Scenario } from "../scenarios/lesson-001/scenarios.js";
import { lesson002Scenarios } from "../scenarios/lesson-002/scenarios.js";
import { lesson003Scenarios } from "../scenarios/lesson-003/scenarios.js";
import { lesson004Scenarios } from "../scenarios/lesson-004/scenarios.js";
import { lesson005Scenarios } from "../scenarios/lesson-005/scenarios.js";
import { lesson006Scenarios } from "../scenarios/lesson-006/scenarios.js";
import { loadActiveSpec } from "../harness/judge.js";
import type { SessionTrace } from "../harness/session.js";
import { loadLesson } from "../../tutorial-engine/src/lesson/load.js";

const allScenarios = [...scenarios, ...lesson002Scenarios, ...lesson003Scenarios, ...lesson004Scenarios, ...lesson005Scenarios, ...lesson006Scenarios];
const mistakeScenarios = allScenarios.filter((scenario) => scenario.mode === "mistake");

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
      { type: "audit", id: "read-1", tool: "read", paths: [Object.keys(scenario.patches.find((patch) => patch.name === "defect")?.files ?? {})[0] ?? "factory/run.sh"], mutation: false, outcome: "ok" },
      { type: "choice", id: "correction-choice", question: "Correct it?", options: [{ id: "confirm", label: "I’ve made this step", icon: "confirm" }] }
    ]
  };
}

describe("live-eval regression coverage", () => {
  it.each(mistakeScenarios)("records scenario-specific defect and repair evidence for $id", { timeout: 30000 }, async (scenario) => {
    const defect = scenario.patches.find((patch) => patch.name === "defect")!;
    const repair = scenario.patches.find((patch) => patch.name === "repair")!;
    expect(matchesArtifactState(defect.files, defect.expectedState)).toBe(true);
    expect(matchesArtifactState(repair.files, repair.expectedState)).toBe(true);

    const workspace = await mkdtemp(join(tmpdir(), "eval-gate-"));
    try {
      const finalFiles = Object.assign({}, ...scenario.patches.map((patch) => patch.files)) as Record<string, string>;
      await applyCanonicalPatch(workspace, { name: "final", files: finalFiles, preconditions: {}, expectedState: scenario.finalState ?? {} });
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

  it("splits the learner-led doer into canonical atomic edits", () => {
    const happy = lesson002Scenarios.find((scenario) => scenario.id === "doer-learner-led-happy-path")!;
    expect(happy.patches.map((patch) => patch.name)).toEqual(["prompt", "invoke"]);
    expect(happy.patches.every((patch) => Object.keys(patch.files).length === 1)).toBe(true);
  });

  it("covers all six lessons, and grades the two that build nothing by transcript alone", () => {
    expect([...new Set(allScenarios.map((scenario) => scenario.lesson))].sort()).toEqual(["001", "002", "003", "004", "005", "006"]);
    for (const scenario of allScenarios.filter((item) => item.lesson === "001" || item.lesson === "004")) {
      expect(scenario.patches, scenario.id).toEqual([]);
      expect(scenario.finalState, scenario.id).toBeUndefined();
      expect(scenario.description.length, scenario.id).toBeGreaterThan(80);
    }
  });

  it.each(allScenarios.filter((scenario) => scenario.patches.length))("applies every canonical patch of $id in order, landing on its final state", async (scenario) => {
    // Nothing typechecks these modules, and no other test exercises a patch's
    // preconditions, so a stale ordering would otherwise pass silently.
    const workspace = await mkdtemp(join(tmpdir(), "eval-chain-"));
    try {
      for (const patch of scenario.patches) await applyCanonicalPatch(workspace, patch);
      if (!scenario.finalState) return;
      const files: Record<string, string> = {};
      for (const path of Object.keys(scenario.finalState)) {
        try { files[path] = await readFile(join(workspace, path), "utf8"); } catch { /* absence is checked by matchesArtifactState */ }
      }
      expect(matchesArtifactState(files, scenario.finalState)).toBe(true);
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });

  it("keeps success.md a finalState key of every lesson-005 scenario that has one", () => {
    // The gate reads the criteria out of the files it loaded from finalState's
    // keys, so dropping the key would grade an empty string, not the artefact.
    for (const scenario of allScenarios.filter((item) => item.lesson === "005" && item.finalState)) {
      expect(Object.keys(scenario.finalState!), scenario.id).toContain("factory/refactor/success.md");
    }
  });

  it("activates the declared lesson only in the disposable workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "eval-lesson-"));
    const ledger = "| Iteration | Goal | Status |\n| --- | --- | --- |\n| [001](001-invoke-a-doer.md) | One | Todo |\n| [002](002-review-a-doer.md) | Two | Todo |\n";
    await writeFile(join(workspace, "README.md"), "# Test\n");
    await (await import("node:fs/promises")).mkdir(join(workspace, "docs/specs"), { recursive: true });
    await writeFile(join(workspace, "docs/specs/README.md"), ledger);
    try {
      await activateLesson(workspace, "002");
      const activated = await readFile(join(workspace, "docs/specs/README.md"), "utf8");
      expect(activated).toContain("[001](001-invoke-a-doer.md) | One | Done");
      expect(activated).toContain("[002](002-review-a-doer.md) | Two | Todo");
      await writeFile(join(workspace, "docs/specs/001-invoke-a-doer.md"), "obsolete inactive spec", "utf8");
      await writeFile(join(workspace, "docs/specs/002-review-a-doer.md"), "# Active review spec", "utf8");
      await expect(loadActiveSpec(workspace, "002")).resolves.toBe("# Active review spec");
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
      { id: "review", label: "Review the finished run.sh", icon: "show" },
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

/**
 * Per-lesson deterministic gates. Each lesson is graded against the script that
 * lesson actually builds, so every branch below runs the canonical script from
 * its specification through the stubbed factory.
 */

const canonicalDoScript = `#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
echo "Recording quality baseline..."
(cd ../calculator && node scripts/quality.mjs) > refactor-quality-before.txt || true
echo "Starting doer..."
cat refactor.md | (cd ../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)
`;

const canonicalValidateScript = `#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
if [ ! -f refactor-quality-before.txt ]; then
  echo "No quality baseline. Run ./refactor-do.sh first." >&2
  exit 1
fi
echo "Starting validation..."
cat refactor-validate.md refactor-quality-before.txt \\
  | (cd ../calculator && pi --no-session --tools read,grep,find,ls,bash -p) \\
  | tee refactor-validate-findings.txt
`;

const canonicalLineScript = `#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
while true; do
  echo "Recording quality baseline..."
  (cd ../../calculator && node scripts/quality.mjs) > quality-before.txt || true
  echo "Starting doer..."
  cat refactor.md success.md | (cd ../../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)
  echo "Starting validation..."
  cat validate.md success.md quality-before.txt \\
    | (cd ../../calculator && pi --no-session --tools read,grep,find,ls,bash -p) \\
    | tee validate-findings.txt
  read -r -p "Press Enter for the next iteration, or Ctrl-C to stop. "
done
`;

const canonicalRoutingScript = canonicalLineScript.replace(
  `  read -r -p`,
  `  verdict=$(grep -m1 -o '^VERDICT: \\(PASS\\|FAIL\\)' validate-findings.txt || echo "VERDICT: FAIL")
  if [ "$verdict" = "VERDICT: FAIL" ]; then
    echo "Starting repair..."
    cat repair.md success.md validate-findings.txt \\
      | (cd ../../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)
  fi
  read -r -p`
);

const canonicalSuccess = `# Success criteria

These criteria describe the destination for many small refactorings, not a checklist for one turn.

1. Passes its tests. Evidence: \`npm test\` from \`calculator/\`.
2. Reveals intention. Evidence: the diff reads with clearer names.
3. No duplication. Evidence: \`grep -n\` puts the repeated passages side by side.
4. Fewest elements. Evidence: \`node scripts/quality.mjs\`.
`;

const gateScenario = (lesson: string, mode: "delegate" | "hands-on", finalState?: Scenario["finalState"]): Scenario =>
  ({ id: `gate-${lesson}-${mode}`, lesson, mode, description: "Deterministic gate fixture", patches: [], finalState } as unknown as Scenario);

const emptyTrace = (): SessionTrace => ({
  startedAt: "", endedAt: "", messages: [], snapshots: {},
  events: [
    { type: "snapshot", title: "Test", runState: "idle", events: [], validationCommands: [], progress: [] },
    { type: "choice", id: "choice-1", question: "Continue?", options: [{ id: "hands-on", label: "I’ll do it", icon: "do" }] }
  ]
});

async function workspaceWith(files: Record<string, string>): Promise<string> {
  const { mkdir } = await import("node:fs/promises");
  const workspace = await mkdtemp(join(tmpdir(), "eval-lesson-gate-"));
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(workspace, path, ".."), { recursive: true });
    await writeFile(join(workspace, path), contents);
  }
  return workspace;
}

const named = (gate: Awaited<ReturnType<typeof deterministicGate>>, name: string) =>
  gate.assertions.filter((assertion) => assertion.name === name);
const passed = (gate: Awaited<ReturnType<typeof deterministicGate>>, name: string) => {
  const matches = named(gate, name);
  expect(matches.length, `expected an assertion named "${name}", got: ${gate.assertions.map((assertion) => assertion.name).join(", ")}`).toBeGreaterThan(0);
  return matches.every((assertion) => assertion.passed) || matches.map((assertion) => `${assertion.name}: ${assertion.detail}`).join(" | ");
};

describe("deterministicGate lesson routing", () => {
  it("expects no factory script for lesson 001", async () => {
    const gate = await deterministicGate(gateScenario("001", "hands-on"), "/nonexistent", emptyTrace());
    expect(named(gate, "factory artifact")).toHaveLength(0);
    expect(named(gate, "factory syntax")).toHaveLength(0);
  });

  it("expects no factory script for lesson 004, which builds nothing of its own", async () => {
    const gate = await deterministicGate(gateScenario("004", "hands-on"), "/nonexistent", emptyTrace());
    expect(named(gate, "factory artifact")).toHaveLength(0);
    expect(named(gate, "factory syntax")).toHaveLength(0);
  });

  it.each([
    ["002", "factory/refactor-do.sh"],
    ["003", "factory/refactor-validate.sh"],
    ["005", "factory/refactor/run.sh"],
    ["006", "factory/refactor/run.sh"]
  ])("reports the missing lesson %s script by its own path", async (lesson, path) => {
    const gate = await deterministicGate(gateScenario(lesson, "hands-on"), "/nonexistent", emptyTrace());
    expect(gate.assertions.find((assertion) => assertion.name === "factory artifact")?.detail).toContain(path);
  });
});

describe("deterministicGate per-lesson factory assertions", () => {
  it("grades the lesson 002 doer script", async () => {
    const workspace = await workspaceWith({ "factory/refactor-do.sh": canonicalDoScript, "factory/refactor.md": "job\n" });
    try {
      const gate = await deterministicGate(gateScenario("002", "hands-on"), workspace, emptyTrace());
      for (const name of ["factory syntax", "one-shot doer invocation", "baseline announcement", "baseline recorded", "doer announcement", "doer tool boundary"]) {
        expect(passed(gate, name)).toBe(true);
      }
      expect(named(gate, "validation announcement")).toHaveLength(0);
    } finally { await rm(workspace, { recursive: true, force: true }); }
  }, 30000);

  it("fails the lesson 002 gate when the doer keeps its shell tool", async () => {
    const workspace = await workspaceWith({
      "factory/refactor-do.sh": canonicalDoScript.replace("read,edit,write,grep,find,ls", "read,edit,write,grep,find,ls,bash"),
      "factory/refactor.md": "job\n"
    });
    try {
      const gate = await deterministicGate(gateScenario("002", "hands-on"), workspace, emptyTrace());
      expect(passed(gate, "doer tool boundary")).not.toBe(true);
    } finally { await rm(workspace, { recursive: true, force: true }); }
  }, 30000);

  it("fails the lesson 002 gate when the baseline lands under another name", async () => {
    const workspace = await workspaceWith({
      "factory/refactor-do.sh": canonicalDoScript.replace(/refactor-quality-before\.txt/, "quality-before.txt"),
      "factory/refactor.md": "job\n"
    });
    try {
      const gate = await deterministicGate(gateScenario("002", "hands-on"), workspace, emptyTrace());
      expect(passed(gate, "baseline recorded")).not.toBe(true);
      expect(passed(gate, "doer tool boundary")).toBe(true);
    } finally { await rm(workspace, { recursive: true, force: true }); }
  }, 30000);

  it("fails the lesson 002 gate when the baseline is recorded after the doer", async () => {
    const lines = canonicalDoScript.trimEnd().split("\n");
    const reordered = [...lines.slice(0, 4), ...lines.slice(6), ...lines.slice(4, 6), ""].join("\n");
    const workspace = await workspaceWith({ "factory/refactor-do.sh": reordered, "factory/refactor.md": "job\n" });
    try {
      const gate = await deterministicGate(gateScenario("002", "hands-on"), workspace, emptyTrace());
      expect(passed(gate, "baseline announcement")).toBe(true);
      expect(passed(gate, "baseline recorded")).not.toBe(true);
    } finally { await rm(workspace, { recursive: true, force: true }); }
  }, 30000);

  it("fails the lesson 002 gate when the script spends a second doer turn", async () => {
    const workspace = await workspaceWith({
      "factory/refactor-do.sh": `${canonicalDoScript}cat refactor.md | (cd ../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)\n`,
      "factory/refactor.md": "job\n"
    });
    try {
      const gate = await deterministicGate(gateScenario("002", "hands-on"), workspace, emptyTrace());
      expect(passed(gate, "one-shot doer invocation")).not.toBe(true);
      expect(passed(gate, "doer tool boundary")).toBe(true);
    } finally { await rm(workspace, { recursive: true, force: true }); }
  }, 30000);

  it("grades the lesson 003 validator script, including its missing-baseline guard", async () => {
    const workspace = await workspaceWith({ "factory/refactor-validate.sh": canonicalValidateScript });
    try {
      const gate = await deterministicGate(gateScenario("003", "hands-on"), workspace, emptyTrace());
      for (const name of ["factory syntax", "validation announcement", "validator evidence boundary", "findings saved", "missing baseline guard"]) {
        expect(passed(gate, name)).toBe(true);
      }
    } finally { await rm(workspace, { recursive: true, force: true }); }
  }, 30000);

  it("fails the lesson 003 gate when the baseline guard is dropped", async () => {
    const workspace = await workspaceWith({
      "factory/refactor-validate.sh": canonicalValidateScript.replace(/if \[ ! -f[\s\S]*?fi\n/, "")
    });
    try {
      const gate = await deterministicGate(gateScenario("003", "hands-on"), workspace, emptyTrace());
      expect(passed(gate, "validator evidence boundary")).toBe(true);
      expect(passed(gate, "missing baseline guard")).not.toBe(true);
    } finally { await rm(workspace, { recursive: true, force: true }); }
  }, 30000);

  it("grades the lesson 005 assembly line and its success criteria", async () => {
    const workspace = await workspaceWith({ "factory/refactor/run.sh": canonicalLineScript, "factory/refactor/success.md": canonicalSuccess });
    try {
      const gate = await deterministicGate(
        gateScenario("005", "hands-on", { "factory/refactor/success.md": { exists: true } }),
        workspace,
        emptyTrace()
      );
      for (const name of ["factory syntax", "loop pause", "iteration turns", "line roles", "shared success criteria", "findings saved", "success.md simple-design strategy"]) {
        expect(passed(gate, name)).toBe(true);
      }
      expect(named(gate, "failed verdict routes to repair")).toHaveLength(0);
    } finally { await rm(workspace, { recursive: true, force: true }); }
  }, 30000);

  it("fails the lesson 005 gate when the line never pauses for the learner", async () => {
    const workspace = await workspaceWith({
      "factory/refactor/run.sh": canonicalLineScript.replace(/  read -r -p .*\n/, "  break\n")
    });
    try {
      const gate = await deterministicGate(gateScenario("005", "hands-on"), workspace, emptyTrace());
      expect(passed(gate, "loop pause")).not.toBe(true);
    } finally { await rm(workspace, { recursive: true, force: true }); }
  }, 30000);

  it("fails the lesson 005 gate when the doer is not handed the criteria", async () => {
    const workspace = await workspaceWith({
      "factory/refactor/run.sh": canonicalLineScript.replace("cat refactor.md success.md |", "cat refactor.md |")
    });
    try {
      const gate = await deterministicGate(gateScenario("005", "hands-on"), workspace, emptyTrace());
      expect(passed(gate, "shared success criteria")).not.toBe(true);
      expect(passed(gate, "line roles")).toBe(true);
    } finally { await rm(workspace, { recursive: true, force: true }); }
  }, 30000);

  it("grades the lesson 006 verdict branch", async () => {
    const workspace = await workspaceWith({ "factory/refactor/run.sh": canonicalRoutingScript });
    try {
      const gate = await deterministicGate(gateScenario("006", "hands-on"), workspace, emptyTrace());
      for (const name of ["factory syntax", "loop pause", "iteration turns", "line roles", "shared success criteria", "findings saved", "anchored verdict parse", "failed verdict routes to repair", "repair carries the findings", "repair tool boundary"]) {
        expect(passed(gate, name)).toBe(true);
      }
      expect(gate.stub?.callsBeforeEnter).toBe(3);
      expect(gate.stub?.reportBeforeEnter).toContain("VERDICT: FAIL");
    } finally { await rm(workspace, { recursive: true, force: true }); }
  }, 30000);

  it("fails the lesson 006 gate when the verdict pattern loses its anchor", async () => {
    const workspace = await workspaceWith({ "factory/refactor/run.sh": canonicalRoutingScript.replace("'^VERDICT:", "'VERDICT:") });
    try {
      const gate = await deterministicGate(gateScenario("006", "hands-on"), workspace, emptyTrace());
      expect(passed(gate, "anchored verdict parse")).not.toBe(true);
      expect(passed(gate, "failed verdict routes to repair")).toBe(true);
    } finally { await rm(workspace, { recursive: true, force: true }); }
  }, 30000);

  it("fails the lesson 006 gate when a failing verdict starts no repair", async () => {
    const workspace = await workspaceWith({ "factory/refactor/run.sh": canonicalLineScript });
    try {
      const gate = await deterministicGate(gateScenario("006", "hands-on"), workspace, emptyTrace());
      expect(passed(gate, "failed verdict routes to repair")).not.toBe(true);
      expect(passed(gate, "iteration turns")).not.toBe(true);
    } finally { await rm(workspace, { recursive: true, force: true }); }
  }, 30000);
});

describe("deterministicGate delegated file scope", () => {
  const scopeFiles: Record<string, string[]> = {
    "001": [],
    "002": ["factory/refactor-do.sh", "factory/refactor-quality-before.txt", "factory/refactor.md"],
    "003": ["factory/refactor-do.sh", "factory/refactor-quality-before.txt", "factory/refactor-validate-findings.txt", "factory/refactor-validate.md", "factory/refactor-validate.sh", "factory/refactor.md"],
    "004": ["factory/refactor-do.sh", "factory/refactor-quality-before.txt", "factory/refactor-validate-findings.txt", "factory/refactor-validate.md", "factory/refactor-validate.sh", "factory/refactor.md"],
    "005": ["factory/refactor/do.sh", "factory/refactor/quality-before.txt", "factory/refactor/refactor.md", "factory/refactor/run.sh", "factory/refactor/success.md", "factory/refactor/validate-findings.txt", "factory/refactor/validate.md", "factory/refactor/validate.sh"],
    "006": ["factory/refactor/do.sh", "factory/refactor/quality-before.txt", "factory/refactor/refactor.md", "factory/refactor/repair.md", "factory/refactor/run.sh", "factory/refactor/success.md", "factory/refactor/validate-findings.txt", "factory/refactor/validate.md", "factory/refactor/validate.sh"]
  };

  it.each(Object.keys(scopeFiles))("accepts exactly what lesson %s leaves behind", async (lesson) => {
    const { mkdir } = await import("node:fs/promises");
    const workspace = await workspaceWith(Object.fromEntries(scopeFiles[lesson]!.map((path) => [path, "placeholder\n"])));
    try {
      await mkdir(join(workspace, "factory"), { recursive: true });
      const gate = await deterministicGate(gateScenario(lesson, "delegate"), workspace, emptyTrace());
      expect(passed(gate, "delegated file scope")).toBe(true);
    } finally { await rm(workspace, { recursive: true, force: true }); }
  }, 30000);

  it("rejects a stray file the lesson never asked for", async () => {
    const workspace = await workspaceWith({ ...Object.fromEntries(scopeFiles["002"]!.map((path) => [path, "placeholder\n"])), "factory/notes.md": "stray\n" });
    try {
      const gate = await deterministicGate(gateScenario("002", "delegate"), workspace, emptyTrace());
      const scope = named(gate, "delegated file scope");
      expect(scope.some((assertion) => !assertion.passed && assertion.detail.includes("notes.md"))).toBe(true);
    } finally { await rm(workspace, { recursive: true, force: true }); }
  }, 30000);

  it("rejects last lesson's findings left beside the line's folder", async () => {
    const workspace = await workspaceWith({ ...Object.fromEntries(scopeFiles["005"]!.map((path) => [path, "placeholder\n"])), "factory/refactor-validate-findings.txt": "stale\n" });
    try {
      const gate = await deterministicGate(gateScenario("005", "delegate"), workspace, emptyTrace());
      const scope = named(gate, "delegated file scope");
      expect(scope.some((assertion) => !assertion.passed && assertion.detail.includes("refactor-validate-findings.txt"))).toBe(true);
    } finally { await rm(workspace, { recursive: true, force: true }); }
  }, 30000);
});
