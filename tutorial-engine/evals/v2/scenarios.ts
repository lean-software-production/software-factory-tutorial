import { projectV2JudgeTrace, readWorkbookTimeline, snapshotArtifacts } from "./session.js";
import { createV2WorkbookDriver, type V2WorkbookDriver } from "./driver.js";
import type { EvaluationWorkspace, V2ArtifactSnapshot, V2SessionTrace } from "./types.js";

export interface V2GateAssertion { name: string; passed: boolean; detail: string; }
export interface V2GateResult { passed: boolean; assertions: V2GateAssertion[]; }

export type V2ScenarioAction =
  | { type: "complete-introduction" }
  | { type: "continue"; blockId: string }
  | { type: "editor"; blockId: string; text: string }
  | { type: "terminal"; blockId: string; command: string; complete?: boolean; expectedFeedback?: string | RegExp }
  | { type: "reflection-submit"; blockId: string; response: string }
  | { type: "reflection-follow-up"; blockId: string; response: string }
  | { type: "reflection-complete"; blockId: string }
  | { type: "transition"; blockId: string };

export interface V2Scenario {
  id: string;
  title: string;
  description: string;
  criteria: string[];
  actions: V2ScenarioAction[];
  gate: (trace: V2SessionTrace) => V2GateResult;
}

const lessonId = "001-live-session";
export const exactCommand = "mkdir -p factory/.tmp && printf 'command block complete\\n' > factory/.tmp/evaluator-command.txt && cat factory/.tmp/evaluator-command.txt";
export const clueCommand = "mkdir -p factory/.tmp && printf 'clue block complete\\n' > factory/.tmp/evaluator-clue.txt";
export const clueDisplayCommand = "cat factory/.tmp/evaluator-clue.txt";
export const insufficientEditorDraft = "This is a vague draft.";
export const satisfactoryEditorDraft = "editor-artifacts/evaluator-editor.txt: editor practice draft is ready for promotion.\n";

const commonStart: V2ScenarioAction[] = [
  { type: "complete-introduction" },
  { type: "continue", blockId: "orientation" }
];
const editorSuccessActions: V2ScenarioAction[] = [
  ...commonStart,
  { type: "editor", blockId: "editor-practice", text: satisfactoryEditorDraft },
  { type: "continue", blockId: "editor-practice" }
];
const exactCommandActions: V2ScenarioAction[] = [
  ...editorSuccessActions,
  { type: "terminal", blockId: "exact-command", command: exactCommand }
];
const clueOnlyActions: V2ScenarioAction[] = [
  ...exactCommandActions,
  { type: "terminal", blockId: "clue-only", command: clueCommand, complete: false, expectedFeedback: /display|print|read|second command/i },
  { type: "terminal", blockId: "clue-only", command: clueDisplayCommand }
];
const reflectionResponse = "I noticed the two terminal blocks were different, but I need help explaining the distinction and what the evaluator should record.";
const reflectionFollowUp = "The clue-only prompt was public guidance, but the hidden tutor instructions stayed out of the workbook state. The evaluator should record only learner-visible state because hidden guidance was not something the learner could act on; visible state keeps judging grounded in observable prompts and actions.";
const reflectionActions: V2ScenarioAction[] = [
  ...clueOnlyActions,
  { type: "reflection-submit", blockId: "reflection", response: reflectionResponse },
  { type: "reflection-follow-up", blockId: "reflection", response: reflectionFollowUp },
  { type: "reflection-complete", blockId: "reflection" }
];

