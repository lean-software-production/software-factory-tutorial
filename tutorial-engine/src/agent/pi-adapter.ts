import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
  type AgentSession,
  type AgentSessionEvent
} from "@earendil-works/pi-coding-agent";
import type { LessonDefinition } from "../lesson/contract.js";
import type { RunState, TutorialEvent } from "../protocol/events.js";
import { TutorialEventBus } from "../protocol/event-bus.js";
import { ValidationRunner } from "../validation/runner.js";
import { ChoiceManager } from "./choice-manager.js";
import { createTutorialTools } from "./tutorial-tools.js";
import { createWorkspaceTools, WorkspaceBoundary } from "./workspace-boundary.js";

const TOOL_NAMES = [
  "read", "edit", "write", "grep", "find", "ls",
  "present_markdown", "present_diagram", "offer_choices", "run_validation", "show_file_excerpt"
];

export function coachingSystemPrompt(lesson: LessonDefinition): string {
  return `You are a patient tutorial tutor for "${lesson.title}". The learner is building a software factory; the kata is its raw material.

At the beginning, silently read README.md, then docs/specs/README.md, then the first specification whose ledger status is Todo. The ledger and specifications are your routing information, not the learner's lesson: do not mention the ledger, Todo, iteration numbers, or those file paths unless the learner asks. Orient the learner in plain language from the README before discussing implementation. Read no calculator source until the current spec requires it. If that spec contains a Mermaid diagram, reproduce it with present_diagram and its text fallback.

Teach only the current iteration, one small step at a time, in the implementation order stated by the current specification. Explain what each step achieves before explaining how.

Every offer_choices option must supply an icon category. Use the standard mapping: “I’ll do it”=do; “Make it for me”=automate; “I’ve made this step”=confirm; “Show me exactly what to type”=show; and “Make this step for me”=automate. Use pause for a stop or pause choice.

For a new change, use offer_choices to offer “I’ll do it” and “Make it for me.” If the learner selects “I’ll do it,” first use present_markdown to give a short conceptual outline of the few moves ahead. Then immediately begin the first guided step. Name the file and relevant nearby code, explain the intent, and show a small code snippet the learner can type. Do not give a large finished-file replacement. After every guided step, use offer_choices with these labels: “I’ve made this step”, “Show me exactly what to type”, and “Make this step for me”. If they ask for exact typing instructions, give the precise small edit; if they ask you to make it, edit only that step. If the learner says they are done or asks for feedback, read the relevant file and compare it to the current spec. If they say it is not working, inspect the relevant files and evidence before offering a correction.

Quote the default Pi command lines from the current spec exactly; never invent Pi CLI flags. If an advanced learner asks to substitute another worker CLI, explain the worker requirements in the spec and leave that CLI's invocation, authentication, sandboxing, and tool restrictions to them. Leave validation, error handling, and defensive code until they teach the current lesson or become necessary. Do not make changes unless the learner explicitly chooses that option.

Do not act as the factory worker. Do not refactor the calculator on startup. Do not run tests, shell commands, or validation commands; the factory built in the current spec owns validation. Keep the transcript calm: use present_markdown for teaching, present_diagram for flows, and show_file_excerpt only for small relevant excerpts. Do not expose secrets or read outside the workspace.`;
}

export class PiTutorialAdapter {
  readonly choices = new ChoiceManager();
  readonly validation: ValidationRunner;
  readonly #bus: TutorialEventBus;
  readonly #boundary: WorkspaceBoundary;
  #session!: AgentSession;
  #state: RunState = "idle";
  #messageCounter = 0;

  private constructor(readonly lesson: LessonDefinition, readonly workspace: string, bus: TutorialEventBus, boundary: WorkspaceBoundary) {
    this.#bus = bus;
    this.#boundary = boundary;
    this.validation = new ValidationRunner(lesson.validationCommands, workspace);
  }

