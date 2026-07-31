import { readFile } from "node:fs/promises";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { LessonDefinition } from "../lesson/contract.js";
import type { ChoiceOption, TutorialEvent } from "../protocol/events.js";
import type { ValidationRunner } from "../validation/runner.js";
import { ChoiceManager } from "./choice-manager.js";
import { WorkspaceBoundary } from "./workspace-boundary.js";

const text = (value: string, max: number, field: string): string => {
  if (!value.trim() || value.length > max) throw new Error(`${field} must be between 1 and ${max} characters.`);
  return value;
};

export const choiceOptionSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 80 }),
  label: Type.String({ minLength: 1, maxLength: 160 }),
  icon: Type.Union([
    Type.Literal("do"),
    Type.Literal("show"),
    Type.Literal("confirm"),
    Type.Literal("automate"),
    Type.Literal("pause")
  ]),
  description: Type.Optional(Type.String({ maxLength: 500 }))
});

export interface TutorialToolDependencies {
  lesson: LessonDefinition;
  workspace: string;
  choices: ChoiceManager;
  validation: ValidationRunner;
  boundary: WorkspaceBoundary;
  emit(event: TutorialEvent): void;
  setRunState(state: "working" | "awaiting-choice"): void;
}

export function createTutorialTools(deps: TutorialToolDependencies): ToolDefinition[] {
  const presentMarkdown = defineTool({
    name: "present_markdown",
    label: "Present markdown",
    description: "Present a concise titled tutorial explanation or instruction in the browser transcript.",
    parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 160 }), markdown: Type.String({ minLength: 1, maxLength: 12_000 }) }),
    async execute(_id, params) {
      deps.emit({ type: "presentation", presentation: { kind: "markdown", title: text(params.title, 160, "title"), markdown: text(params.markdown, 12_000, "markdown") } });
      return { content: [{ type: "text", text: `Presented: ${params.title}` }], details: { title: params.title } };
    }
  });

  const presentDiagram = defineTool({
    name: "present_diagram",
    label: "Present diagram",
    description: "Present a Mermaid diagram with an accessible text fallback in the browser transcript.",
    parameters: Type.Object({
      title: Type.String({ minLength: 1, maxLength: 160 }),
      mermaid: Type.String({ minLength: 1, maxLength: 12_000 }),
      text: Type.String({ minLength: 1, maxLength: 4_000 })
    }),
    async execute(_id, params) {
      deps.emit({ type: "presentation", presentation: { kind: "diagram", title: text(params.title, 160, "title"), mermaid: text(params.mermaid, 12_000, "mermaid"), text: text(params.text, 4_000, "text") } });
      return { content: [{ type: "text", text: `Presented diagram: ${params.title}` }], details: { title: params.title } };
    }
  });

  const offerChoices = defineTool({
    name: "offer_choices",
    label: "Offer choices",
    description: "Ask one fixed, short choice question that gives the learner control over the next tutorial step. Use it before making a change and after each guided step. Waits for a browser selection.",
    executionMode: "sequential",
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 1_000 }),
      options: Type.Array(choiceOptionSchema, { minItems: 2, maxItems: 6 })
    }),
    async execute(toolCallId, params, signal) {
      const options = params.options as ChoiceOption[];
      if (new Set(options.map((option) => option.id)).size !== options.length) throw new Error("Choice option IDs must be unique.");
      const question = text(params.question, 1_000, "question");
      deps.emit({ type: "choice", id: toolCallId, question, options });
      deps.setRunState("awaiting-choice");
      const selected = await deps.choices.wait(toolCallId, options, signal);
      deps.emit({ type: "choice-resolved", id: toolCallId, optionId: selected });
      deps.setRunState("working");
      return { content: [{ type: "text", text: `Learner selected: ${selected}` }], details: { selected } };
    }
  });

  const runValidation = defineTool({
    name: "run_validation",
    label: "Run validation",
    description: `Run one allowlisted validation command for this lesson. Allowed command IDs: ${deps.validation.commandIds.join(", ")}.`,
    executionMode: "sequential",
    parameters: Type.Object({ commandId: Type.String({ minLength: 1, maxLength: 100 }) }),
    async execute(_id, params, _signal, onUpdate) {
      const commandId = text(params.commandId, 100, "commandId");
      const command = deps.lesson.validationCommands.find((item) => item.id === commandId);
      if (!command) throw new Error(`Validation command '${commandId}' is not allowed.`);
      let output = "";
      const result = await deps.validation.run(commandId, (chunk) => {
        output += chunk;
        onUpdate?.({ content: [{ type: "text", text: chunk }], details: { output } });
      });
      deps.emit({ type: "validation", id: commandId, label: command.label, ...result });
      return { content: [{ type: "text", text: result.passed ? "Validation passed." : "Validation failed." }], details: result };
    }
  });

  const showFileExcerpt = defineTool({
    name: "show_file_excerpt",
    label: "Show file excerpt",
    description: "Show a small relevant file excerpt from the kata workspace. Do not use it for whole files.",
    parameters: Type.Object({
      title: Type.String({ minLength: 1, maxLength: 160 }),
      path: Type.String({ minLength: 1, maxLength: 500 }),
      startLine: Type.Integer({ minimum: 1, maximum: 100_000 }),
      endLine: Type.Integer({ minimum: 1, maximum: 100_000 })
    }),
    async execute(_id, params) {
      if (params.endLine < params.startLine || params.endLine - params.startLine > 200) throw new Error("Excerpt must contain at most 201 lines.");
      let auditPath = params.path.replaceAll("\\", "/");
      try {
        const safePath = await deps.boundary.resolve(params.path);
        auditPath = safePath.relative;
        const lines = (await readFile(safePath.absolute, "utf8")).split(/\r?\n/);
        const selected = lines.slice(params.startLine - 1, params.endLine);
        const content = selected.join("\n");
        deps.emit({ type: "audit", id: _id, tool: "show_file_excerpt", paths: [auditPath], mutation: false, outcome: "ok" });
        deps.emit({ type: "file-excerpt", title: text(params.title, 160, "title"), path: auditPath, startLine: params.startLine, content, truncated: params.endLine < lines.length });
        return { content: [{ type: "text", text: `Displayed ${auditPath}:${params.startLine}-${params.endLine}` }], details: { path: auditPath, startLine: params.startLine, endLine: params.endLine } };
      } catch (error) {
        deps.emit({ type: "audit", id: _id, tool: "show_file_excerpt", paths: [auditPath], mutation: false, outcome: "rejected", message: error instanceof Error ? error.message : "Workspace path rejected." });
        throw error;
      }
    }
  });

  return [presentMarkdown, presentDiagram, offerChoices, runValidation, showFileExcerpt];
}
