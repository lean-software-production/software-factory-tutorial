import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadLesson } from "../../tutorial-engine/src/lesson/load.js";
import { startLocalServer, type StartedServer } from "../../tutorial-engine/src/server/local-server.js";
import { parseTutorialEvent, serializeBrowserMessage, type BrowserMessage, type TutorialEvent } from "../../tutorial-engine/src/protocol/events.js";
import type { CanonicalPatch, Scenario } from "../scenarios/lesson-001/scenarios.js";
import { activateLesson, applyCanonicalPatch, scrubProcessEnvironment, seedWorkspace, snapshot } from "./workspace.js";

const FIRST_OUTPUT_TIMEOUT = 90_000;
const STEP_TIMEOUT = 120_000;

export class PersonaProtocolError extends Error {}
export class EvalTimeoutError extends Error {
  constructor(message: string, readonly modelOutputObserved = false) { super(message); }
}

export interface PatchPair {
  patch: string;
  learnerMessage: string;
  /** Tutor events that followed the structured choice and preceded this atomic learner edit. */
  tutorEvents: TutorialEvent[];
  /** The outstanding tutor choice resolved immediately after this learner edit. */
  completionChoiceId: string;
  /** The post-inspection correction choice, recorded before the canonical repair. */
  correctionCheckpointEvent?: number;
  correctionCheckpointChoiceId?: string;
}

type ChoiceEvent = Extract<TutorialEvent, { type: "choice" }>;
type AuditEvent = Extract<TutorialEvent, { type: "audit" }>;

export type DelegationChoice = { kind: "delegate" | "pause"; optionId: string };

export type HandsOnDriverState =
  /** A canonical patch is pending; its choice shape, not tutor prose, drives us. */
  | { phase: "awaiting-instruction"; patchIndex: number }
  | { phase: "awaiting-exact-guidance"; patchIndex: number }
  | { phase: "awaiting-defect-audit"; patchIndex: number }
  | { phase: "awaiting-correction-instruction"; patchIndex: number }
  | { phase: "awaiting-correction-completion"; patchIndex: number }
  /** The final confirmation must be followed by a learner-controlled pause. */
  | { phase: "awaiting-lesson-completion-pause" }
  | { phase: "complete" };

export type HandsOnDriverAction =
  | { type: "apply"; patchIndex: number }
  | { type: "select"; choiceId: string; optionId: string };

export function beginHandsOnDriver(): HandsOnDriverState {
  return { phase: "awaiting-instruction", patchIndex: 0 };
}

function selection(choice: ChoiceEvent, icon: ChoiceEvent["options"][number]["icon"]): HandsOnDriverAction {
  const optionId = choice.options.find((option) => option.icon === icon)?.id;
  if (!optionId) throw new PersonaProtocolError(`Tutor offered an unsupported choice: ${choice.options.map((option) => `${option.label} (${option.icon})`).join(", ")}`);
  return { type: "select", choiceId: choice.id, optionId };
}

function hasIcon(choice: ChoiceEvent, icon: ChoiceEvent["options"][number]["icon"]): boolean {
  return choice.options.some((option) => option.icon === icon);
}

function patchAt(scenario: Scenario, patchIndex: number): CanonicalPatch {
  const patch = scenario.patches[patchIndex];
  if (!patch) throw new PersonaProtocolError(`No canonical patch exists at index ${patchIndex}.`);
  return patch;
}

function isRelevantDefectRead(patch: CanonicalPatch, event: TutorialEvent): event is AuditEvent {
  return event.type === "audit"
    && (event.tool === "read" || event.tool === "show_file_excerpt")
    && !event.mutation
    && event.outcome === "ok"
    && event.paths.some((path) => Object.hasOwn(patch.files, path));
}

function completeHandsOnPatch(scenario: Scenario, patchIndex: number, choice: ChoiceEvent): { state: HandsOnDriverState; actions: HandsOnDriverAction[] } {
  const patch = patchAt(scenario, patchIndex);
  const actions: HandsOnDriverAction[] = [
    { type: "apply", patchIndex },
    selection(choice, "confirm")
  ];
  if (patch.name === "defect") return { state: { phase: "awaiting-defect-audit", patchIndex }, actions };
  if (patchIndex === scenario.patches.length - 1) return { state: { phase: "awaiting-lesson-completion-pause" }, actions };
  return { state: { phase: "awaiting-instruction", patchIndex: patchIndex + 1 }, actions };
}

