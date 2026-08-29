/**
 * The workbook's content contract. Every authored document is Markdown with
 * YAML front matter; the front matter carries only machine data, and every
 * title is a Markdown heading, never a front-matter value. Folder position
 * determines a document's kind, so there is no `kind` field anywhere here.
 */

export type WorkbookBlockType = "narrative" | "terminal-practice" | "editor-practice" | "reflection";

const BLOCK_TYPES: readonly WorkbookBlockType[] = ["narrative", "terminal-practice", "editor-practice", "reflection"];
const TUTOR_REQUIRED_TYPES = new Set<WorkbookBlockType>(["terminal-practice", "editor-practice", "reflection"]);
/** Interactive blocks carry a private tutor rubric and a mandatory learner-facing learning outcome. */
const OUTCOME_REQUIRED_TYPES = TUTOR_REQUIRED_TYPES;

/** Every block gets its id from its filename, its title from its H2, and its body as learner Markdown. */
export interface WorkbookBlockBase { id: string; type: WorkbookBlockType; title: string; markdown: string; }
export interface NarrativeBlock extends WorkbookBlockBase { type: "narrative"; }
export interface TerminalPracticeBlock extends WorkbookBlockBase { type: "terminal-practice"; outcome: string; tutor: string; }
export interface EditorPracticeBlock extends WorkbookBlockBase { type: "editor-practice"; outcome: string; path: string; tutor: string; }
export interface ReflectionBlock extends WorkbookBlockBase { type: "reflection"; outcome: string; tutor: string; }
export type WorkbookBlock = NarrativeBlock | TerminalPracticeBlock | EditorPracticeBlock | ReflectionBlock;

/** The assembled lesson: title, compact dek, and possibly empty full introduction come from lesson.md. */
export interface WorkbookLesson {
  id: string;
  title: string;
  dek: string;
  introduction: string;
  durationMinutes: number;
  workspace?: string;
  outcomes: string[];
  blocks: WorkbookBlock[];
}

/** Workbook identity is the resolved title of workbook.md's single H1. */
export interface WorkbookIdentity { title: string; }

export interface WorkbookPartManifest { id: string; lessons: string[]; }
export interface WorkbookManifest { parts?: WorkbookPartManifest[]; }
/** No part-level structured field is defined yet, so front matter must be an empty map. */
export interface PartManifest {}

export interface LessonFrontMatter { durationMinutes: number; blocks: string[]; workspace?: string; }
export interface BlockFrontMatter { type: WorkbookBlockType; path?: string; tutor?: string; outcome?: string; }