export const v2Scenarios: V2Scenario[] = [
  {
    id: "v2-exact-command-success",
    title: "Exact command success",
    description: "The learner runs the command that is visibly supplied in the exact-command terminal-practice block.",
    criteria: [
      "The tutor accepts completion only after the exact visible command creates and prints the command artifact.",
      "The tutor response summarizes the evidence without exposing hidden tutor instructions."
    ],
    actions: exactCommandActions,
    gate: gateExactCommandSuccess
  },
  {
    id: "v2-editor-feedback-locked",
    title: "Editor feedback keeps the block locked",
    description: "The learner submits an incomplete editor-practice draft and receives public feedback without unlocking the block.",
    criteria: [
      "The reviewer returns public feedback for an insufficient editor draft.",
      "The editor-practice block stays active and no private editor criteria appear in the trace."
    ],
    actions: [
      ...commonStart,
      { type: "editor", blockId: "editor-practice", text: insufficientEditorDraft }
    ],
    gate: gateEditorFeedbackLocked
  },
  {
    id: "v2-editor-unlocked",
    title: "Editor draft unlocks and promotes",
    description: "The learner submits a satisfactory editor-practice draft, unlocking the block and promoting the artifact.",
    criteria: [
      "The reviewer unlocks only the satisfactory current editor draft.",
      "The promoted artifact snapshot contains the submitted draft under editor-artifacts/."
    ],
    actions: editorSuccessActions,
    gate: gateEditorUnlocked
  },
  {
    id: "v2-clue-only-task",
    title: "Clue-only terminal task",
    description: "The learner completes a terminal-practice block that gives public clues but no insertable command.",
    criteria: [
      "The tutor allows learner-chosen shell syntax when it satisfies the public clue-only goal.",
      "The tutor does not reveal hidden exact-command instructions for the clue-only block."
    ],
    actions: clueOnlyActions,
    gate: gateClueOnlyTask
  },
  {
    id: "v2-reflection-follow-up",
    title: "Reflection follow-up",
    description: "The learner discusses the difference between exact-command and clue-only terminal practice, then answers a follow-up.",
    criteria: [
      "The tutor asks a focused follow-up that checks the distinction between public instructions and hidden tutor instructions.",
      "The tutor uses the recorded practice evidence rather than inventing terminal results."
    ],
    actions: reflectionActions,
    gate: gateReflectionFollowUp
  },
  {
    id: "v2-transition-completion",
    title: "Transition completion",
    description: "The learner finishes the reflection and continues through the lesson transition to complete the evaluator fixture.",
    criteria: [
      "The tutor lets the transition complete only after the terminal and reflection blocks have been completed.",
      "The final report shows the lesson complete and keeps the evaluator artifact snapshot."
    ],
    actions: [
      ...clueOnlyActions,
      { type: "reflection-submit", blockId: "reflection", response: reflectionResponse },
      { type: "reflection-follow-up", blockId: "reflection", response: reflectionFollowUp },
      { type: "reflection-complete", blockId: "reflection" },
      { type: "transition", blockId: "transition" }
    ],
    gate: gateTransitionCompletion
  }
];

export function findV2Scenario(id: string): V2Scenario {
  const scenario = v2Scenarios.find((candidate) => candidate.id === id);
  if (!scenario) throw new Error(`Unknown v2 scenario '${id}'.`);
  return scenario;
}

export function deterministicV2Gate(scenario: V2Scenario, trace: V2SessionTrace): V2GateResult {
  return scenario.gate(trace);
}

export async function runV2ScenarioSession(options: { scenario: V2Scenario; workspace: EvaluationWorkspace; serverUrl: string; trace: V2SessionTrace }): Promise<V2SessionTrace> {
  const driver = createV2WorkbookDriver({ serverUrl: options.serverUrl, trace: options.trace });
  await driveV2Scenario(driver, options.scenario);
  const session = options.workspace.latestSession();
  options.trace.events = await readWorkbookTimeline(session.sessionRoot);
  options.trace.artifacts = await snapshotArtifacts(session.workspaceRoots["refactor-line"]!);
  return options.trace;
}

export async function driveV2Scenario(driver: V2WorkbookDriver, scenario: V2Scenario): Promise<void> {
  for (const action of scenario.actions) {
    if (action.type === "complete-introduction") await driver.completeIntroduction();
    else if (action.type === "continue") await driver.continueBlock(action.blockId);
    else if (action.type === "editor") await driver.submitEditorDraft(action.blockId, action.text);
    else if (action.type === "terminal") await driver.submitTerminalCommand(action.blockId, action.command, { complete: action.complete, expectedFeedback: action.expectedFeedback });
    else if (action.type === "reflection-submit") await driver.submitReflection(action.blockId, action.response);
    else if (action.type === "reflection-follow-up") await driver.submitReflectionFollowUp(action.blockId, action.response);
    else if (action.type === "reflection-complete") await driver.completeReflection(action.blockId);
    else if (action.type === "transition") await driver.continueBlock(action.blockId, `transition:${action.blockId}`);
    else assertNever(action);
  }
}

