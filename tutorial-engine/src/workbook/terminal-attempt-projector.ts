import type { TerminalEvidenceReader } from "./terminal-evidence.js";
import type { TerminalCoachingOutcome, WorkbookTimelineRecord } from "./timeline.js";

export type TerminalAttemptState =
  | "submitted"
  | "running"
  | "interim-feedback"
  | "reviewing-result"
  | "final-feedback"
  | "accepted-ready";

/** Learner-facing coaching only. Evidence references and captured terminal bytes never leave this projection. */
export type PublicTerminalFeedback = { outcome: TerminalCoachingOutcome; text?: string };

export type ProjectedTerminalAttempt = {
  attemptId: string;
  lessonId: string;
  blockId: string;
  state: TerminalAttemptState;
  feedback?: PublicTerminalFeedback;
};

type Coaching = { outcome: TerminalCoachingOutcome; text?: string };
type Checkpoint = { checkpointId: string };
type Attempt = {
  attemptId: string;
  lessonId: string;
  blockId: string;
  command: string;
  checkpoints: Map<string, Checkpoint>;
  preliminary?: Coaching;
  interim?: Coaching;
  finished: boolean;
  result?: Coaching;
};

function coaching(record: { outcome: TerminalCoachingOutcome; text?: string }): Coaching {
  return record.text === undefined ? { outcome: record.outcome } : { outcome: record.outcome, text: record.text };
}

function feedback(outcome: Coaching | undefined): PublicTerminalFeedback | undefined {
  if (!outcome || outcome.outcome !== "feedback") return undefined;
  return outcome.text === undefined ? { outcome: outcome.outcome } : { outcome: outcome.outcome, text: outcome.text };
}

function resultProjection(attempt: Attempt): ProjectedTerminalAttempt {
  const base = { attemptId: attempt.attemptId, lessonId: attempt.lessonId, blockId: attempt.blockId };
  const result = attempt.result;
  if (!result || result.outcome === "working") return { ...base, state: "reviewing-result" };
  if (result.outcome === "feedback") return { ...base, state: "final-feedback", feedback: feedback(result) };
  return { ...base, state: "accepted-ready", feedback: result.text === undefined ? { outcome: result.outcome } : { outcome: result.outcome, text: result.text } };
}

function projectAttempt(attempt: Attempt): ProjectedTerminalAttempt {
  if (attempt.result) return resultProjection(attempt);
  const base = { attemptId: attempt.attemptId, lessonId: attempt.lessonId, blockId: attempt.blockId };
  if (attempt.finished) return { ...base, state: "reviewing-result" };
  const currentCoaching = attempt.interim ?? attempt.preliminary;
  const currentFeedback = feedback(currentCoaching);
  if (currentFeedback) return { ...base, state: "interim-feedback", feedback: currentFeedback };
  if (attempt.checkpoints.size > 0) return { ...base, state: "running" };
  return { ...base, state: "submitted" };
}

/**
 * Replays terminal records without I/O. The reader supplies previously validated snapshots; its
 * contents are used only to establish lifecycle consistency, never exposed in the result.
 */
export function projectTerminalAttempts(
  records: readonly WorkbookTimelineRecord[],
  readEvidence: TerminalEvidenceReader,
): ReadonlyMap<string, ProjectedTerminalAttempt> {
  const attempts = new Map<string, Attempt>();
  const currentAttemptByBlock = new Map<string, string>();

  for (const record of records) {
    switch (record.type) {
      case "terminal-command-submitted": {
        attempts.set(record.attemptId, {
          attemptId: record.attemptId,
          lessonId: record.lessonId,
          blockId: record.blockId,
          command: record.command,
          checkpoints: new Map(),
          finished: false,
        });
        currentAttemptByBlock.set(record.blockId, record.attemptId);
        break;
      }
      case "terminal-output-settled": {
        const attempt = attempts.get(record.attemptId);
        const evidence = attempt && !attempt.finished ? readEvidence(record.evidenceRef) : undefined;
        if (!attempt || evidence?.kind !== "running" || evidence.command !== attempt.command) break;
        attempt.checkpoints.set(record.checkpointId, { checkpointId: record.checkpointId });
        break;
      }
      case "terminal-command-finished": {
        const attempt = attempts.get(record.attemptId);
        const evidence = attempt && !attempt.finished ? readEvidence(record.evidenceRef) : undefined;
        if (!attempt || evidence?.kind !== "finished" || evidence.command !== attempt.command || evidence.exitStatus !== record.exitStatus) break;
        attempt.finished = true;
        break;
      }
      case "preliminary-coaching-received": {
        const attempt = attempts.get(record.attemptId);
        if (attempt && !attempt.finished) attempt.preliminary = coaching(record);
        break;
      }
      case "interim-coaching-received": {
        const attempt = attempts.get(record.attemptId);
        if (attempt && !attempt.finished && attempt.checkpoints.has(record.checkpointId)) attempt.interim = coaching(record);
        break;
      }
      case "result-coaching-received": {
        const attempt = attempts.get(record.attemptId);
        if (attempt?.finished) attempt.result = coaching(record);
        break;
      }
      default:
        break;
    }
  }

  const projection = new Map<string, ProjectedTerminalAttempt>();
  for (const [blockId, attemptId] of currentAttemptByBlock) {
    const attempt = attempts.get(attemptId);
    if (attempt) projection.set(blockId, projectAttempt(attempt));
  }
  return projection;
}