/**
 * Dispatch a pending patch by icon category only. The tutor does not provide a
 * semantic step ID, so a show choice always wins, a confirm without show pairs
 * with the pending patch, and do merely starts or resumes guidance.
 */
function advancePendingPatch(
  state: Extract<HandsOnDriverState, { phase: "awaiting-instruction" | "awaiting-exact-guidance" | "awaiting-correction-instruction" | "awaiting-correction-completion" }>,
  scenario: Scenario,
  choice: ChoiceEvent
): { state: HandsOnDriverState; actions: HandsOnDriverAction[] } {
  const exactGuidanceState: HandsOnDriverState = state.phase.startsWith("awaiting-correction")
    ? { phase: "awaiting-correction-completion", patchIndex: state.patchIndex }
    : { phase: "awaiting-exact-guidance", patchIndex: state.patchIndex };
  if (hasIcon(choice, "show")) return { state: exactGuidanceState, actions: [selection(choice, "show")] };
  if (hasIcon(choice, "confirm")) return completeHandsOnPatch(scenario, state.patchIndex, choice);
  if (hasIcon(choice, "do")) return { state, actions: [selection(choice, "do")] };
  throw new PersonaProtocolError(`Tutor offered an unsupported hands-on choice: ${choice.options.map((option) => `${option.label} (${option.icon})`).join(", ")}`);
}

/**
 * Lessons 001 and 004 deliberately build nothing, so their scenarios carry no
 * canonical patch and there is no edit to pair a confirmation with. The learner
 * still has to be able to finish: follow the tutor's own stopping point, and
 * treat the first pause it offers as the end of the lesson. Everything else is
 * answered in the way that keeps a hand-run lesson moving — confirm that the
 * step was done, ask for the exact wording, or start the walkthrough.
 */
function advanceZeroPatchScenario(state: HandsOnDriverState, choice: ChoiceEvent): { state: HandsOnDriverState; actions: HandsOnDriverAction[] } {
  if (hasIcon(choice, "pause")) return { state: { phase: "complete" }, actions: [selection(choice, "pause")] };
  for (const icon of ["confirm", "show", "do"] as const) {
    if (hasIcon(choice, icon)) return { state, actions: [selection(choice, icon)] };
  }
  throw new PersonaProtocolError(`Tutor offered an unsupported hands-on choice: ${choice.options.map((option) => `${option.label} (${option.icon})`).join(", ")}`);
}

/**
 * Pure protocol state machine for the deterministic hands-on learner. Each
 * atomic patch is paired only with a structured confirmation, never tutor prose.
 */
export function advanceHandsOnDriver(state: HandsOnDriverState, scenario: Scenario, event: ChoiceEvent | AuditEvent): { state: HandsOnDriverState; actions: HandsOnDriverAction[] } {
  if (state.phase === "complete") throw new PersonaProtocolError("The hands-on driver is already complete.");
  if (scenario.patches.length === 0) {
    if (event.type !== "choice") throw new PersonaProtocolError("Expected a structured tutor choice.");
    return advanceZeroPatchScenario(state, event);
  }
  if (state.phase === "awaiting-defect-audit") {
    const patch = patchAt(scenario, state.patchIndex);
    if (!isRelevantDefectRead(patch, event)) throw new PersonaProtocolError(`Expected an audited read of the defective ${Object.keys(patch.files).join(", ")}.`);
    return { state: { phase: "awaiting-correction-instruction", patchIndex: state.patchIndex + 1 }, actions: [] };
  }
  if (event.type !== "choice") throw new PersonaProtocolError("Expected a structured tutor choice.");
  if (state.phase === "awaiting-lesson-completion-pause") {
    if (!hasIcon(event, "pause")) throw new PersonaProtocolError("Tutor did not offer a lesson-completion pause choice.");
    return { state: { phase: "complete" }, actions: [selection(event, "pause")] };
  }
  return advancePendingPatch(state, scenario, event);
}

