import type { TutorialLogger } from "../../src/workbook/runtime-log.js";
import type { WorkbookUxTestStepDeclaration } from "./steps.js";
import { REQUIRED_STATE_CHECKPOINT_STEP_IDS, SCROLL_CHECKPOINT_STEP_IDS } from "./steps.js";

export const WORKBOOK_UX_SEMANTIC_CHECKPOINT_TOTAL = REQUIRED_STATE_CHECKPOINT_STEP_IDS.length + SCROLL_CHECKPOINT_STEP_IDS.length;

export type WorkbookUxProgressPhase = "prepare" | "record" | "finalize-video" | "decode" | "ai" | "report" | "deterministic";

export type WorkbookUxProgressEvent =
  | { readonly type: "stage"; readonly phase: WorkbookUxProgressPhase; readonly message: string; readonly stage?: number; readonly totalStages?: number }
  | { readonly type: "checkpoint"; readonly completed: number; readonly total: number; readonly stepId: number; readonly stepName: string; readonly message: string }
  | { readonly type: "detail"; readonly message: string; readonly severity?: "info" | "error"; readonly source?: "server" | "recorder" | "analyzer" | "ai" | "report" }
  | { readonly type: "status"; readonly phase: WorkbookUxProgressPhase; readonly status: "passed" | "failed" | "skipped" | "unavailable" | "complete"; readonly message: string };

export type WorkbookUxProgressSink = (event: WorkbookUxProgressEvent) => void;

export function formatWorkbookUxStage(stage: number, totalStages: number, message: string): string {
  return `[${stage}/${totalStages}] ${message}`;
}

export function formatWorkbookUxCheckpointProgress(completed: number, total: number, stepName: string): string {
  return `Checkpoint ${completed}/${total}: ${stepName}`;
}

export function checkpointProgressEvent(completed: number, total: number, step: WorkbookUxTestStepDeclaration): WorkbookUxProgressEvent {
  return {
    type: "checkpoint",
    completed,
    total,
    stepId: step.id,
    stepName: step.name,
    message: formatWorkbookUxCheckpointProgress(completed, total, step.name),
  };
}

export const QUIET_WORKBOOK_UX_LOGGER: TutorialLogger = {
  info() {},
  error() {},
};

export function createWorkbookUxProgressLogger(progress: WorkbookUxProgressSink | undefined): TutorialLogger {
  if (!progress) return QUIET_WORKBOOK_UX_LOGGER;
  return {
    info(message) {
      progress({ type: "detail", source: "server", severity: "info", message: `  server: ${message}` });
    },
    error(message, error) {
      const detail = error instanceof Error ? error.stack ?? error.message : error === undefined ? "" : String(error);
      progress({
        type: "detail",
        source: "server",
        severity: "error",
        message: `  server error: ${detail ? `${message}: ${detail.replaceAll("\n", " | ")}` : message}`,
      });
    },
  };
}
