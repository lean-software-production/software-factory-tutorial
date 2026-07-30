/** The stable, TypeScript-first contract supplied by a kata. */
export interface ValidationCommand {
  /** Stable identifier referenced by the agent and browser protocol. */
  id: string;
  /** Human-readable label shown in the transcript. */
  label: string;
  /** Executable and arguments; never interpreted by a shell. */
  command: string;
  args?: string[];
  /** Optional timeout, capped by the engine at two minutes. */
  timeoutMs?: number;
}

export interface MarkdownPresentation {
  kind: "markdown";
  title: string;
  markdown: string;
}

export interface DiagramPresentation {
  kind: "diagram";
  title: string;
  mermaid: string;
  /** Text equivalent required for learners who cannot use the diagram. */
  text: string;
}

export type InitialPresentation = MarkdownPresentation | DiagramPresentation;

export interface LessonDefinition {
  title: string;
  /** The directory in which kata files and validation commands run. */
  workspace: string;
  /** Directory containing the iteration ledger; defaults to docs/specs. */
  specsDirectory?: string;
  validationCommands: ValidationCommand[];
  coachingPrompt: string;
  rules?: string[];
  initialContent?: InitialPresentation[];
  /** Optional action labels a kata wants to expose before coaching begins. */
  allowedActions?: string[];
}

export function isLessonDefinition(value: unknown): value is LessonDefinition {
  if (!value || typeof value !== "object") return false;
  const lesson = value as Partial<LessonDefinition>;
  return (
    typeof lesson.title === "string" &&
    typeof lesson.workspace === "string" &&
    typeof lesson.coachingPrompt === "string" &&
    Array.isArray(lesson.validationCommands) &&
    lesson.validationCommands.every(
      (command) =>
        command &&
        typeof command.id === "string" &&
        typeof command.label === "string" &&
        typeof command.command === "string" &&
        (command.args === undefined || (Array.isArray(command.args) && command.args.every((arg) => typeof arg === "string")))
    )
  );
}
