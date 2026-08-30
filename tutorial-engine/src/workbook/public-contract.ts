/** Browser-safe JSON contract for the workbook HTTP API. This module has no Node imports. */
export type PublicWorkbookBlockType = "narrative" | "terminal-practice" | "editor-practice" | "reflection";
export type PublicWorkbookBlockKind = PublicWorkbookBlockType | "workbook-introduction" | "part-preamble" | "lesson-preamble";
export type PublicAttemptKind = "editor" | "terminal" | "reflection";
export type PublicEditorStatus = "editing" | "waiting" | "reviewing" | "feedback" | "unlocked";
/** Browser-safe terminal state: command text, evidence, IDs, legacy terminal-coach handoffs, and rubrics are private. */
export type PublicTerminal =
  | { phase: "running" }
  | { phase: "checking" }
  | { phase: "feedback"; message: string; retryFailureId?: string }
  | { phase: "complete"; message: string };
/** Sanitized, bounded output captured when a terminal attempt is accepted. */
export type PublicTerminalSnapshot = { transcript: string };
export type PublicWorkbookBlock =
  | { id: string; type: "narrative"; title: string; markdown: string }
  | { id: string; type: "terminal-practice"; title: string; markdown: string }
  | { id: string; type: "editor-practice"; title: string; markdown: string; path: string }
  | { id: string; type: "reflection"; title: string; markdown: string };
