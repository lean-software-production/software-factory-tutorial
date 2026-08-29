import type { StartedWorkbookServer, WorkbookServerOptions } from "../../src/workbook/server.js";
import type { WorkbookTimelineRecord } from "../../src/workbook/timeline.js";
import type { TutorialSessionPaths } from "../../src/session-workspace.js";

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

export interface V2ReflectionEntry {
  blockId: string;
  role: "learner" | "tutor";
  text: string;
  at?: string;
}

export interface V2EditorEntry {
  blockId: string;
  revision: number;
  status: "reviewing" | "feedback" | "unlocked";
  feedback?: string;
  at?: string;
}

export interface V2ArtifactSnapshot {
  path: string;
  content: string;
}

export interface V2SessionTrace {
  scenarioId: string;
  publicStates: V2RecordedPublicState[];
  terminalTranscript: V2TerminalTranscriptEntry[];
  reflections: V2ReflectionEntry[];
  editors: V2EditorEntry[];
  events: WorkbookTimelineRecord[];
  artifacts: V2ArtifactSnapshot[];
}

export interface EvaluationWorkspace {
  repositoryRoot: string;
  root: string;
  webRoot: string;
  sessions: TutorialSessionPaths[];
  latestSession(): TutorialSessionPaths;
  startServer(options?: Partial<Omit<WorkbookServerOptions, "target" | "webRoot" | "session">>): Promise<StartedWorkbookServer>;
  close(): Promise<void>;
}
