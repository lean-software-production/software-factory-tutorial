import type { AttemptKind } from "../../src/workbook/attempts.js";
import type { StartedWorkbookServer, WorkbookServerOptions } from "../../src/workbook/server.js";
import type { WorkbookTimelineRecord } from "../../src/workbook/timeline.js";
import type { TutorialSessionPaths } from "../../src/session-workspace.js";

export const V2_ENGINE_EVAL_NAMESPACE = "tutorial-engine/evals/engine-v2" as const;
export const V2_ENGINE_EVAL_OWNER = "tutorial-engine" as const;
export const V2_ENGINE_EVAL_SUITE = "engine-v2" as const;
export const V2_ENGINE_EVAL_SCHEMA_VERSION = 1 as const;

export const V2_ENGINE_EVAL_MARKERS = Object.freeze({
  namespace: V2_ENGINE_EVAL_NAMESPACE,
  owner: V2_ENGINE_EVAL_OWNER,
  suite: V2_ENGINE_EVAL_SUITE,
  schemaVersion: V2_ENGINE_EVAL_SCHEMA_VERSION
});

export type V2EngineEvalMarkers = typeof V2_ENGINE_EVAL_MARKERS;
export type V2EvalRunStatus = "passed" | "failed";
export type V2EvalRunFailureStage = "workspace-creation" | "server-startup" | "session" | "deterministic-gate" | "judge" | "report" | "cleanup" | "metadata" | "unexpected";

export type PublicWorkbookState = Record<string, unknown>;

export interface V2RecordedPublicState {
  label: string;
  state: PublicWorkbookState;
}

export interface V2TerminalTranscriptEntry {
  blockId?: string;
  direction: "input" | "output" | "observer";
  text: string;
  at?: string;
}

export type V2JudgeTerminalTranscriptEntry = Omit<V2TerminalTranscriptEntry, "at">;

export interface V2ReflectionEntry {
  blockId: string;
  role: "learner" | "tutor";
  text: string;
  at?: string;
}

export type V2JudgeReflectionEntry = Omit<V2ReflectionEntry, "at">;

export interface V2EditorEntry {
  blockId: string;
  revision: number;
  status: "reviewing" | "feedback" | "unlocked";
  feedback?: string;
  at?: string;
}

export type V2JudgeEditorEntry = Omit<V2EditorEntry, "at">;

export interface V2ArtifactSnapshot {
  path: string;
  content: string;
}

/**
 * Internal, in-memory trace used only by deterministic evaluator gates.
 *
 * `events` intentionally contains raw `workbook/events.jsonl` timeline records, including private
 * terminal lifecycle rows, evidence IDs, private legacy terminal-coach handoffs, and future fields. Never serialize
 * a `V2SessionTrace` into reports, prompts, or public artifacts; project it to `V2JudgeTrace` first.
 */
export interface V2SessionTrace {
  scenarioId: string;
  publicStates: V2RecordedPublicState[];
  terminalTranscript: V2TerminalTranscriptEntry[];
  reflections: V2ReflectionEntry[];
  editors: V2EditorEntry[];
  events: WorkbookTimelineRecord[];
  artifacts: V2ArtifactSnapshot[];
}

export type V2PublicProgressionEvent =
  | { type: "session_started" }
  | { type: "lesson_jump_started"; lessonId: string }
  | { type: "workbook_introduction_completed" }
  | { type: "attempt_accepted"; lessonId: string; blockId: string; kind: AttemptKind }
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

/** Serializable, allowlisted trace given to judges and written to eval reports. */
export interface V2JudgeTrace {
  scenarioId: string;
  publicStates: V2RecordedPublicState[];
  terminalTranscript: V2JudgeTerminalTranscriptEntry[];
  reflections: V2JudgeReflectionEntry[];
  editors: V2JudgeEditorEntry[];
  progressionEvents: V2PublicProgressionEvent[];
  artifacts: V2ArtifactSnapshot[];
}

export type V2JudgeCitation =
  | { id: number; kind: "publicState"; value: V2RecordedPublicState }
  | { id: number; kind: "terminalTranscript"; value: V2JudgeTerminalTranscriptEntry }
  | { id: number; kind: "reflection"; value: V2JudgeReflectionEntry }
  | { id: number; kind: "editor"; value: V2JudgeEditorEntry }
  | { id: number; kind: "progressionEvent"; value: V2PublicProgressionEvent }
  | { id: number; kind: "artifact"; value: V2ArtifactSnapshot };

export interface EvaluationWorkspace {
  repositoryRoot: string;
  root: string;
  webRoot: string;
  sessions: TutorialSessionPaths[];
  latestSession(): TutorialSessionPaths;
  startServer(options?: Partial<Omit<WorkbookServerOptions, "target" | "webRoot" | "session">>): Promise<StartedWorkbookServer>;
  close(): Promise<void>;
}