  static async create(lesson: LessonDefinition, workspace: string, bus: TutorialEventBus): Promise<PiTutorialAdapter> {
    const boundary = await WorkspaceBoundary.create(workspace);
    const canonicalWorkspace = boundary.root;
    const adapter = new PiTutorialAdapter(lesson, canonicalWorkspace, bus, boundary);
    const loader = new DefaultResourceLoader({
      cwd: canonicalWorkspace,
      agentDir: getAgentDir(),
      systemPromptOverride: () => coachingSystemPrompt(lesson),
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
    const tools = createTutorialTools({
      lesson,
      workspace: canonicalWorkspace,
      choices: adapter.choices,
      validation: adapter.validation,
      boundary: adapter.#boundary,
      emit: (event) => bus.publish(event),
      setRunState: (state) => adapter.setState(state)
    });
    const { session } = await createAgentSession({
      cwd: canonicalWorkspace,
      resourceLoader: loader,
      // These same-name definitions replace Pi's built-ins.  Do not rely on
      // cwd alone: every filesystem call is checked and audited by the boundary.
      customTools: [...createWorkspaceTools(canonicalWorkspace, adapter.#boundary, (event) => bus.publish(event)), ...tools],
      tools: TOOL_NAMES,
      sessionManager: SessionManager.inMemory(canonicalWorkspace),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } })
    });
    adapter.#session = session;
    session.subscribe((event) => adapter.onPiEvent(event));
    return adapter;
  }

  get state(): RunState { return this.#state; }

  async begin(): Promise<void> {
    await this.chat("Begin the tutorial. Silently identify the current lesson. Welcome the learner in plain language, present its flow, then offer exactly one first-step choice.", "steer", false);
  }

  async chat(text: string, delivery: "steer" | "followUp" = "steer", showInTranscript = true): Promise<void> {
    if (!text.trim() || text.length > 12_000) throw new Error("Chat messages must be between 1 and 12,000 characters.");
    if (showInTranscript) this.#bus.publish({ type: "user-message", markdown: text });
    this.setState("working");
    try {
      await this.#session.prompt(text, this.#session.isStreaming ? { streamingBehavior: delivery } : undefined);
    } catch (error) {
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
    this.setState("working");
    try {
      const result = await this.validation.run(commandId, (text) => this.#bus.publish({ type: "tool-progress", toolId: `validation:${commandId}`, text }));
      this.#bus.publish({ type: "validation", id: command.id, label: command.label, ...result });
      this.setState("idle");
    } catch (error) {
      this.setState("failed");
      this.#bus.publish({ type: "error", message: error instanceof Error ? error.message : "Validation could not start.", retryable: true });
    }
  }

  async abort(): Promise<void> {
    this.choices.cancelAll("Learner stopped the current step.");
    await this.#session.abort();
    this.setState("idle");
  }

  dispose(): void {
    this.choices.cancelAll("Tutorial server stopped.");
    this.#session.dispose();
  }

  private setState(state: RunState): void {
    this.#state = state;
    this.#bus.publish({ type: "run-state", state });
  }

  private onPiEvent(event: AgentSessionEvent): void {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      const message = event.message as { id?: string };
      this.#bus.publish({ type: "assistant-delta", messageId: message.id ?? `assistant-${this.#messageCounter}`, delta: event.assistantMessageEvent.delta });
      return;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const message = event.message as { id?: string; content?: Array<{ type: string; text?: string }> };
      const markdown = message.content?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("") ?? "";
      if (markdown) this.#bus.publish({ type: "assistant-message", messageId: message.id ?? `assistant-${this.#messageCounter++}`, markdown });
      return;
    }
    if (event.type === "tool_execution_start") {
      const definition = this.#session.getToolDefinition(event.toolName);
      this.#bus.publish({ type: "tool-start", tool: { id: event.toolCallId, name: event.toolName, label: definition?.label ?? event.toolName } });
      return;
    }
    if (event.type === "tool_execution_update") {
      const content = event.partialResult?.content?.filter((item: { type: string }) => item.type === "text").map((item: { text?: string }) => item.text ?? "").join("") ?? "";
      if (content) this.#bus.publish({ type: "tool-progress", toolId: event.toolCallId, text: content });
      return;
    }
    if (event.type === "tool_execution_end") {
      const content = event.result?.content?.filter((item: { type: string }) => item.type === "text").map((item: { text?: string }) => item.text ?? "").join("") ?? "";
      if (event.isError) this.#bus.publish({ type: "tool-error", toolId: event.toolCallId, message: content || `${event.toolName} failed.`, retryable: true });
      else this.#bus.publish({ type: "tool-complete", toolId: event.toolCallId, summary: content });
      return;
    }
    if (event.type === "agent_settled" && this.#state !== "awaiting-choice") this.setState("idle");
  }
}
