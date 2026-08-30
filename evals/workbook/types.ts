import type { PublicAttemptKind, PublicEditorStatus, PublicTerminal, PublicWorkbookState } from "../../tutorial-engine/src/workbook/public-contract.js";
import type { WorkbookTimelineRecord } from "../../tutorial-engine/src/workbook/timeline.js";

export const AUTHORED_WORKBOOK_EVAL_NAMESPACE = "root/workbook" as const;
export const AUTHORED_WORKBOOK_EVAL_OWNER = "root" as const;
export const AUTHORED_WORKBOOK_EVAL_SUITE = "workbook" as const;
export const AUTHORED_WORKBOOK_EVAL_SCHEMA_VERSION = 1 as const;

export const AUTHORED_WORKBOOK_EVAL_MARKERS = Object.freeze({
  namespace: AUTHORED_WORKBOOK_EVAL_NAMESPACE,
  owner: AUTHORED_WORKBOOK_EVAL_OWNER,
  suite: AUTHORED_WORKBOOK_EVAL_SUITE,
  schemaVersion: AUTHORED_WORKBOOK_EVAL_SCHEMA_VERSION
});

export type AuthoredWorkbookEvalMarkers = typeof AUTHORED_WORKBOOK_EVAL_MARKERS;

export type { PublicWorkbookState } from "../../tutorial-engine/src/workbook/public-contract.js";

export interface AuthoredWorkbookEvalRecordedPublicState {
  label: string;
  state: PublicWorkbookState;
}

export interface AuthoredWorkbookEvalJudgeTextMetadata {
  bytes: number;
}

export interface AuthoredWorkbookEvalJudgeTimelineMessage {
  type: "message";
  id: string;
  sequence: number;
  lessonId: string;
  blockId: string;
  role: "assistant" | "user";
  source: "authored" | "learner" | "main_tutor";
  presentation: "course" | "chat" | "review";
  blockInView?: string;
  text: AuthoredWorkbookEvalJudgeTextMetadata;
}

export interface AuthoredWorkbookEvalJudgeTutorFailure {
  type: "tutor_failed";
  id: string;
  sequence: number;
  lessonId: string;
  blockId: string;
  operation: string;
  publicMessage: AuthoredWorkbookEvalJudgeTextMetadata;
}

export type AuthoredWorkbookEvalJudgeTimelineRecord = AuthoredWorkbookEvalJudgeTimelineMessage | AuthoredWorkbookEvalJudgeTutorFailure;

export interface AuthoredWorkbookEvalJudgeBlockReference {
  id: string;
  anchorId?: string;
  origin?: string;
  kind?: string;
  type?: string;
  title?: string;
  lessonId?: string;
  declaredId?: string;
  order?: number;
  path?: string;
  workAccepted?: boolean;
}

export interface AuthoredWorkbookEvalJudgeCheckpoint {
  status: "working" | "reviewing" | "feedback" | "accepted";
  feedback?: AuthoredWorkbookEvalJudgeTextMetadata;
  successMessage?: AuthoredWorkbookEvalJudgeTextMetadata;
  summary?: AuthoredWorkbookEvalJudgeTextMetadata;
  evidence?: { kind: PublicAttemptKind; text?: AuthoredWorkbookEvalJudgeTextMetadata; conversationTurns?: number };
}

export interface AuthoredWorkbookEvalJudgeBlockProgress {
  id: string;
  type?: string;
  anchorId?: string;
  origin?: string;
  kind?: string;
  title?: string;
  ready: boolean;
  active: boolean;
  completed: boolean;
  completedAt?: string;
  verified: boolean;
  emerged: boolean;
  workAccepted?: boolean;
  checkpoint?: AuthoredWorkbookEvalJudgeCheckpoint;
  terminal?: PublicTerminal;
  terminalRevision?: number;
  terminalSnapshot?: AuthoredWorkbookEvalJudgeTextMetadata;
  revision?: number;
  editorStatus?: PublicEditorStatus;
}

export interface AuthoredWorkbookEvalJudgePublicState {
  workbook: { title: string };
  introductionComplete: boolean;
  active: { lessonId: string; blockId: string; anchorId?: string };
  completedLessons: string[];
  completedBlocks?: string[];
  workAcceptedBlocks?: string[];
  readyBlocks?: string[];
  revealedBlockIds?: string[];
  renderedBlockIds?: string[];
  readyBlockIds?: string[];
  currentBlock?: AuthoredWorkbookEvalJudgeBlockReference;
  completion?: { complete: true; anchorId: string; summary?: AuthoredWorkbookEvalJudgeTextMetadata };
  chapters: Array<{ id: string; title: string; partId?: string; part?: string; partNumber?: number; lessonNumber: number; lesson?: { id: string; title: string; durationMinutes: number; outcomes: string[]; blockCount: number; blocks: AuthoredWorkbookEvalJudgeBlockReference[] } }>;
  orderedBlocks?: AuthoredWorkbookEvalJudgeBlockReference[];
  progressBlocks: AuthoredWorkbookEvalJudgeBlockProgress[];
  reflectionBlocks: string[];
  reflectionConversations: Array<{ blockId: string; turns: number; roles: Array<"learner" | "tutor"> }>;
  canComplete?: { blockId: string; eligible: boolean; reason?: string };
  workbookComplete?: boolean;
  adapter: { modelBackedHelp?: boolean; note?: AuthoredWorkbookEvalJudgeTextMetadata };
  timelineNewRecords: AuthoredWorkbookEvalJudgeTimelineRecord[];
}

