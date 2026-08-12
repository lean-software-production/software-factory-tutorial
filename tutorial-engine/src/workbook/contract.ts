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

/** The lesson hero: the authored title, summary line, and metadata chips shown above the opening. */
export interface LessonHero { title: string; dek: string; meta: string[]; }
/** The authored opening argument: its labels, the payoff prose, and the learning outcomes. */
export interface LessonOpening { sectionLabel: string; heading: string; markdown: string; outcomes: string[]; }

export interface WorkbookLesson {
  id: string;
  status: "draft" | "approved";
  hero: LessonHero;
  opening: LessonOpening;
  blocks: WorkbookBlock[];
}

/** Workbook ordering is authored; paths and lesson titles follow file conventions. */
export interface WorkbookPart { title: string; lessons: string[]; }
/** Workbook identity is its sole configured product-level string. */
export interface WorkbookIdentity { title: string; }
export interface WorkbookManifest extends WorkbookIdentity { parts: WorkbookPart[]; }

function isNonEmptyString(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }

/** Validate the structural source that carries the workbook's identity and rail. */
export function validateWorkbookManifest(value: unknown): WorkbookManifest {
  const errors: string[] = [];
  const manifest = value as Partial<WorkbookManifest>;
  if (!manifest || typeof manifest !== "object") throw new Error("workbook.yaml must be an object.");
  if (!isNonEmptyString(manifest.title)) errors.push("workbook.title is required");
  const ids = new Set<string>();
  if (!Array.isArray(manifest.parts) || manifest.parts.length === 0) errors.push("workbook.parts must list at least one part");
  else manifest.parts.forEach((part, partIndex) => {
    const path = `workbook.parts[${partIndex}]`;
    if (!isNonEmptyString(part?.title)) errors.push(`${path}.title is required`);
    if (!Array.isArray(part?.lessons) || part.lessons.length === 0) errors.push(`${path}.lessons must list at least one lesson`);
    else part.lessons.forEach((lesson, lessonIndex) => {
      const lessonPath = `${path}.lessons[${lessonIndex}]`;
      if (!isNonEmptyString(lesson)) errors.push(`${lessonPath} must be a lesson ID`);
      else if (ids.has(lesson)) errors.push(`${lessonPath} must be unique`);
      else ids.add(lesson);
    });
  });
  if (errors.length) throw new Error(`Invalid workbook manifest:\n- ${errors.join("\n- ")}`);
  return manifest as WorkbookManifest;
}

/** Validate an assembled lesson: its hero, opening, and ordered typed blocks. */
export function validateWorkbookLesson(value: unknown): WorkbookLesson {
  const errors: string[] = [];
  const lesson = value as Partial<WorkbookLesson>;
  const ids = new Set<string>();
  if (!lesson || typeof lesson !== "object") throw new Error("Lesson manifest must be an object.");
  if (!isNonEmptyString(lesson.id)) errors.push("lesson.id is required");
  if (lesson.status !== "draft" && lesson.status !== "approved") errors.push("lesson.status must be draft or approved");
  const hero = lesson.hero;
  if (!hero || typeof hero !== "object") errors.push("lesson.hero is required");
  else {
    if (!isNonEmptyString(hero.title)) errors.push("lesson.hero.title is required");
    if (!isNonEmptyString(hero.dek)) errors.push("lesson.hero.dek is required");
    if (!Array.isArray(hero.meta) || hero.meta.some((item) => typeof item !== "string")) errors.push("lesson.hero.meta must be strings");
  }
  const opening = lesson.opening;
  if (!opening || typeof opening !== "object") errors.push("lesson.opening is required");
  else {
    if (!isNonEmptyString(opening.sectionLabel)) errors.push("lesson.opening.sectionLabel is required");
    if (!isNonEmptyString(opening.heading)) errors.push("lesson.opening.heading is required");
    if (!isNonEmptyString(opening.markdown)) errors.push("lesson.opening.markdown is required");
    if (!Array.isArray(opening.outcomes) || opening.outcomes.some((item) => typeof item !== "string")) errors.push("lesson.opening.outcomes must be strings");
  }
  if (!Array.isArray(lesson.blocks) || lesson.blocks.length === 0) errors.push("lesson.blocks must contain ordered block instances");
  else lesson.blocks.forEach((block, index) => {
    const path = `lesson.blocks[${index}]`;
    if (!block.id) errors.push(`${path}.id is required`);
    else if (ids.has(block.id)) errors.push(`${path}.id must be unique`);
    else ids.add(block.id);
    if (!["narrative", "terminal-practice", "reflection", "lesson-transition"].includes(block.type)) errors.push(`${path}.type is unsupported`);
    if (!block.title) errors.push(`${path}.title is required`);
    if (block.type === "narrative" && !isNonEmptyString((block as Partial<NarrativeBlock>).markdown)) errors.push(`${path}.markdown is required`);
    if (block.type === "terminal-practice") {
      const practice = block as Partial<TerminalPracticeBlock>;
      if (!practice.command) errors.push(`${path}.command is required`);
      if (!practice.context) errors.push(`${path}.context is required`);
      if (!practice.expectedObservation) errors.push(`${path}.expectedObservation is required`);
    }
    if (block.type === "reflection" && !(block as Partial<ReflectionBlock>).prompt) errors.push(`${path}.prompt is required`);
    if (block.type === "lesson-transition") {
      const transition = block as Partial<LessonTransitionBlock>;
      if (!transition.label) errors.push(`${path}.label is required`);
      if (!isNonEmptyString(transition.markdown)) errors.push(`${path}.markdown is required`);
    }
  });
  if (errors.length) throw new Error(`Invalid workbook lesson:\n- ${errors.join("\n- ")}`);
  return lesson as WorkbookLesson;
}