function gateExactCommandSuccess(trace: V2SessionTrace): V2GateResult {
  return collectAssertions([
    publicStateClean(trace),
    editorUnlocked(trace),
    artifactEquals("editor-artifacts/evaluator-editor.txt", satisfactoryEditorDraft, trace),
    exactCommandInput(trace),
    terminalOutput("exact-command", "command block complete", trace),
    observedAndCompleted("exact-command", trace),
    artifactEquals("factory/.tmp/evaluator-command.txt", "command block complete\n", trace)
  ]);
}

function gateEditorFeedbackLocked(trace: V2SessionTrace): V2GateResult {
  return collectAssertions([
    publicStateClean(trace),
    editorFeedbackVisible(trace),
    editorStillActive(trace),
    editorNotUnlocked(trace)
  ]);
}

function gateEditorUnlocked(trace: V2SessionTrace): V2GateResult {
  return collectAssertions([
    publicStateClean(trace),
    editorUnlocked(trace),
    artifactEquals("editor-artifacts/evaluator-editor.txt", satisfactoryEditorDraft, trace)
  ]);
}

function gateClueOnlyTask(trace: V2SessionTrace): V2GateResult {
  return collectAssertions([
    publicStateClean(trace),
    editorUnlocked(trace),
    artifactEquals("editor-artifacts/evaluator-editor.txt", satisfactoryEditorDraft, trace),
    clueOnlyPublicPrompt(trace),
    learnerChoseClueCommand(trace),
    terminalOutput("clue-only", "clue block complete", trace),
    observedAndCompleted("clue-only", trace),
    artifactEquals("factory/.tmp/evaluator-clue.txt", "clue block complete\n", trace)
  ]);
}

function gateReflectionFollowUp(trace: V2SessionTrace): V2GateResult {
  const turns = trace.reflections.filter((entry) => matchBlockId(entry.blockId, "reflection"));
  const roles = turns.map((entry) => entry.role).join(",");
  const followUpEvent = trace.events.some((event) => event.type === "reflection_follow_up_submitted" && matchBlockId(event.blockId, "reflection"));
  const completed = trace.events.some((event) => event.type === "block_completed" && matchBlockId(event.blockId, "reflection"));
  return collectAssertions([
    publicStateClean(trace),
    {
      name: "reflection follow-up",
      passed: roles === "learner,tutor,learner,tutor" && followUpEvent,
      detail: `roles=${roles || "none"}, follow-up event=${followUpEvent}`
    },
    {
      name: "reflection completed",
      passed: completed,
      detail: completed ? "Reflection block completed after tutor conversation." : "Reflection block was not completed."
    }
  ]);
}

function gateTransitionCompletion(trace: V2SessionTrace): V2GateResult {
  const transitionEvent = trace.events.some((event) => event.type === "block_completed" && matchBlockId(event.blockId, "transition"));
  const completedProjection = trace.publicStates.some((state) => stateIncludesCompletedLesson(state.state));
  return collectAssertions([
    publicStateClean(trace),
    observedAndCompleted("exact-command", trace),
    observedAndCompleted("clue-only", trace),
    {
      name: "transition event",
      passed: transitionEvent,
      detail: transitionEvent ? "Transition block was continued." : "No transition completion event was recorded."
    },
    {
      name: "transition completed",
      passed: completedProjection,
      detail: completedProjection ? "Public projection marks the evaluator lesson complete." : "No public projection marks the evaluator lesson complete."
    },
    artifactEquals("factory/.tmp/evaluator-command.txt", "command block complete\n", trace),
    artifactEquals("factory/.tmp/evaluator-clue.txt", "clue block complete\n", trace)
  ]);
}


function editorFeedbackVisible(trace: V2SessionTrace): V2GateAssertion {
  const feedback = trace.publicStates
    .flatMap((state) => publicEditorBlocks(state.state))
    .flatMap((candidate) => candidate.editorStatus === "feedback" ? [publicEditorFeedback(candidate)] : [])
    .find((text) => text.length > 0) ?? "";
  return { name: "editor feedback visible", passed: feedback.length > 0, detail: feedback || "No public editor feedback state was recorded." };
}

function publicEditorFeedback(block: { checkpoint?: unknown }): string {
  const checkpoint = block.checkpoint;
  if (!checkpoint || typeof checkpoint !== "object") return "";
  const { status, feedback } = checkpoint as { status?: unknown; feedback?: unknown };
  if (status !== "feedback") return "";
  return typeof feedback === "string" ? feedback.trim() : "";
}