export interface AuthoredWorkbookEvalJudgeRecordedPublicState {
  label: string;
  state: AuthoredWorkbookEvalJudgePublicState;
}

export interface AuthoredWorkbookEvalTerminalTranscriptEntry {
  blockId?: string;
  direction: "input" | "output" | "observer";
  text: string;
  at?: string;
}

export type AuthoredWorkbookEvalPublicTerminalTranscriptEntry = Omit<AuthoredWorkbookEvalTerminalTranscriptEntry, "at">;

export interface AuthoredWorkbookEvalReflectionEntry {
  blockId: string;
  role: "learner" | "tutor";
  text: string;
  at?: string;
}

export type AuthoredWorkbookEvalPublicReflectionEntry = Omit<AuthoredWorkbookEvalReflectionEntry, "at">;

export interface AuthoredWorkbookEvalEditorEntry {
  blockId: string;
  revision: number;
  status: "reviewing" | "feedback" | "unlocked";
  feedback?: string;
  at?: string;
}

export type AuthoredWorkbookEvalPublicEditorEntry = Omit<AuthoredWorkbookEvalEditorEntry, "at">;

export interface AuthoredWorkbookEvalArtifactSnapshot {
  path: string;
  content: string;
}

/**
 * In-memory trace for authored-workbook deterministic gates.
 *
 * `internalEvents` may contain raw workbook timeline rows, including private attempt IDs, evidence
 * refs, terminal lifecycle records, private Tutor/Coach handoffs, paths, and future fields. Do not
 * serialize this type into judge prompts, public reports, or durable eval artifacts. First project it
 * with `projectAuthoredWorkbookEvalTrace`, which rebuilds the public trace from allowlisted fields.
 */
export interface AuthoredWorkbookEvalSessionTrace {
  scenarioId: string;
  publicStates: AuthoredWorkbookEvalRecordedPublicState[];
  terminalTranscript: AuthoredWorkbookEvalTerminalTranscriptEntry[];
  reflections: AuthoredWorkbookEvalReflectionEntry[];
  editors: AuthoredWorkbookEvalEditorEntry[];
  internalEvents: WorkbookTimelineRecord[];
  artifacts: AuthoredWorkbookEvalArtifactSnapshot[];
}

export type AuthoredWorkbookEvalProgressionEvent =
  | { type: "session_started" }
  | { type: "workbook_introduction_completed" }
  | { type: "attempt_accepted"; lessonId: string; blockId: string; kind: PublicAttemptKind }
  | { type: "work_accepted"; blockId: string }
  | { type: "block_completed"; lessonId?: string; blockId: string }
  | { type: "reflection_submitted"; lessonId: string; blockId: string }
  | { type: "reflection_follow_up_submitted"; lessonId: string; blockId: string }
  | { type: "reflection_reply_recorded"; lessonId: string; blockId: string }
  | { type: "observation_acknowledged"; lessonId: string; blockId: string; kind: "terminal" }
  | { type: "observation_verified"; lessonId: string; blockId: string; kind: "terminal" }
  | { type: "block_continued"; lessonId: string; blockId: string }
  | { type: "reflection_completed"; lessonId: string; blockId: string }
  | { type: "editor_practice_unlocked"; lessonId: string; blockId: string; kind: "editor" }
  | { type: "lesson_transitioned"; lessonId: string; blockId: string };

/** Serializable, browser-public trace retained for deterministic gates before Judge/report compaction. */
export interface AuthoredWorkbookEvalTrace {
  scenarioId: string;
  publicStates: AuthoredWorkbookEvalRecordedPublicState[];
  terminalTranscript: AuthoredWorkbookEvalPublicTerminalTranscriptEntry[];
  reflections: AuthoredWorkbookEvalPublicReflectionEntry[];
  editors: AuthoredWorkbookEvalPublicEditorEntry[];
  progressionEvents: AuthoredWorkbookEvalProgressionEvent[];
  artifacts: AuthoredWorkbookEvalArtifactSnapshot[];
}

/** Serializable structural trace shown to Judge and written to curated success reports. */
export interface AuthoredWorkbookEvalJudgeTrace extends Omit<AuthoredWorkbookEvalTrace, "publicStates"> {
  publicStates: AuthoredWorkbookEvalJudgeRecordedPublicState[];
}

export type AuthoredWorkbookEvalCitation =
  | { id: number; kind: "publicState"; ref: { index: number; label: string } }
  | { id: number; kind: "terminalTranscript"; ref: { index: number; blockId?: string } }
  | { id: number; kind: "reflection"; ref: { index: number; blockId: string } }
  | { id: number; kind: "editor"; ref: { index: number; blockId: string; revision: number } }
  | { id: number; kind: "progressionEvent"; ref: { index: number; type: AuthoredWorkbookEvalProgressionEvent["type"] } }
  | { id: number; kind: "artifact"; ref: { index: number; path: string } };
