import type { TerminalEvidenceReader } from "./terminal-evidence.js";
import type { WorkbookTimelineRecord } from "./timeline.js";
import { canStartManualTerminalReview, terminalReviewCallCounts, type TerminalReviewRequestLike } from "./terminal-review-policy.js";

/** The only terminal lifecycle phases that a browser can receive from the server. */
export type TerminalAttemptState = "running" | "checking" | "feedback" | "complete";

export type ProjectedTerminalAttempt = {
  state: TerminalAttemptState;
  /** Monotonic browser-public revision for submitted attempts on this block; never a private attempt ID. */
  revision: number;
  feedback?: string;
  successMessage?: string;
  /** Browser-safe entitlement for terminal-local review retry; never an attempt/evidence id. */
  retryFailureId?: string;
};

type Attempt = {
  attemptId: string;
  lessonId: string;
  blockId: string;
  command: string;
  terminalSessionId: string;
  revision: number;
  finished: boolean;
  evidenceRef?: string;
  feedback?: string;
  reviewFailure?: { message: string; failureId?: string };
  reviewRequests: TerminalReviewRequestLike[];
  latestReviewRequestId?: string;
  accepted?: string;
};

/**
 * Replays private terminal records without I/O. Finished evidence is checked only to establish
 * lifecycle consistency; no evidence, command, attempt identity, request identity, or legacy terminal-coach handoff
 * reaches the result. An unfinished command from another terminal session is deliberately idle on
 * reopen.
 */
export function projectTerminalAttempts(
  records: readonly WorkbookTimelineRecord[],
  readEvidence: TerminalEvidenceReader,
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
          reviewRequests: [],
        });
        currentAttemptByBlock.set(record.blockId, record.attemptId);
        break;
      }
      case "terminal-command-finished": {
        const attempt = attempts.get(record.attemptId);
        const evidence = attempt && !attempt.finished ? readEvidence(record.evidenceRef) : undefined;
        if (!attempt || evidence?.kind !== "finished" || evidence.command !== attempt.command || evidence.exitStatus !== record.exitStatus) break;
        attempt.finished = true;
        attempt.evidenceRef = record.evidenceRef;
        break;
      }
      case "terminal-review-requested": {
        const attempt = attempts.get(record.attemptId);
        if (!attempt?.finished || attempt.evidenceRef !== record.evidenceRef || attempt.lessonId !== record.lessonId || attempt.blockId !== record.blockId) break;
        attempt.reviewRequests.push(record);
        attempt.latestReviewRequestId = record.requestId;
        attempt.reviewFailure = undefined;
        break;
      }
      case "terminal-review-failed": {
        const attempt = attempts.get(record.attemptId);
        if (!attempt?.finished || attempt.evidenceRef !== record.evidenceRef || attempt.lessonId !== record.lessonId || attempt.blockId !== record.blockId) break;
        if (attempt.latestReviewRequestId && attempt.latestReviewRequestId !== record.requestId) break;
        const counts = terminalReviewCallCounts(attempt.reviewRequests, { evidenceRef: record.evidenceRef });
        attempt.reviewFailure = { message: record.publicMessage, ...(canStartManualTerminalReview(counts) ? { failureId: record.failureId } : {}) };
        break;
      }
      case "terminal-feedback-recorded": {
        const attempt = attempts.get(record.attemptId);
        if (attempt?.finished && record.text.trim()) {
          attempt.feedback = record.text;
          attempt.reviewFailure = undefined;
        }
        break;
      }
      case "terminal-coach-handoff-recorded":
        // Legacy terminal-coach handoff rows remain private replay material only. They do not affect browser state.
        break;
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
          attempt.reviewFailure = undefined;
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
    // A running shell cannot survive workflow restart. Keep completed evidence available for
    // review recovery, but do not resurrect an old in-flight command as a perpetual status.
    if (!attempt.finished && activeTerminalSessionId && attempt.terminalSessionId !== activeTerminalSessionId) continue;
    if (attempt.accepted !== undefined) projection.set(blockId, { state: "complete", revision: attempt.revision, successMessage: attempt.accepted });
    else if (attempt.feedback !== undefined) projection.set(blockId, { state: "feedback", revision: attempt.revision, feedback: attempt.feedback });
    else if (attempt.reviewFailure !== undefined) projection.set(blockId, { state: "feedback", revision: attempt.revision, feedback: attempt.reviewFailure.message, ...(attempt.reviewFailure.failureId ? { retryFailureId: attempt.reviewFailure.failureId } : {}) });
    else projection.set(blockId, { state: attempt.finished ? "checking" : "running", revision: attempt.revision });
  }
  return projection;
}