function publicEditorBlocks(state: unknown): Array<{ editorStatus?: unknown; checkpoint?: unknown }> {
  const blocks = (state as { progress?: { blocks?: unknown } })?.progress?.blocks;
  return Array.isArray(blocks) ? blocks.filter((block): block is { editorStatus?: unknown; checkpoint?: unknown } => typeof block === "object" && block !== null) : [];
}

function editorStillActive(trace: V2SessionTrace): V2GateAssertion {
  const active = trace.publicStates.some((state) => stateContainsActiveBlock(state.state, "editor-practice"));
  return { name: "editor remains active", passed: active, detail: active ? "Editor-practice remained the active block." : "No public state kept editor-practice active." };
}

function editorNotUnlocked(trace: V2SessionTrace): V2GateAssertion {
  const unlocked = trace.events.some((event) => event.type === "attempt_accepted" && event.kind === "editor" && matchBlockId(event.blockId, "editor-practice"));
  return { name: "editor not unlocked", passed: !unlocked, detail: unlocked ? "Editor-practice unlocked after insufficient feedback." : "No unlock event was recorded." };
}

function editorUnlocked(trace: V2SessionTrace): V2GateAssertion {
  const acceptedAttempt = trace.events.find((candidate) => candidate.type === "attempt_accepted" && candidate.kind === "editor" && matchBlockId(candidate.blockId, "editor-practice"));
  const accepted = validAcceptedAttempt(acceptedAttempt, "editor");
  const completed = trace.publicStates.some((state) => stateContainsCompletedBlock(state.state, "editor-practice"));
  const recordedUnlockedRevision = trace.editors.some((entry) => matchBlockId(entry.blockId, "editor-practice") && entry.revision === 1 && entry.status === "unlocked");
  const promotedArtifact = trace.artifacts.some((item) => item.path === "editor-artifacts/evaluator-editor.txt");
  const passed = accepted.valid && completed && recordedUnlockedRevision && promotedArtifact;
  const detail = `accepted=${Boolean(acceptedAttempt)}, attemptId=${accepted.hasAttemptId}, version=${accepted.hasVersion}, summary=${accepted.hasSummary}, revision=${recordedUnlockedRevision}, artifact=${promotedArtifact}, completed=${completed}`;
  return { name: "editor unlocked", passed, detail };
}

