export interface ValidationCommand {
  /** Stable identifier referenced by the browser protocol. */
  id: string;
  /** Human-readable label shown in the transcript. */
  label: string;
  /** Executable and arguments; never interpreted by a shell. */
  command: string;
  args?: string[];
  /** Optional timeout, capped by the engine at two minutes. */
  timeoutMs?: number;
}

/** Internal tutorial information inferred from the tutorial directory. */
export interface LessonDefinition {
  title: string;
  workspace: string;
  validationCommands: ValidationCommand[];
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