export interface SessionTrace {
  events: TutorialEvent[];
  messages: BrowserMessage[];
  snapshots: Record<string, Record<string, string>>;
  patchPairs?: PatchPair[];
  startedAt: string;
  endedAt: string;
}

function eventKey(event: TutorialEvent): string { return JSON.stringify(event); }

/** Expand replayed SSE history once, retaining the snapshot itself as readiness evidence. */
export function foldSnapshotEvents(incoming: readonly TutorialEvent[]): TutorialEvent[] {
  const folded: TutorialEvent[] = [];
  const seen = new Set<string>();
  const append = (event: TutorialEvent) => {
    const key = eventKey(event);
    if (seen.has(key)) return;
    seen.add(key);
    folded.push(event);
    if (event.type === "snapshot") for (const historic of event.events) append(historic);
  };
  for (const event of incoming) append(event);
  return folded;
}

class SseTrace {
  readonly events: TutorialEvent[] = [];
  #seen = new Set<string>();
  #waiters = new Set<() => void>();

  get modelOutputObserved(): boolean {
    return this.events.some((event) => event.type === "assistant-delta" || event.type === "assistant-message");
  }

  push(event: TutorialEvent) {
    for (const expanded of foldSnapshotEvents([event])) {
      const key = eventKey(expanded);
      if (this.#seen.has(key)) continue;
      this.#seen.add(key);
      this.events.push(expanded);
      for (const wake of this.#waiters) wake();
    }
  }

  async waitFor(predicate: (event: TutorialEvent, all: readonly TutorialEvent[]) => boolean, timeoutMs = STEP_TIMEOUT): Promise<TutorialEvent> {
    const existing = this.events.find((event) => predicate(event, this.events));
    if (existing) return existing;
    return new Promise<TutorialEvent>((resolve, reject) => {
      const check = () => {
        const found = this.events.find((event) => predicate(event, this.events));
        if (found) { clearTimeout(timer); this.#waiters.delete(check); resolve(found); }
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(check);
        reject(new EvalTimeoutError(`Timed out waiting for tutorial protocol event after ${timeoutMs}ms.`, this.modelOutputObserved));
      }, timeoutMs);
      this.#waiters.add(check);
    });
  }
}

async function consumeSse(url: string, trace: SseTrace, signal: AbortSignal): Promise<void> {
  const response = await fetch(`${url}/api/events`, { signal, headers: { Accept: "text/event-stream" } });
  if (!response.ok || !response.body) throw new Error(`SSE connection failed (${response.status}).`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) break;
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
        if (!data) continue;
        trace.push(parseTutorialEvent(data));
      }
    }
  } finally { reader.releaseLock(); }
}

function choiceOptionId(event: ChoiceEvent, labels: readonly string[], icon: ChoiceEvent["options"][number]["icon"]): string | undefined {
  const normalize = (label: string) => label.replaceAll("’", "'");
  const expected = new Set(labels.map(normalize));
  return event.options.find((option) => option.icon === icon && expected.has(normalize(option.label)))?.id;
}

/** Keep ordinary delegation on the declared labels; only a pause icon ends it. */
export function selectDelegationChoice(event: ChoiceEvent): DelegationChoice {
  const delegated = choiceOptionId(event, ["Make it for me", "Make this step for me"], "automate");
  if (delegated) return { kind: "delegate", optionId: delegated };
  const paused = event.options.find((option) => option.icon === "pause")?.id;
  if (paused) return { kind: "pause", optionId: paused };
  throw new PersonaProtocolError(`Tutor offered an unsupported delegation choice: ${event.options.map((option) => option.label).join(", ")}`);
}

function workspaceDiff(before: Record<string, string>, after: Record<string, string>): string {
  const files = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changes = files.filter((file) => before[file] !== after[file]);
  if (!changes.length) return "No factory artifact changes.\n";
  return changes.map((file) => `## ${file}\n\n\`\`\`diff\n- ${before[file] ?? "(absent)"}\n+ ${after[file] ?? "(absent)"}\n\`\`\``).join("\n\n");
}