function publicStateClean(trace: V2SessionTrace): V2GateAssertion {
  try {
    const projected = projectV2JudgeTrace(trace);
    const hasRawEvents = "events" in (projected as unknown as Record<string, unknown>);
    return { name: "checked trace uses projected judge structure", passed: !hasRawEvents, detail: hasRawEvents ? "Projected judge trace unexpectedly retained raw events." : "Trace projects to the public judge structure without raw event storage." };
  } catch (error) {
    return { name: "checked trace uses projected judge structure", passed: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function exactCommandInput(trace: V2SessionTrace): V2GateAssertion {
  const input = trace.terminalTranscript.find((entry) => matchBlockId(entry.blockId, "exact-command") && entry.direction === "input")?.text.trim();
  return { name: "exact command input", passed: input === exactCommand, detail: input ? `input=${input}` : "No exact-command input was recorded." };
}

function learnerChoseClueCommand(trace: V2SessionTrace): V2GateAssertion {
  const input = trace.terminalTranscript.find((entry) => matchBlockId(entry.blockId, "clue-only") && entry.direction === "input")?.text.trim() ?? "";
  const passed = input.length > 0 && input !== exactCommand && /factory\/\.tmp\/evaluator-clue\.txt/.test(input);
  return { name: "clue-only learner command", passed, detail: input || "No clue-only input was recorded." };
}

function clueOnlyPublicPrompt(trace: V2SessionTrace): V2GateAssertion {
  const prompt = trace.publicStates.map((state) => publicBlockMarkdown(state.state, "clue-only")).find((text) => text.length > 0) ?? "";
  const hasExpectedPath = prompt.includes("factory/.tmp/evaluator-clue.txt");
  const exposesCanonicalCommand = prompt.includes(clueCommand);
  const passed = hasExpectedPath && !exposesCanonicalCommand;
  const detail = !hasExpectedPath
    ? "Public clue-only prompt is missing the expected clue."
    : exposesCanonicalCommand
      ? "Public clue-only prompt exposes the canonical solution command."
      : "Public clue-only prompt includes the expected learner-visible clue without the canonical solution command.";
  return { name: "clue-only public prompt", passed, detail };
}

function publicBlockMarkdown(value: unknown, blockId: string): string {
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = publicBlockMarkdown(item, blockId);
      if (found) return found;
    }
    return "";
  }
  const object = value as Record<string, unknown>;
  if (matchBlockId(object.id, blockId) && typeof object.markdown === "string") return object.markdown;
  for (const item of Object.values(object)) {
    const found = publicBlockMarkdown(item, blockId);
    if (found) return found;
  }
  return "";
}

function terminalOutput(blockId: string, expected: string, trace: V2SessionTrace): V2GateAssertion {
  const output = trace.terminalTranscript.filter((entry) => matchBlockId(entry.blockId, blockId) && entry.direction === "output").map((entry) => entry.text).join("\n");
  return { name: `${blockId} terminal output`, passed: output.includes(expected), detail: output || `No ${blockId} terminal output was recorded.` };
}

function observedAndCompleted(blockId: string, trace: V2SessionTrace): V2GateAssertion {
  const acceptedAttempt = trace.events.find((event) => event.type === "attempt_accepted" && event.kind === "terminal" && matchBlockId(event.blockId, blockId));
  const accepted = validAcceptedAttempt(acceptedAttempt, "terminal");
  const completed = trace.events.some((event) => event.type === "block_completed" && matchBlockId(event.blockId, blockId));
  return { name: `${blockId} verified completion`, passed: accepted.valid && completed, detail: `accepted=${Boolean(acceptedAttempt)}, attemptId=${accepted.hasAttemptId}, version=${accepted.hasVersion}, summary=${accepted.hasSummary}, completed=${completed}` };
}

function validAcceptedAttempt(event: V2SessionTrace["events"][number] | undefined, kind: "editor" | "terminal"): { valid: boolean; hasAttemptId: boolean; hasVersion: boolean; hasSummary: boolean } {
  const hasAttemptId = event?.type === "attempt_accepted" && typeof event.attemptId === "string" && event.attemptId.length > 0;
  const hasVersion = event?.type === "attempt_accepted" && Number.isInteger(event.version) && event.version > 0;
  const hasSummary = event?.type === "attempt_accepted" && typeof event.summary === "string" && event.summary.trim().length > 0;
  return { valid: Boolean(event?.type === "attempt_accepted" && event.kind === kind && hasAttemptId && hasVersion && hasSummary), hasAttemptId, hasVersion, hasSummary };
}

function artifactEquals(path: string, content: string, trace: V2SessionTrace): V2GateAssertion {
  const artifact = trace.artifacts.find((item: V2ArtifactSnapshot) => item.path === path);
  return { name: `${path} artifact`, passed: artifact?.content === content, detail: artifact ? `${path}=${JSON.stringify(artifact.content)}` : `${path} was not snapshotted.` };
}


function stateContainsActiveBlock(value: unknown, blockId: string): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => stateContainsActiveBlock(item, blockId));
  const object = value as Record<string, unknown>;
  if (matchBlockId(object.id, blockId) && object.active === true) return true;
  return Object.values(object).some((item) => stateContainsActiveBlock(item, blockId));
}

function stateContainsCompletedBlock(value: unknown, blockId: string): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => stateContainsCompletedBlock(item, blockId));
  const object = value as Record<string, unknown>;
  if (matchBlockId(object.id, blockId) && object.completed === true) return true;
  return Object.values(object).some((item) => stateContainsCompletedBlock(item, blockId));
}

function matchBlockId(value: unknown, expected: string): boolean {
  return typeof value === "string" && (value === expected || value.endsWith(`--${expected}`));
}

function stateIncludesCompletedLesson(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(stateIncludesCompletedLesson);
  const object = value as Record<string, unknown>;
  const progress = object.progress;
  if (progress && typeof progress === "object" && Array.isArray((progress as { completedLessons?: unknown }).completedLessons) && (progress as { completedLessons: unknown[] }).completedLessons.includes(lessonId)) return true;
  return Object.values(object).some(stateIncludesCompletedLesson);
}

function collectAssertions(assertions: V2GateAssertion[]): V2GateResult {
  return { passed: assertions.every((assertion) => assertion.passed), assertions };
}

function assertNever(value: never): never {
  throw new Error(`Unsupported v2 scenario action ${(value as { type?: string }).type ?? "unknown"}.`);
}
