import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
  resolveCliModel,
  type AgentSession,
  type AgentSessionEvent,
  type ScopedModel
} from "@earendil-works/pi-coding-agent";
import { isAbsolute, relative } from "node:path";
import type { LessonDefinition } from "../lesson/contract.js";
import type { RunState, TutorialEvent } from "../protocol/events.js";
import { TutorialEventBus } from "../protocol/event-bus.js";
import { ValidationRunner } from "../validation/runner.js";
import { ChoiceManager } from "./choice-manager.js";
import { createTutorialTools } from "./tutorial-tools.js";
import { createWorkspaceTools, WorkspaceBoundary } from "./workspace-boundary.js";
import type { TutorialLogger } from "../runtime-log.js";

const TOOL_NAMES = [
  "read", "edit", "write", "move", "grep", "find", "ls",
  "present_markdown", "present_diagram", "offer_choices", "run_validation", "show_file_excerpt", "complete_lesson"
];

/**
 * Names the tutor's model, as `provider/model` with an optional `:thinking`
 * suffix. Deliberately separate from Pi's `/model` default: that one belongs to
 * the `pi -p` doer the lessons drive, which is meant to be cheap and fast — and
 * whose mistakes are part of the lesson. The tutor wants the opposite.
 *
 * scripts/setup.mjs reports the same resolution to the learner; this module is
 * the authority for it.
 */
export const TUTOR_MODEL_ENV = "TUTOR_MODEL";
export const BLOCK_TUTOR_MODEL_ENV = "BLOCK_TUTOR_MODEL";

/** `model` is left undefined when Pi should choose, which is its documented fallback. */
export interface TutorModelChoice extends Partial<ScopedModel> {
  warning?: string;
}

function resolveConfiguredTutorModel(modelRuntime: ModelRuntime, requested: string | undefined, envName: string): TutorModelChoice {
  const wanted = requested?.trim();
  if (!wanted) return {};
  const resolved = resolveCliModel({ cliModel: wanted, modelRuntime });
  if (!resolved.model) {
    return { warning: `${envName}="${wanted}" did not match a model (${resolved.error ?? "no match"}); letting Pi choose.` };
  }
  // resolveCliModel matches against every registered model so that a first-time
  // --api-key run can name one before auth is stored. The tutors have no such
  // escape hatch, so an unauthenticated match would only fail at the first turn.
  if (!modelRuntime.hasConfiguredAuth(resolved.model.provider)) {
    return { warning: `${envName}="${wanted}" matched ${resolved.model.provider}/${resolved.model.id}, which has no configured auth; letting Pi choose.` };
  }
  return { model: resolved.model, thinkingLevel: resolved.thinkingLevel, warning: resolved.warning };
}

/** Resolve the main tutor's model, preferring a working tutorial over an exact match. */
export function resolveTutorModel(modelRuntime: ModelRuntime, requested: string | undefined): TutorModelChoice {
  return resolveConfiguredTutorModel(modelRuntime, requested, TUTOR_MODEL_ENV);
}

/** Resolve the fast block tutor's model, falling back to Pi's ordinary default when unset or unusable. */
export function resolveBlockTutorModel(modelRuntime: ModelRuntime, requested: string | undefined): TutorModelChoice {
  return resolveConfiguredTutorModel(modelRuntime, requested, BLOCK_TUTOR_MODEL_ENV);
}

/** Log operational identifiers, but never tool content or learner chat text. */
function toolDetail(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const value = args as Record<string, unknown>;
  if (typeof value.path === "string") return ` for ${value.path}`;
  if (typeof value.commandId === "string") return ` for validation ${value.commandId}`;
  return "";
}

/**
 * The same identifiers as `toolDetail`, shortened for the learner's spinner:
 * the workspace prefix is noise on screen, where every path is inside it.
 * Content and chat text stay out of this for the same reason as the log.
 */