const BLOCK_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
export const WORKBOOK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const LESSON_WORKSPACE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isNonEmptyString(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function rejectUnknownFields(data: Record<string, unknown>, allowed: readonly string[], location: string, errors: string[]): void {
  for (const key of Object.keys(data)) if (!allowed.includes(key)) errors.push(`${location}: unknown front matter field "${key}"`);
}

function fail(location: string, errors: string[]): never {
  throw new Error(`Invalid ${location}:\n- ${errors.join("\n- ")}`);
}

/** Shared shape for workbook.md and part.md front matter: no fields are defined yet. */
function validateEmptyManifest(data: unknown, location: string): Record<string, never> {
  const errors: string[] = [];
  if (!isPlainObject(data)) errors.push(`${location}: front matter must be a YAML mapping (use an empty --- / --- block if it has no fields).`);
  else rejectUnknownFields(data, [], location, errors);
  if (errors.length) fail(location, errors);
  return {};
}

/** Validate workbook.md's front matter: optional ordered parts that assign flat lesson ids. */
export function validateWorkbookManifest(data: unknown, location = "workbook.md"): WorkbookManifest {
  const errors: string[] = [];
  if (!isPlainObject(data)) fail(location, [`${location}: front matter must be a YAML mapping (use an empty --- / --- block if it has no fields).`]);
  const record = data as Record<string, unknown>;
  rejectUnknownFields(record, ["parts"], location, errors);

  if (record.parts === undefined) {
    if (errors.length) fail(location, errors);
    return {};
  }
  if (!Array.isArray(record.parts) || record.parts.length === 0) {
    errors.push(`${location}: parts must be a non-empty list when present`);
  } else {
    const partIds = new Set<string>();
    record.parts.forEach((part, index) => {
      const path = `${location}: parts[${index}]`;
      if (!isPlainObject(part)) { errors.push(`${path} must be a mapping`); return; }
      rejectUnknownFields(part, ["id", "lessons"], `${location}: parts[${index}]`, errors);
      const id = part.id;
      if (!isNonEmptyString(id) || !WORKBOOK_ID_PATTERN.test(id)) errors.push(`${path}.id is malformed; use a lowercase-hyphenated flat id`);
      else if (partIds.has(id)) errors.push(`${path}.id duplicates part "${id}"`);
      else partIds.add(id);
      const lessons = part.lessons;
      if (!Array.isArray(lessons) || lessons.length === 0) {
        errors.push(`${path}.lessons must be a non-empty list of flat lesson ids`);
      } else {
        const local = new Set<string>();
        for (const lesson of lessons) {
          if (!isNonEmptyString(lesson) || !WORKBOOK_ID_PATTERN.test(lesson)) errors.push(`${path}.lessons contains malformed lesson id "${String(lesson)}"`);
          else if (local.has(lesson)) errors.push(`${path}.lessons duplicates lesson "${lesson}"`);
          else local.add(lesson);
        }
      }
    });
  }

  if (errors.length) fail(location, errors);
  return record as unknown as WorkbookManifest;
}

/** Validate a part.md's front matter. No structured field is defined yet; only an empty map is valid. */
export function validatePartManifest(data: unknown, location = "part.md"): PartManifest {
  return validateEmptyManifest(data, location);
}

/** Validate a lesson.md's raw front matter: duration and ordered block ids. Learning outcomes are derived from the blocks. */
export function validateLessonFrontMatter(data: unknown, location: string): LessonFrontMatter {
  const errors: string[] = [];
  if (!isPlainObject(data)) fail(location, [`${location}: front matter must be a YAML mapping.`]);
  const record = data as Record<string, unknown>;
  rejectUnknownFields(record, ["durationMinutes", "blocks", "workspace"], location, errors);

  const duration = record.durationMinutes;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) errors.push(`${location}: durationMinutes must be a positive number`);

  const blocks = record.blocks;
  if (!isStringArray(blocks) || blocks.length === 0 || blocks.some((id) => !BLOCK_ID_PATTERN.test(id))) {
    errors.push(`${location}: blocks must be a non-empty ordered list of lowercase-hyphenated block ids`);
  } else {
    const seen = new Set<string>();
    for (const id of blocks) {
      if (seen.has(id)) errors.push(`${location}: blocks lists "${id}" more than once`);
      seen.add(id);
    }
  }

  const workspace = record.workspace;
  if (workspace !== undefined && (!isNonEmptyString(workspace) || !LESSON_WORKSPACE_PATTERN.test(workspace))) {
    errors.push(`${location}: workspace must be a lowercase-hyphenated workspace id`);
  }

  if (errors.length) fail(location, errors);
  return { durationMinutes: duration as number, blocks: blocks as string[], workspace: workspace as string | undefined };
}

/** Validate one block's raw front matter: its type, and a private tutor field required only for interactive types. */
export function validateBlockFrontMatter(data: unknown, location: string): BlockFrontMatter {
  const errors: string[] = [];
  if (!isPlainObject(data)) fail(location, [`${location}: front matter must be a YAML mapping.`]);
  const record = data as Record<string, unknown>;
  rejectUnknownFields(record, ["type", "path", "tutor", "outcome"], location, errors);

  const type = record.type;
  const validType = typeof type === "string" && (BLOCK_TYPES as readonly string[]).includes(type);
  if (!validType) errors.push(`${location}: type must be one of ${BLOCK_TYPES.join(", ")}`);

  const path = record.path;
  if (validType && type === "editor-practice") {
    if (!isNonEmptyString(path)) errors.push(`${location}: path is required for editor-practice blocks and must be a non-empty string`);
  } else if (path !== undefined) {
    errors.push(`${location}: path is only allowed for editor-practice blocks`);
  }

  const tutor = record.tutor;
  const tutorRequired = validType && TUTOR_REQUIRED_TYPES.has(type as WorkbookBlockType);
  if (tutorRequired) {
    if (!isNonEmptyString(tutor)) errors.push(`${location}: tutor is required for ${type} blocks and must be a non-empty private string`);
  } else if (tutor !== undefined) {
    errors.push(`${location}: tutor is only allowed for terminal-practice, editor-practice, and reflection blocks`);
  }

  const outcome = record.outcome;
  const outcomeRequired = validType && OUTCOME_REQUIRED_TYPES.has(type as WorkbookBlockType);
  if (outcomeRequired) {
    if (!isNonEmptyString(outcome)) errors.push(`${location}: outcome is required for ${type} blocks and must be a non-empty learning outcome`);
  } else if (outcome !== undefined) {
    errors.push(`${location}: outcome is only allowed for terminal-practice, editor-practice, and reflection blocks`);
  }

  if (errors.length) fail(location, errors);
  return {
    type: type as WorkbookBlockType,
    path: isNonEmptyString(path) ? path : undefined,
    tutor: isNonEmptyString(tutor) ? tutor : undefined,
    outcome: isNonEmptyString(outcome) ? outcome : undefined,
  };
}