export interface PublicWorkbookLesson { id: string; title: string; dek: string; introduction: string; durationMinutes: number; outcomes: string[]; blocks: PublicWorkbookBlock[]; }
export interface PublicWorkbookChapter { id: string; title: string; partId?: string; part?: string; partMarkdown?: string; partNumber?: number; lessonNumber: number; lesson?: PublicWorkbookLesson; }
export type PublicReflectionTurn = { role: "learner" | "tutor"; text: string };
export interface PublicCheckpoint { status: "working" | "reviewing" | "feedback" | "accepted"; feedback?: string; successMessage?: string; summary?: string; reviewNotice?: string; evidence?: { kind: PublicAttemptKind; text?: string; conversation?: PublicReflectionTurn[] }; }
export interface PublicWorkbookBlockProgress { id: string; type?: PublicWorkbookBlockKind | string; anchorId?: string; origin?: string; kind?: PublicWorkbookBlockKind | string; title?: string; ready: boolean; active: boolean; completed: boolean; completedAt?: string; verified: boolean; emerged: boolean; workAccepted?: boolean; checkpoint?: PublicCheckpoint; /** Terminal practice never uses the legacy checkpoint fallback. */ terminal?: PublicTerminal; /** Durable historical output for an accepted terminal practice. */ terminalSnapshot?: PublicTerminalSnapshot; revision?: number; draftText?: string; editorStatus?: PublicEditorStatus; }
export interface PublicWorkbookProgress { activeLessonId: string; activeBlockId: string; activeAnchorId?: string; completedLessons: string[]; completedBlocks?: string[]; workAcceptedBlocks?: string[]; readyBlocks?: string[]; blocks: PublicWorkbookBlockProgress[]; reflections: Record<string, string>; reflectionConversations: Record<string, PublicReflectionTurn[]>; canComplete?: { blockId: string; eligible: boolean; reason?: string }; workbookComplete?: boolean; }
export interface PublicWorkbookOrderedBlock { id: string; anchorId: string; origin: string; kind: PublicWorkbookBlockKind | string; title: string; lessonId: string; declaredId?: string; order?: number; }
export type PublicTimelineMessage = { type: "message"; id: string; sequence: number; at: string; lessonId: string; blockId: string; role: "assistant" | "user"; source: "authored" | "learner" | "main_tutor"; presentation: "course" | "chat" | "review"; text: string; blockInView?: string; };
export type PublicTutorFailure = { type: "tutor_failed"; id: string; sequence: number; at: string; lessonId: string; blockId: string; failureId: string; operation: string; publicMessage: string; };
export type PublicTimelineRecord = PublicTimelineMessage | PublicTutorFailure;
export interface PublicWorkbookState { workbook: { title: string }; introduction: string; introductionComplete: boolean; chapters: PublicWorkbookChapter[]; progress: PublicWorkbookProgress; adapter: { note?: string; modelBackedHelp?: boolean }; orderedBlocks?: PublicWorkbookOrderedBlock[]; revealedBlockIds?: string[]; renderedBlockIds?: string[]; readyBlockIds?: string[]; currentBlock?: PublicWorkbookOrderedBlock & { workAccepted?: boolean }; completion?: { complete: true; anchorId: string; summary?: string }; timeline: readonly PublicTimelineRecord[]; }
export type PublicCompleteBlockResult = { outcome: "completed"; state: PublicWorkbookState; navigationTarget: string } | { outcome: "already-completed"; state: PublicWorkbookState } | { outcome: "rejected"; state: PublicWorkbookState; reason: "unrevealed" | "not-current" | "ineligible" };
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === "string"); }
function terminal(value: unknown): value is PublicTerminal {
  if (!record(value)) return false;
  if (value.phase === "running" || value.phase === "checking") return true;
  if (value.phase === "feedback") return typeof value.message === "string" && (value.retryFailureId === undefined || typeof value.retryFailureId === "string");
  return value.phase === "complete" && typeof value.message === "string";
}
function terminalSnapshot(value: unknown): value is PublicTerminalSnapshot { return record(value) && typeof value.transcript === "string"; }
function lesson(value: unknown): value is PublicWorkbookLesson { return record(value) && typeof value.id === "string" && typeof value.title === "string" && typeof value.dek === "string" && typeof value.introduction === "string" && typeof value.durationMinutes === "number" && strings(value.outcomes) && Array.isArray(value.blocks); }
/** Validates fields the browser reads before rendering, without duplicating authored-content validation. */
export function isPublicWorkbookState(value: unknown): value is PublicWorkbookState {
  if (!record(value) || !record(value.workbook) || typeof value.workbook.title !== "string" || typeof value.introduction !== "string" || typeof value.introductionComplete !== "boolean" || !Array.isArray(value.chapters) || !Array.isArray(value.timeline) || !record(value.progress) || !record(value.adapter)) return false;
  if (!value.chapters.every((chapter) => record(chapter) && typeof chapter.id === "string" && typeof chapter.title === "string" && typeof chapter.lessonNumber === "number" && (chapter.lesson === undefined || lesson(chapter.lesson)))) return false;
  const progress = value.progress;
  return typeof progress.activeLessonId === "string" && typeof progress.activeBlockId === "string" && strings(progress.completedLessons) && Array.isArray(progress.blocks) && progress.blocks.every((block) => record(block) && (block.terminal === undefined || terminal(block.terminal)) && (block.terminalSnapshot === undefined || terminalSnapshot(block.terminalSnapshot))) && record(progress.reflections) && record(progress.reflectionConversations);
}
export function parsePublicWorkbookState(value: unknown): PublicWorkbookState { if (!isPublicWorkbookState(value)) throw new Error("Workbook server returned an invalid public state."); return value; }
export function parsePublicCompleteBlockResult(value: unknown): PublicCompleteBlockResult {
  if (!record(value) || !isPublicWorkbookState(value.state)) throw new Error("Workbook server returned an invalid completion response.");
  if (value.outcome === "completed" && typeof value.navigationTarget === "string") return value as PublicCompleteBlockResult;
  if (value.outcome === "already-completed") return value as PublicCompleteBlockResult;
  if (value.outcome === "rejected" && (value.reason === "unrevealed" || value.reason === "not-current" || value.reason === "ineligible")) return value as PublicCompleteBlockResult;
  throw new Error("Workbook server returned an invalid completion response.");
}
