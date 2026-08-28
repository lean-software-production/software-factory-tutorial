import type { TerminalEvidenceReader } from "./terminal-evidence.js";
import type { TerminalCoachingOutcome, WorkbookTimelineRecord } from "./timeline.js";

export type TerminalAttemptState =
  | "submitted"
  | "running"
  | "interim-feedback"
  | "reviewing-result"
  | "final-feedback"
  | "awaiting-confirmation"
  | "accepted";

/** Learner-facing coaching only. Evidence references and captured terminal bytes never leave this projection. */
export type PublicTerminalFeedback = { outcome: TerminalCoachingOutcome; text?: string };

export type ProjectedTerminalAttempt = {
  attemptId: string;
  lessonId: string;
  blockId: string;
  state: TerminalAttemptState;
  feedback?: PublicTerminalFeedback;
  successMessage?: string;
  /** This review is automatically scheduled to run again; no terminal contents are exposed. */
  retrying?: boolean;
};

type Coaching = { outcome: TerminalCoachingOutcome; text?: string };
const FINISHED_WORKING_FEEDBACK = "The command finished without showing the expected result. Run another command and try again.";
type Checkpoint = { checkpointId: string };
type Attempt = {
  attemptId: string;
  lessonId: string;
  blockId: string;
  command: string;
  checkpoints: Map<string, Checkpoint>;
  latestCheckpointId?: string;
  preliminary?: Coaching;
  interim?: Coaching;
  finished: boolean;
  result?: Coaching;
  accepted?: { summary: string };
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
  if (!result) return { ...base, state: "reviewing-result" };
  if (result.outcome === "wait-for-result") {
    return { ...base, state: "final-feedback", feedback: { outcome: "feedback", text: FINISHED_WORKING_FEEDBACK }, retrying: true };
  }
  if (result.outcome === "feedback") return { ...base, state: "final-feedback", feedback: feedback(result) };
  return { ...base, state: "awaiting-confirmation", feedback: result.text === undefined ? { outcome: result.outcome } : { outcome: result.outcome, text: result.text } };
}

function projectAttempt(attempt: Attempt): ProjectedTerminalAttempt {
  if (attempt.accepted) {
    return {
      attemptId: attempt.attemptId,
      lessonId: attempt.lessonId,
      blockId: attempt.blockId,
      state: "accepted",
      successMessage: attempt.accepted.summary,
    };
  }
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
        attempt.latestCheckpointId = record.checkpointId;
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
        if (attempt && !attempt.finished && attempt.latestCheckpointId === record.checkpointId) attempt.interim = coaching(record);
        break;
      }
      case "result-coaching-received": {
        const attempt = attempts.get(record.attemptId);
        if (attempt?.finished) attempt.result = coaching(record);
        break;
      }
      case "attempt_accepted": {
        const attempt = attempts.get(record.attemptId);
        // A terminal acceptance is valid only after the terminal Coach has explicitly handed this
        // finished command to the Main Tutor. This keeps the lifecycle projection authoritative
        // even though the durable acceptance commit is a shared workbook event.
        if (
          attempt
          && record.kind === "terminal"
          && attempt.finished
          && attempt.lessonId === record.lessonId
          && attempt.blockId === record.blockId
          && (attempt.result?.outcome === "ready" || attempt.result?.outcome === "interesting")
        ) attempt.accepted = { summary: record.summary };
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
