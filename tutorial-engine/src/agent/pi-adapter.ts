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

const TOOL_NAMES = [
  "read", "edit", "write", "grep", "find", "ls",
  "present_markdown", "present_diagram", "offer_choices", "run_validation", "show_file_excerpt"
];

function coachingSystemPrompt(lesson: LessonDefinition): string {
  return `You are a patient refactoring tutorial coach for "${lesson.title}".
You work only inside the kata workspace. Keep a learner-led validation loop visible: inspect one small seam, propose one small safe change, let the learner choose, then validate immediately. Never take two change steps without an offer_choices selection.

Use present_markdown for teaching and next-step instructions, present_diagram for flows, show_file_excerpt for a small relevant excerpt, and run_validation for checks. Use offer_choices whenever you ask whether the learner should make a change or you should make it. Do not invoke shell commands; run_validation is the only execution route and only accepts allowlisted IDs. Do not expose secrets or read outside the workspace. Be concise and never claim a validation passed without its result.

Lesson rules:
${(lesson.rules ?? []).map((rule) => `- ${rule}`).join("\n") || "- Make one small behaviour-preserving refactoring at a time."}

Kata coaching prompt:
${lesson.coachingPrompt}`;
}

export class PiTutorialAdapter {
  readonly choices = new ChoiceManager();
  readonly validation: ValidationRunner;
  readonly #bus: TutorialEventBus;
  #session!: AgentSession;
  #state: RunState = "idle";
  #messageCounter = 0;

  private constructor(readonly lesson: LessonDefinition, readonly workspace: string, bus: TutorialEventBus) {
    this.#bus = bus;
    this.validation = new ValidationRunner(lesson.validationCommands, workspace);
  }

  static async create(lesson: LessonDefinition, workspace: string, bus: TutorialEventBus): Promise<PiTutorialAdapter> {
    const adapter = new PiTutorialAdapter(lesson, workspace, bus);
    const loader = new DefaultResourceLoader({
      cwd: workspace,
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
      workspace,
      choices: adapter.choices,
      validation: adapter.validation,
      emit: (event) => bus.publish(event),
      setRunState: (state) => adapter.setState(state)
    });
    const { session } = await createAgentSession({
      cwd: workspace,
      resourceLoader: loader,
      customTools: tools,
      tools: TOOL_NAMES,
      sessionManager: SessionManager.inMemory(workspace),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } })
    });
    adapter.#session = session;
    session.subscribe((event) => adapter.onPiEvent(event));
    return adapter;
  }

  get state(): RunState { return this.#state; }

  async begin(): Promise<void> {
    for (const presentation of this.lesson.initialContent ?? []) this.#bus.publish({ type: "presentation", presentation });
    if (this.lesson.allowedActions?.length) {
      this.#bus.publish({ type: "presentation", presentation: { kind: "markdown", title: "Available actions", markdown: this.lesson.allowedActions.map((action) => `- ${action}`).join("\n") } });
    }
    await this.chat("Begin the tutorial. Orient the learner, inspect the starting point, then offer exactly one next-step choice.");
  }

  async chat(text: string, delivery: "steer" | "followUp" = "steer"): Promise<void> {
    if (!text.trim() || text.length > 12_000) throw new Error("Chat messages must be between 1 and 12,000 characters.");
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
