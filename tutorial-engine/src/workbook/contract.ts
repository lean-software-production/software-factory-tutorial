export type WorkbookBlockType = "narrative" | "terminal-practice" | "reflection" | "lesson-transition";

export interface BaseBlock { id: string; type: WorkbookBlockType; title: string; required?: boolean; draft?: boolean; }
export interface NarrativeBlock extends BaseBlock { type: "narrative"; markdown: string; }
export interface TerminalPracticeBlock extends BaseBlock {
  type: "terminal-practice";
  command: string;
  context: string;
  expectedObservation: string;
  help: Record<string, string>;
}
export interface ReflectionBlock extends BaseBlock { type: "reflection"; prompt: string; }
export interface LessonTransitionBlock extends BaseBlock { type: "lesson-transition"; label: string; markdown: string; }
export type WorkbookBlock = NarrativeBlock | TerminalPracticeBlock | ReflectionBlock | LessonTransitionBlock;

export interface WorkbookLesson {
  id: string;
  title: string;
  status: "draft" | "approved";
  keyConcepts: string[];
  learningOutcomes: string[];
  blocks: WorkbookBlock[];
}

export function validateWorkbookLesson(value: unknown): WorkbookLesson {
  const errors: string[] = [];
  const lesson = value as Partial<WorkbookLesson>;
  const ids = new Set<string>();
  if (!lesson || typeof lesson !== "object") throw new Error("Lesson manifest must be an object.");
  if (!lesson.id) errors.push("lesson.id is required");
  if (!lesson.title) errors.push("lesson.title is required");
  if (lesson.status !== "draft" && lesson.status !== "approved") errors.push("lesson.status must be draft or approved");
  if (!Array.isArray(lesson.keyConcepts) || lesson.keyConcepts.some((item) => typeof item !== "string")) errors.push("lesson.keyConcepts must be strings");
  if (!Array.isArray(lesson.learningOutcomes) || lesson.learningOutcomes.some((item) => typeof item !== "string")) errors.push("lesson.learningOutcomes must be strings");
  if (!Array.isArray(lesson.blocks) || lesson.blocks.length === 0) errors.push("lesson.blocks must contain ordered block instances");
  else lesson.blocks.forEach((block, index) => {
    const path = `lesson.blocks[${index}]`;
    if (!block.id) errors.push(`${path}.id is required`);
    else if (ids.has(block.id)) errors.push(`${path}.id must be unique`);
    else ids.add(block.id);
    if (!["narrative", "terminal-practice", "reflection", "lesson-transition"].includes(block.type)) errors.push(`${path}.type is unsupported`);
    if (!block.title) errors.push(`${path}.title is required`);
    if (block.type === "terminal-practice") {
      const practice = block as Partial<TerminalPracticeBlock>;
      if (!practice.command) errors.push(`${path}.command is required`);
      if (!practice.context) errors.push(`${path}.context is required`);
      if (!practice.expectedObservation) errors.push(`${path}.expectedObservation is required`);
    }
    if (block.type === "reflection" && !(block as Partial<ReflectionBlock>).prompt) errors.push(`${path}.prompt is required`);
  });
  if (errors.length) throw new Error(`Invalid workbook lesson:\n- ${errors.join("\n- ")}`);
  return lesson as WorkbookLesson;
}
