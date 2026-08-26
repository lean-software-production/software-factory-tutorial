import { readWorkbookTimeline, snapshotArtifacts } from "./session.js";
import { createV2WorkbookDriver, type V2WorkbookDriver } from "./driver.js";
import type { EvaluationWorkspace, V2ArtifactSnapshot, V2SessionTrace } from "./types.js";

export interface V2GateAssertion { name: string; passed: boolean; detail: string; }
export interface V2GateResult { passed: boolean; assertions: V2GateAssertion[]; }

export type V2ScenarioAction =
  | { type: "complete-introduction" }
  | { type: "continue"; blockId: string }
  | { type: "editor"; blockId: string; text: string }
  | { type: "terminal"; blockId: string; command: string; complete?: boolean }
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
export const clueCommand = "mkdir -p factory/.tmp && printf 'clue block complete\\n' > factory/.tmp/evaluator-clue.txt && cat factory/.tmp/evaluator-clue.txt";
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
  { type: "terminal", blockId: "clue-only", command: clueCommand }
];
const reflectionResponse = "The exact-command block gave me a shell command. The clue-only block gave me the goal and made me choose the command.";
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
  options.trace.artifacts = await snapshotArtifacts(session.workspaceRoot);
  return options.trace;
}

export async function driveV2Scenario(driver: V2WorkbookDriver, scenario: V2Scenario): Promise<void> {
  for (const action of scenario.actions) {
    if (action.type === "complete-introduction") await driver.completeIntroduction();
    else if (action.type === "continue") await driver.continueBlock(action.blockId);
    else if (action.type === "editor") await driver.submitEditorDraft(action.blockId, action.text);
    else if (action.type === "terminal") await driver.submitTerminalCommand(action.blockId, action.command, { complete: action.complete });
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
  const completed = trace.events.some((event) => (event.type === "reflection_completed" || event.type === "block_completed") && matchBlockId(event.blockId, "reflection"));
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
  const transitionEvent = trace.events.some((event) => (event.type === "block_continued" || event.type === "lesson_transitioned" || event.type === "block_completed") && matchBlockId(event.blockId, "transition"));
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
  const block = trace.publicStates
    .flatMap((state) => publicEditorBlocks(state.state))
    .find((candidate): candidate is { editorStatus: "feedback"; feedback: string } => candidate.editorStatus === "feedback" && typeof candidate.feedback === "string" && candidate.feedback.trim().length > 0);
  const feedback = block?.feedback ?? "";
  return { name: "editor feedback visible", passed: feedback.length > 0, detail: feedback || "No public editor feedback state was recorded." };
}

function publicEditorBlocks(state: unknown): Array<{ editorStatus?: unknown; feedback?: unknown }> {
  const blocks = (state as { progress?: { blocks?: unknown } })?.progress?.blocks;
  return Array.isArray(blocks) ? blocks.filter((block): block is { editorStatus?: unknown; feedback?: unknown } => typeof block === "object" && block !== null) : [];
}

function editorStillActive(trace: V2SessionTrace): V2GateAssertion {
  const active = trace.publicStates.some((state) => stateContainsActiveBlock(state.state, "editor-practice"));
  return { name: "editor remains active", passed: active, detail: active ? "Editor-practice remained the active block." : "No public state kept editor-practice active." };
}

function editorNotUnlocked(trace: V2SessionTrace): V2GateAssertion {
  const unlocked = trace.events.some((event) => (event.type === "editor_practice_unlocked" || (event.type === "attempt_accepted" && event.kind === "editor")) && matchBlockId(event.blockId, "editor-practice"));
  return { name: "editor not unlocked", passed: !unlocked, detail: unlocked ? "Editor-practice unlocked after insufficient feedback." : "No unlock event was recorded." };
}

function editorUnlocked(trace: V2SessionTrace): V2GateAssertion {
  const legacyUnlock = trace.events.find((candidate): candidate is Extract<V2SessionTrace["events"][number], { type: "editor_practice_unlocked" }> => candidate.type === "editor_practice_unlocked" && matchBlockId(candidate.blockId, "editor-practice"));
  const acceptedAttempt = trace.events.find((candidate) => candidate.type === "attempt_accepted" && candidate.kind === "editor" && matchBlockId(candidate.blockId, "editor-practice"));
  const completed = trace.publicStates.some((state) => stateContainsCompletedBlock(state.state, "editor-practice"));
  const recordedUnlockedRevision = trace.editors.some((entry) => matchBlockId(entry.blockId, "editor-practice") && entry.revision === 1 && entry.status === "unlocked");
  const promotedArtifact = trace.artifacts.some((item) => item.path === "editor-artifacts/evaluator-editor.txt");
  const legacyPassed = legacyUnlock?.revisionId === 1 && legacyUnlock.path === "editor-artifacts/evaluator-editor.txt";
  const attemptPassed = Boolean(acceptedAttempt && recordedUnlockedRevision && promotedArtifact);
  const passed = completed && (legacyPassed || attemptPassed);
  const detail = legacyUnlock ? `revision=${legacyUnlock.revisionId}, path=${legacyUnlock.path}, completed=${completed}` : `accepted=${Boolean(acceptedAttempt)}, revision=${recordedUnlockedRevision}, artifact=${promotedArtifact}, completed=${completed}`;
  return { name: "editor unlocked", passed, detail };
}

function publicStateClean(trace: V2SessionTrace): V2GateAssertion {
  const serialized = JSON.stringify(trace);
  const leaked = /"tutor"\s*:|This is private tutor guidance|Do not reveal an exact command|Follow up until the learner|Private editor criterion/i.test(serialized);
  return { name: "public trace has no hidden tutor instructions", passed: !leaked, detail: leaked ? "Hidden tutor instructions appeared in the trace." : "Trace contains only public state and recorded learner-visible exchanges." };
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
  const passed = prompt.includes("factory/.tmp/evaluator-clue.txt") && !/```sh\s+command|This is private tutor guidance|Do not reveal an exact command/i.test(prompt);
  return { name: "clue-only public prompt", passed, detail: passed ? "Public clue-only prompt has clues and no insertable command." : "Public clue-only prompt is missing clues or exposes an insertable/private command." };
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
  const verified = trace.events.some((event) => (event.type === "observation_verified" || (event.type === "attempt_accepted" && event.kind === "terminal")) && matchBlockId(event.blockId, blockId));
  const completed = trace.events.some((event) => event.type === "block_completed" && matchBlockId(event.blockId, blockId));
  return { name: `${blockId} verified completion`, passed: verified && completed, detail: `verified=${verified}, completed=${completed}` };
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