export async function runPersonaSession(options: { repositoryRoot: string; workspace: string; webRoot: string; scenario: Scenario; reportDirectory: string }): Promise<SessionTrace> {
  const restoreEnvironment = scrubProcessEnvironment();
  let server: StartedServer;
  try {
    // `loadLesson` deliberately chooses the first Todo row, so activate the
    // requested lesson in the temporary learner copy before creating the engine.
    await activateLesson(options.workspace, options.scenario.lesson);
    // Earlier lessons' artefacts arrive before the engine starts, so the tutor
    // finds the workspace the learner would actually have carried forward.
    await seedWorkspace(options.workspace, options.scenario.seed);
    const loaded = await loadLesson(options.workspace);
    server = await startLocalServer({ lesson: loaded.definition, workspace: options.workspace, webRoot: options.webRoot, progress: loaded.progress });
  } catch (error) {
    restoreEnvironment();
    throw error;
  }
  const controller = new AbortController();
  const trace = new SseTrace();
  const messages: BrowserMessage[] = [];
  const snapshots: Record<string, Record<string, string>> = {};
  const patchPairs: PatchPair[] = [];
  snapshots.initial = await snapshot(options.workspace, "initial", join(options.reportDirectory, "snapshots"));
  const startedAt = new Date().toISOString();
  const sse = consumeSse(server.url, trace, controller.signal);
  const handledChoices = new Set<string>();
  const send = async (message: BrowserMessage) => {
    messages.push(message);
    const response = await fetch(`${server.url}/api/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: serializeBrowserMessage(message) });
    if (response.status !== 202) throw new PersonaProtocolError(`Browser message was rejected (${response.status}).`);
  };
  const nextChoice = async (after = 0): Promise<Extract<TutorialEvent, { type: "choice" }>> => {
    const event = await trace.waitFor((candidate, all) => candidate.type === "choice" && all.indexOf(candidate) >= after && !handledChoices.has(candidate.id));
    if (event.type !== "choice") throw new PersonaProtocolError("Expected a structured choice event.");
    return event;
  };
  const applyStep = async (patch: CanonicalPatch, tutorEvents: TutorialEvent[], completionChoiceId: string) => {
    await applyCanonicalPatch(options.workspace, patch);
    snapshots[patch.name] = await snapshot(options.workspace, patch.name, join(options.reportDirectory, "snapshots"));
    // Keep the canonical learner wording as judging evidence even though the
    // live protocol resolves the outstanding choice rather than sending chat.
    patchPairs.push({ patch: patch.name, learnerMessage: patch.message, tutorEvents, completionChoiceId });
  };
  const requiredChoice = async (after: number, context: string): Promise<ChoiceEvent> => {
    try {
      return await nextChoice(after);
    } catch (error) {
      if (error instanceof EvalTimeoutError) throw new PersonaProtocolError(`Tutor did not produce the required structured choice for ${context}.`);
      throw error;
    }
  };
  try {
    await trace.waitFor((event) => event.type === "snapshot", FIRST_OUTPUT_TIMEOUT);
    const initialChoice = await nextChoice();
    const firstLabels = ["Make it for me"];
    const firstOption = options.scenario.mode === "delegate"
      ? choiceOptionId(initialChoice, firstLabels, "automate")
      : initialChoice.options.find((option) => option.icon === "do")?.id;
    if (!firstOption) throw new PersonaProtocolError(options.scenario.mode === "delegate" ? `Tutor did not offer ${firstLabels[0]}.` : "Tutor did not offer a hands-on start choice.");
    handledChoices.add(initialChoice.id);
    await send({ type: "choose", choiceId: initialChoice.id, optionId: firstOption });

    if (options.scenario.mode === "delegate") {
      // Delegation is still learner-controlled: keep choosing only the declared
      // delegate option whenever the tutor completes an atomic step and asks again.
      for (let turns = 0; turns < 16; turns++) {
        const event = await trace.waitFor((candidate) => (candidate.type === "choice" && !handledChoices.has(candidate.id)) || (candidate.type === "run-state" && candidate.state === "idle"));
        if (event.type !== "choice") break;
        const action = selectDelegationChoice(event);
        const choiceIndex = trace.events.indexOf(event);
        handledChoices.add(event.id);
        await send({ type: "choose", choiceId: event.id, optionId: action.optionId });
        if (action.kind === "pause") {
          await trace.waitFor((candidate, all) => candidate.type === "run-state" && candidate.state === "idle" && all.indexOf(candidate) > choiceIndex);
          break;
        }
        if (turns === 15) throw new PersonaProtocolError("Tutor exceeded the maximum deterministic delegation steps.");
      }
    } else {
      // The Pi offer_choices tool blocks its session. A pending canonical patch
      // is always dispatched by the offered icon category, not tutor wording.
      let state = beginHandsOnDriver();
      let tutorEventsStart = trace.events.length;
      let minimumChoiceIndex = 0;
      // A lesson that builds nothing ends on the tutor's own pause rather than
      // on its last patch, so bound the walkthrough rather than trusting it.
      const maximumTurns = 8 + options.scenario.patches.length * 8;
      for (let turns = 0; state.phase !== "complete"; turns++) {
        if (turns >= maximumTurns) throw new PersonaProtocolError(`Tutor exceeded ${maximumTurns} hands-on steps without completing the lesson.`);
        if (state.phase === "awaiting-defect-audit") {
          const defect = patchAt(options.scenario, state.patchIndex);
          const auditStart = tutorEventsStart;
          const audit = await trace.waitFor((event, all) => all.indexOf(event) >= auditStart && isRelevantDefectRead(defect, event));
          if (audit.type !== "audit") throw new PersonaProtocolError("Expected an audited read of the defective files.");
          const auditIndex = trace.events.indexOf(audit);
          const transition = advanceHandsOnDriver(state, options.scenario, audit);
          state = transition.state;
          // A correction choice emitted before the inspection is not evidence
          // that the tutor responded to the defect, so require a later choice.
          minimumChoiceIndex = auditIndex + 1;
          continue;
        }

        const context = state.phase === "awaiting-exact-guidance"
          ? "exact typing guidance"
          : state.phase === "awaiting-correction-instruction"
            ? "the correction instruction"
            : state.phase === "awaiting-correction-completion"
              ? "the correction completion"
              : state.phase === "awaiting-lesson-completion-pause"
                ? "the lesson-completion pause"
                : "the next guided instruction";
        const choice = await requiredChoice(minimumChoiceIndex, context);
        minimumChoiceIndex = 0;
        if (state.phase === "awaiting-correction-instruction" || state.phase === "awaiting-correction-completion") {
          const defectPair = patchPairs.find((pair) => pair.patch === "defect");
          if (!defectPair) throw new PersonaProtocolError("Tutor offered a correction choice before the defect patch was recorded.");
          defectPair.correctionCheckpointEvent = trace.events.indexOf(choice);
          defectPair.correctionCheckpointChoiceId = choice.id;
        }
        const transition = advanceHandsOnDriver(state, options.scenario, choice);
        for (const action of transition.actions) {
          if (action.type === "apply") {
            const patch = patchAt(options.scenario, action.patchIndex);
            await applyStep(patch, trace.events.slice(tutorEventsStart), choice.id);
          } else {
            handledChoices.add(action.choiceId);
            // Start the next evidence window before resolving the blocking tool.
            tutorEventsStart = trace.events.length;
            await send({ type: "choose", choiceId: action.choiceId, optionId: action.optionId });
          }
        }
        state = transition.state;
      }
      await trace.waitFor((event) => event.type === "run-state" && event.state === "idle");
    }
    return { events: trace.events, messages, snapshots, patchPairs, startedAt, endedAt: new Date().toISOString() };
  } finally {
    controller.abort();
    await Promise.allSettled([sse]);
    await server.close();
    restoreEnvironment();
    await mkdir(options.reportDirectory, { recursive: true });
    snapshots.final = await snapshot(options.workspace, "final", join(options.reportDirectory, "snapshots"));
    await writeFile(join(options.reportDirectory, "workspace-diff.md"), workspaceDiff(snapshots.initial ?? {}, snapshots.final));
    await writeFile(join(options.reportDirectory, "events.json"), JSON.stringify(trace.events, null, 2));
    await writeFile(join(options.reportDirectory, "browser-messages.json"), JSON.stringify(messages, null, 2));
    await writeFile(join(options.reportDirectory, "patch-pairs.json"), JSON.stringify(patchPairs, null, 2));
  }
}
