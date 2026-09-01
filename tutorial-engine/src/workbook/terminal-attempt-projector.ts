import { validateTerminalEvidence, type TerminalEvidence } from "./terminal-evidence.js";
import type { WorkbookTimelineRecord } from "./timeline.js";

/** The only terminal lifecycle phases that a browser can receive from the server. */
export type TerminalAttemptState = "running" | "checking" | "feedback" | "accepted";

export type ProjectedTerminalAttempt = {
  state: TerminalAttemptState;
  /** Monotonic browser-public revision for submitted attempts on this block; never a private attempt ID. */
  revision: number;
  feedback?: string;
  successMessage?: string;
};

type Attempt = {
  attemptId: string;
  lessonId: string;
  blockId: string;
  command: string;
  terminalSessionId: string;
  revision: number;
  finished: boolean;
  evidence?: TerminalEvidence;
  feedback?: string;
  accepted?: string;
};

function inlineEvidence(record: Extract<WorkbookTimelineRecord, { type: "terminal-command-finished" }>): TerminalEvidence | undefined {
  try { return validateTerminalEvidence(record.evidence); }
  catch { return undefined; }
}

/**
 * Replays private terminal records without I/O. Finished evidence is checked only to establish
 * lifecycle consistency; no evidence, command, or attempt identity reaches the result. An unfinished
 * command from another terminal session is deliberately idle on reopen.
 */
export function projectTerminalAttempts(
  records: readonly WorkbookTimelineRecord[],
  activeTerminalSessionId?: string,
): ReadonlyMap<string, ProjectedTerminalAttempt> {
  const attempts = new Map<string, Attempt>();
  const currentAttemptByBlock = new Map<string, string>();
  const revisionByBlock = new Map<string, number>();

  for (const record of records) {
    switch (record.type) {
      case "terminal-command-submitted": {
        const revision = (revisionByBlock.get(record.blockId) ?? 0) + 1;
        revisionByBlock.set(record.blockId, revision);
        attempts.set(record.attemptId, {
          attemptId: record.attemptId,
          lessonId: record.lessonId,
          blockId: record.blockId,
          command: record.command,
          terminalSessionId: record.terminalSessionId,
          revision,
          finished: false,
        });
        currentAttemptByBlock.set(record.blockId, record.attemptId);
        break;
      }
      case "terminal-command-finished": {
        const attempt = attempts.get(record.attemptId);
        const evidence = attempt && !attempt.finished ? inlineEvidence(record) : undefined;
        if (!attempt || evidence?.kind !== "finished" || evidence.command !== attempt.command) break;
        attempt.finished = true;
        attempt.evidence = evidence;
        break;
      }
      case "terminal-feedback-recorded": {
        const attempt = attempts.get(record.attemptId);
        if (attempt?.finished && record.text.trim()) attempt.feedback = record.text;
        break;
      }
      case "attempt_accepted": {
        const attempt = attempts.get(record.attemptId);
        if (
          attempt
          && record.kind === "terminal"
          && attempt.finished
          && attempt.feedback === undefined
          && attempt.lessonId === record.lessonId
          && attempt.blockId === record.blockId
        ) {
          attempt.accepted = record.summary;
        }
        break;
      }
      default:
        break;
    }
  }

  const projection = new Map<string, ProjectedTerminalAttempt>();
  for (const [blockId, attemptId] of currentAttemptByBlock) {
    const attempt = attempts.get(attemptId);
    if (!attempt) continue;
    // A running shell cannot survive workflow restart. Finished evidence remains projected as
    // checking, but no model review is recovered from it after restart.
    if (!attempt.finished && activeTerminalSessionId && attempt.terminalSessionId !== activeTerminalSessionId) continue;
    if (attempt.accepted !== undefined) projection.set(blockId, { state: "accepted", revision: attempt.revision, successMessage: attempt.accepted });
    else if (attempt.feedback !== undefined) projection.set(blockId, { state: "feedback", revision: attempt.revision, feedback: attempt.feedback });
    else projection.set(blockId, { state: attempt.finished ? "checking" : "running", revision: attempt.revision });
  }
  return projection;
}