export function activityDetail(args: unknown, workspace: string): string {
  if (!args || typeof args !== "object") return "";
  const value = args as Record<string, unknown>;
  // Pi passes some paths absolute and some already relative to the workspace.
  // Only the absolute ones need shortening; resolving a relative one against
  // the workspace would depend on the process's working directory.
  if (typeof value.path === "string") return ` ${isAbsolute(value.path) ? relative(workspace, value.path) || value.path : value.path}`;
  if (typeof value.commandId === "string") return ` ${value.commandId}`;
  return "";
}

/** Keep a caption to a glanceable length: the learner has the log for the rest. */
export function summarise(actions: readonly string[], limit = 3): string {
  if (actions.length <= limit) return actions.join(", ");
  return `${actions.slice(0, limit).join(", ")} and ${actions.length - limit} more`;
}

export function coachingSystemPrompt(lesson: LessonDefinition, currentSpec?: string, skippedPartOne = false): string {
  // How far the learner has got is the engine's to know: it lives in factory/,
  // outside the curriculum, and naming the file here saves the tutor working it
  // out. Without one — an exhausted or unreadable ledger — fall back to asking
  // for the first unfinished lesson rather than opening nothing.
  const routing = currentSpec
    ? `then ${currentSpec}, which is the specification for the lesson the learner is on`
    : "then the first specification the learner has not finished";

  // A learner who skipped Part 1 has its output in factory/ without having
  // built it. Opening as though they wrote those files would be the tutorial
  // lying to them on its first screen.
  const skipped = skippedPartOne
    ? "\n\nThis learner skipped Part 1, so the files it builds were copied into factory/ for them. Before the current lesson, show them what is there and what each file does, in a few sentences: they have not seen these before and the lesson assumes they have. Say plainly that Part 1 builds these by hand and they can go back to it. Do not pretend they wrote them, and do not re-teach Part 1.\n"
    : "";

  return `You are a patient tutorial tutor for "${lesson.title}". The learner is building agents that improve code and check each other's work; the kata is their raw material.

At the beginning, silently read README.md, then docs/specs/README.md, ${routing}. The ledger and specifications are your routing information, not the learner's lesson: do not mention the ledger, lesson numbers, or those file paths unless the learner asks. Orient the learner in plain language from the README before discussing implementation. Read no calculator source until the current spec requires it. Introduce only the vocabulary the current specification uses; a later lesson's words are that lesson's to teach.${skipped}

If the current specification contains a Mermaid diagram, reproduce it with present_diagram and its text fallback at the point that specification places it. When the specification says when to show a diagram, that instruction governs: do not bring it forward into the opening orientation.

Teach only the current lesson, one small step at a time, in the implementation order stated by the current specification. Explain what each step achieves before explaining how.

A specification's phrasing is not always the clearest way to say a thing. Where it states a principle figuratively, teach the mechanism instead: name what actually runs, what is written, what is read, and which capability was removed. Do not repeat a figure of speech the learner would have to decode, and never stack two of them in one sentence. The learner should be able to predict what the line will do next, not recall a slogan.

When generating \`factory/refactor/success.md\` on the learner's behalf, default to Kent Beck's four rules of simple design: passes its tests, reveals intention, no duplication, and fewest elements. Present them as the destination for the factory's accumulated refactorings, not as a checklist that one change must complete. Preserve behaviour, and let the learner refine the criteria if they choose.

Every offer_choices option must supply an icon category. Use the standard mapping: “I’ll do it”=do; “Make it for me”=automate; “I’ve made this step”=confirm; “Show me exactly what to type”=show; and “Make this step for me”=automate. Use pause for a stop or pause choice.

For a new change, use offer_choices to offer “I’ll do it” and “Make it for me.” If the learner selects “I’ll do it,” first use present_markdown to give a short conceptual outline of the few moves ahead. Then immediately begin the first guided step. Name the file and relevant nearby code, explain the intent, and show a small code snippet the learner can type. Do not give a large finished-file replacement. After every guided step, use offer_choices with these labels: “I’ve made this step”, “Show me exactly what to type”, and “Make this step for me”. If they ask for exact typing instructions, give the precise small edit; if they ask you to make it, edit only that step. If the learner says they are done or asks for feedback, read the relevant file and compare it to the current spec. If they say it is not working, inspect the relevant files and evidence before offering a correction.

Quote the default Pi command lines from the current spec exactly; never invent Pi CLI flags. If an advanced learner asks to substitute another doer CLI, explain the doer requirements in the spec and leave that CLI's invocation, authentication, sandboxing, and tool restrictions to them. Leave validation, error handling, and defensive code until they teach the current lesson or become necessary. Do not make changes unless the learner explicitly chooses that option.

Do not act as the doer. Do not refactor the calculator on startup. Do not run tests, shell commands, or validation commands: running the evidence belongs to the learner and to the scripts the lessons build, never to you. When a step relocates or renames a file, use the move tool rather than writing a copy: it is the only way you can retire the original. Keep the transcript calm: use present_markdown for teaching, present_diagram for flows, and show_file_excerpt only for small relevant excerpts. Do not expose secrets or read outside the workspace.

Some specifications have the learner run one thing while another is still running. Where that happens, say plainly that it needs a second terminal at the repository root, and a third where the specification uses one, and that the terminal running the line stays occupied until it finishes. A learner who types a watching or steering command into the terminal already running the line sees nothing happen and concludes the lesson is broken. Name which terminal each command belongs in for as long as more than one is in play.

When the current specification creates no files, do not offer to build anything and do not invent an artefact to make the lesson feel like the others. Work through what it asks the learner to run, notice, or answer; treat its checks as questions the learner answers in their own words, and confirm or correct those answers against the specification.

At the end of every lesson, stop there. Recap what the learner built, then use complete_lesson once, and then offer a choice between pausing for now and continuing to the next lesson. Do not begin the next lesson until that choice is made. A lesson is finished when its steps are done, whether the learner made the changes or you did, and whether or not they continue immediately: record it before the choice, not after, so pausing still leaves the outline correct. Do not announce the tool or describe the outline moving; it is bookkeeping, and the learner can see it.

When the current specification says a lesson is the end of Part 1, stop with the stronger, more specific version of that beat instead: recap what the learner built, say plainly that this is the end of the first piece of work, use complete_lesson, and offer a choice between finishing for now and continuing into Part 2. Do not begin the next lesson until that choice is made.`;
}