/** Validate a fully assembled lesson: its resolved title/dek/introduction/duration/outcomes and ordered typed blocks. */
export function validateWorkbookLesson(value: unknown, location = "lesson"): WorkbookLesson {
  const errors: string[] = [];
  const lesson = value as Partial<WorkbookLesson> | null;
  if (!lesson || typeof lesson !== "object") throw new Error(`${location} must be an object.`);

  if (!isNonEmptyString(lesson.id)) errors.push(`${location}.id is required`);
  if (!isNonEmptyString(lesson.title)) errors.push(`${location}.title is required`);
  if (!isNonEmptyString(lesson.dek)) errors.push(`${location}.dek is required`);
  if (typeof lesson.introduction !== "string") errors.push(`${location}.introduction is required and must be a string`);
  if (typeof lesson.durationMinutes !== "number" || !Number.isFinite(lesson.durationMinutes) || lesson.durationMinutes <= 0) errors.push(`${location}.durationMinutes must be a positive number`);
  if (lesson.workspace !== undefined && (!isNonEmptyString(lesson.workspace) || !LESSON_WORKSPACE_PATTERN.test(lesson.workspace))) errors.push(`${location}.workspace must be a lowercase-hyphenated workspace id`);
  const hasWorkspaceRequiredBlock = Array.isArray(lesson.blocks) && lesson.blocks.some((block) => block && (block.type === "terminal-practice" || block.type === "editor-practice"));
  if (hasWorkspaceRequiredBlock && !isNonEmptyString(lesson.workspace)) errors.push(`${location}.workspace is required when a lesson has terminal-practice or editor-practice blocks`);
  const hasInteractiveBlock = Array.isArray(lesson.blocks) && lesson.blocks.some((block) => block && block.type !== "narrative");
  if (!isStringArray(lesson.outcomes)) errors.push(`${location}.outcomes must be a list of strings`);
  else if (hasInteractiveBlock && (lesson.outcomes.length === 0 || lesson.outcomes.some((item) => !isNonEmptyString(item)))) errors.push(`${location}.outcomes must be a non-empty list of non-empty strings derived from its interactive blocks`);

  const ids = new Set<string>();
  if (!Array.isArray(lesson.blocks) || lesson.blocks.length === 0) errors.push(`${location}.blocks must contain ordered block instances`);
  else lesson.blocks.forEach((block: any, index) => {
    const path = `${location}.blocks[${index}]`;
    if (!block || typeof block !== "object") { errors.push(`${path} must be an object`); return; }
    if (!isNonEmptyString(block.id)) errors.push(`${path}.id is required`);
    else if (ids.has(block.id)) errors.push(`${path}.id must be unique`);
    else ids.add(block.id);
    const validType = (BLOCK_TYPES as readonly string[]).includes(block.type);
    if (!validType) errors.push(`${path}.type is unsupported`);
    if (!isNonEmptyString(block.title)) errors.push(`${path}.title is required`);
    if (!isNonEmptyString(block.markdown)) errors.push(`${path}.markdown is required`);
    if (validType && block.type === "editor-practice") {
      if (!isNonEmptyString(block.path)) errors.push(`${path}.path is required`);
    } else if (block.path !== undefined) errors.push(`${path}.path is not allowed for ${block.type} blocks`);
    const tutorRequired = validType && TUTOR_REQUIRED_TYPES.has(block.type as WorkbookBlockType);
    if (tutorRequired) { if (!isNonEmptyString(block.tutor)) errors.push(`${path}.tutor is required`); }
    else if (block.tutor !== undefined) errors.push(`${path}.tutor is not allowed for ${block.type} blocks`);
    const outcomeRequired = validType && OUTCOME_REQUIRED_TYPES.has(block.type as WorkbookBlockType);
    if (outcomeRequired) {
      const outcome = (block as Extract<WorkbookBlock, { outcome: string }>).outcome;
      if (!isNonEmptyString(outcome)) errors.push(`${path}.outcome is required`);
    } else if ((block as { outcome?: unknown }).outcome !== undefined) errors.push(`${path}.outcome is not allowed for ${block.type} blocks`);
  });

  if (errors.length) fail(location, errors);
  return lesson as WorkbookLesson;
}