export class PiTutorialAdapter {
  readonly choices = new ChoiceManager();
  readonly validation: ValidationRunner;
  readonly #bus: TutorialEventBus;
  readonly #boundary: WorkspaceBoundary;
  #session!: AgentSession;
  #state: RunState = "idle";
  #messageCounter = 0;
  #activity = "waiting for Pi";
  #workingSince = 0;
  #heartbeat?: NodeJS.Timeout;
  #toolLabels = new Map<string, { label: string; display: string }>();
  /** What the current batch of tools has finished, for the caption after it drains. */
  #batch: string[] = [];
  #respondingMessages = new Set<string>();
  #supersededChoices = new Set<string>();

  private constructor(readonly lesson: LessonDefinition, readonly workspace: string, bus: TutorialEventBus, boundary: WorkspaceBoundary, private readonly log: TutorialLogger) {
    this.#bus = bus;
    this.#boundary = boundary;
    this.validation = new ValidationRunner(lesson.validationCommands, workspace);
  }

  static async create(lesson: LessonDefinition, workspace: string, bus: TutorialEventBus, log: TutorialLogger, currentSpec?: string, skippedPartOne = false): Promise<PiTutorialAdapter> {
    log.info(`Resolving tutorial workspace ${workspace}.`);
    const boundary = await WorkspaceBoundary.create(workspace);
    const canonicalWorkspace = boundary.root;
    const adapter = new PiTutorialAdapter(lesson, canonicalWorkspace, bus, boundary, log);
    log.info("Loading Pi configuration and tutorial-only resources.");
    const loader = new DefaultResourceLoader({
      cwd: canonicalWorkspace,
      agentDir: getAgentDir(),
      systemPromptOverride: () => coachingSystemPrompt(lesson, currentSpec, skippedPartOne),
      appendSystemPromptOverride: () => [],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      skillsOverride: () => ({ skills: [], diagnostics: [] }),
      promptsOverride: () => ({ prompts: [], diagnostics: [] }),
      extensionFactories: []
    });
    await loader.reload();
    log.info("Pi resources loaded; creating restricted tutor tools.");
    const tools = createTutorialTools({
      lesson,
      workspace: canonicalWorkspace,
      choices: adapter.choices,
      validation: adapter.validation,
      boundary: adapter.#boundary,
      emit: (event) => bus.publish(event),
      setRunState: (state) => adapter.setState(state)
    });
    log.info("Creating Pi agent session.");
    const modelRuntime = await ModelRuntime.create();
    const choice = resolveTutorModel(modelRuntime, process.env[TUTOR_MODEL_ENV]);
    if (choice.warning) log.info(choice.warning);
    const { session } = await createAgentSession({
      cwd: canonicalWorkspace,
      resourceLoader: loader,
      // These same-name definitions replace Pi's built-ins.  Do not rely on
      // cwd alone: every filesystem call is checked and audited by the boundary.
      customTools: [...createWorkspaceTools(canonicalWorkspace, adapter.#boundary, (event) => bus.publish(event)), ...tools],
      tools: TOOL_NAMES,
      modelRuntime,
      model: choice.model,
      thinkingLevel: choice.thinkingLevel,
      sessionManager: SessionManager.inMemory(canonicalWorkspace),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } })
    });
    adapter.#session = session;
    session.subscribe((event) => adapter.onPiEvent(event));
    log.info(`Pi agent session created on ${session.state.model.provider}/${session.state.model.id}; event monitoring is active.`);
    return adapter;
  }

  get state(): RunState { return this.#state; }

  /** What the spinner should say, for a browser that connects mid-turn. */
  get activity(): string { return this.#activity; }

  async begin(): Promise<void> {
    this.log.info("Submitting the initial welcome request to Pi.");
    await this.chat("Begin the tutorial. Silently identify the current lesson. Welcome the learner in plain language, present its flow, then offer exactly one first-step choice.", "steer", false);
  }

  async resume(): Promise<void> {
    this.log.info("Submitting the saved-session continuation request to Pi.");
    await this.chat("The learner has resumed a saved tutorial. Their previous browser transcript is visible to them, but this is a fresh tutor process. Inspect the current factory workspace and the current specification, briefly identify the next unfinished small step, then offer exactly one appropriate choice. Do not repeat the full welcome or assume an unfinished choice is still active.", "steer", false);
  }

  async chat(text: string, delivery: "steer" | "followUp" = "steer", showInTranscript = true): Promise<void> {
    if (!text.trim() || text.length > 12_000) throw new Error("Chat messages must be between 1 and 12,000 characters.");
    if (showInTranscript) this.#bus.publish({ type: "user-message", markdown: text });
    const queuedBehindTurn = this.#session.isStreaming;
    if (queuedBehindTurn) this.log.info(`Pi is already working; this learner request will be queued as ${delivery}.`);
    if (this.#state === "awaiting-choice") {
      const pendingChoices = this.choices.pendingIds;
      this.log.info(`Learner request arrived while awaiting choice ${pendingChoices.join(", ") || "(not yet registered)"}; it will supersede that choice.`);
      const superseded = this.choices.cancelAll("Learner message superseded this choice.");
      superseded.forEach((choiceId) => this.#supersededChoices.add(choiceId));
      if (superseded.length) this.log.info("Learner message superseded the outstanding choice; releasing Pi to respond.");
    }
    this.log.info(`Submitting ${showInTranscript ? "learner" : "initial"} request to Pi (${text.length} characters; ${delivery}).`);
    this.setState("working");
    try {
      await this.#session.prompt(text, queuedBehindTurn ? { streamingBehavior: delivery } : undefined);
      this.log.info(queuedBehindTurn ? "Learner request is queued behind the active tutor turn." : "Pi finished processing the request.");
    } catch (error) {
      this.log.error("Pi could not process the request", error);
      this.setState("failed");
      this.#bus.publish({ type: "error", message: error instanceof Error ? error.message : "Pi failed to start.", retryable: true });
    }
  }

  choose(choiceId: string, optionId: string): void {
    if (!this.choices.choose(choiceId, optionId)) throw new Error("That choice is no longer available.");
  }

  async runValidation(commandId: string): Promise<void> {
    const command = this.lesson.validationCommands.find((item) => item.id === commandId);
    if (!command) throw new Error(`Validation command '${commandId}' is not allowed.`);
    this.log.info(`Starting validation “${command.label}” (${commandId}).`);
    this.setState("working", `running validation “${command.label}”`);
    try {
      const result = await this.validation.run(commandId, (text) => this.#bus.publish({ type: "tool-progress", toolId: `validation:${commandId}`, text }));
      this.log.info(`Validation “${command.label}” ${result.passed ? "passed" : "failed"} in ${result.durationMs}ms (exit ${result.exitCode ?? "no code"}).`);
      this.#bus.publish({ type: "validation", id: command.id, label: command.label, ...result });
      this.setState("idle");
    } catch (error) {
      this.log.error(`Validation “${command.label}” could not run`, error);
      this.setState("failed");
      this.#bus.publish({ type: "error", message: error instanceof Error ? error.message : "Validation could not start.", retryable: true });
    }
  }

  async abort(): Promise<void> {
    this.log.info("Aborting the current tutor request at the learner's request.");
    this.choices.cancelAll("Learner stopped the current step.");
    await this.#session.abort();
    this.setState("idle");
  }

  dispose(): void {
    this.log.info("Disposing the Pi tutor session.");
    this.stopHeartbeat();
    this.choices.cancelAll("Tutorial server stopped.");
    this.#session.dispose();
  }

  private setState(state: RunState, activity = "waiting for Pi"): void {
    const changed = this.#state !== state;
    this.#state = state;
    if (state === "working") {
      this.setActivity(activity);
      if (changed) this.startHeartbeat();
    } else {
      this.stopHeartbeat();
    }
    if (changed) this.log.info(`Tutor state: ${state}${state === "working" ? ` (${this.#activity}).` : "."}`);
    this.#bus.publish({ type: "run-state", state });
  }

  /**
   * The one line the learner sees under the spinner, and the one the heartbeat
   * repeats into the log. Phrased so both read well: "running read on
   * README.md" becomes "Tutor is still running read on README.md (30 seconds)"
   * in the log and "Running read on README.md…" in the browser.
   */
  private setActivity(activity: string): void {
    if (this.#activity === activity) return;
    this.#activity = activity;
    this.#bus.publish({ type: "activity", text: activity });
  }

  /**
   * Say what the current batch of tools is doing, or — once it has drained —
   * what it just did. Individual calls finish in single-digit milliseconds, so
   * a caption that reverted to "waiting for Pi" the moment a tool ended would
   * leave the learner staring at that one phrase for the whole lesson while the
   * log filled with detail.
   */
  private describeToolActivity(): void {
    const running = [...this.#toolLabels.values()].map((entry) => entry.display);
    if (running.length === 1) return this.setActivity(`running ${running[0]}`);
    if (running.length > 1) return this.setActivity(`running ${running.length} tools: ${summarise(running)}`);
    this.setActivity(this.#batch.length > 0 ? `waiting for Pi… ${summarise(this.#batch)}` : "waiting for Pi");
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.#workingSince = Date.now();
    this.#heartbeat = setInterval(() => {
      this.log.info(`Tutor is still working: ${this.#activity} (${Math.round((Date.now() - this.#workingSince) / 1_000)} seconds).`);
    }, 15_000);
    this.#heartbeat.unref();
  }

  private stopHeartbeat(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
  }

  private onPiEvent(event: AgentSessionEvent): void {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      const message = event.message as { id?: string };
      const messageId = message.id ?? `assistant-${this.#messageCounter}`;
      if (!this.#respondingMessages.has(messageId)) {
        this.#respondingMessages.add(messageId);
        this.setActivity("receiving Pi's response");
        this.log.info("Pi started responding.");
      }
      this.#bus.publish({ type: "assistant-delta", messageId, delta: event.assistantMessageEvent.delta });
      return;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const message = event.message as { id?: string; content?: Array<{ type: string; text?: string }> };
      const messageId = message.id ?? `assistant-${this.#messageCounter++}`;
      const markdown = message.content?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("") ?? "";
      if (markdown) {
        this.#respondingMessages.delete(messageId);
        this.log.info(`Pi completed a response (${markdown.length} characters).`);
        this.#bus.publish({ type: "assistant-message", messageId, markdown });
      }
      return;
    }
    if (event.type === "tool_execution_start") {
      const definition = this.#session.getToolDefinition(event.toolName);
      const label = definition?.label ?? event.toolName;
      // Pi issues tools in batches: several start together and all finish a few
      // milliseconds later. The batch, not the individual call, is the unit the
      // learner can actually read, so start a fresh one whenever none is open.
      if (this.#toolLabels.size === 0) this.#batch = [];
      this.#toolLabels.set(event.toolCallId, { label, display: `${label}${activityDetail(event.args, this.workspace)}` });
      this.describeToolActivity();
      this.log.info(`Pi started tool “${label}”${toolDetail(event.args)} (${event.toolCallId}).`);
      this.#bus.publish({ type: "tool-start", tool: { id: event.toolCallId, name: event.toolName, label } });
      return;
    }
    if (event.type === "tool_execution_update") {
      const content = event.partialResult?.content?.filter((item: { type: string }) => item.type === "text").map((item: { text?: string }) => item.text ?? "").join("") ?? "";
      if (content) this.#bus.publish({ type: "tool-progress", toolId: event.toolCallId, text: content });
      return;
    }
    if (event.type === "tool_execution_end") {
      const content = event.result?.content?.filter((item: { type: string }) => item.type === "text").map((item: { text?: string }) => item.text ?? "").join("") ?? "";
      const entry = this.#toolLabels.get(event.toolCallId);
      const label = entry?.label ?? event.toolName;
      if (entry) this.#batch.push(entry.display);
      this.#toolLabels.delete(event.toolCallId);
      this.describeToolActivity();
      if (event.isError && this.#supersededChoices.delete(event.toolCallId)) {
        this.log.info("Pi choice was superseded by a learner message.");
        this.#bus.publish({ type: "tool-complete", toolId: event.toolCallId, summary: "Choice superseded by learner message." });
      } else if (event.isError) {
        this.log.info(`Pi tool “${label}” failed: ${content || `${event.toolName} failed.`}`);
        this.#bus.publish({ type: "tool-error", toolId: event.toolCallId, message: content || `${event.toolName} failed.`, retryable: true });
      } else {
        const validationResult = event.toolName === "run_validation" && content ? `: ${content}` : "";
        this.log.info(`Pi completed tool “${label}”${validationResult}.`);
        this.#bus.publish({ type: "tool-complete", toolId: event.toolCallId, summary: content });
      }
      return;
    }
    if (event.type === "queue_update") {
      this.log.info(`Pi message queue: ${event.steering.length} steering request${event.steering.length === 1 ? "" : "s"} and ${event.followUp.length} follow-up request${event.followUp.length === 1 ? "" : "s"} waiting.`);
      return;
    }
    if (event.type === "agent_settled") {
      this.log.info("Pi agent settled.");
      if (this.#state !== "awaiting-choice") this.setState("idle");
    }
  }
}
