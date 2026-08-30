/**
 * Fake tutors shared by the suites that boot a workbook server.
 *
 * Every one of them needs the same thing: a tutor that records what it was asked and answers
 * without a model. What differs is only how the review decision is reached — a queue the test
 * primes, or logic keyed to the evidence — so that is the one method subclasses override.
 */
import type { Attempt } from "../../src/workbook/attempts.js";
import type { PracticeCoach, PracticeCoachOutcome } from "../../src/workbook/practice-coach.js";
import type { TimelineMessage } from "../../src/workbook/timeline.js";
import type { MainTutorContext, MainWorkbookTutor, PracticeCoachHandoff, TutorDecision, TutorReview } from "../../src/workbook/tutor.js";

export type ReviewInput = MainTutorContext & TutorReview & { practiceCoachHandoff?: PracticeCoachHandoff };
export type QueuedDecision = TutorDecision | Error | Promise<TutorDecision> | ((review: ReviewInput) => TutorDecision | Promise<TutorDecision>);
export type QueuedCoachOutcome = PracticeCoachOutcome | Error | Promise<PracticeCoachOutcome>;

function unwrap<T>(next: T | Error): T {
  if (next instanceof Error) throw next;
  return next;
}

/** Records every call and answers with canned text. Override `decide` to choose review outcomes. */
export class RecordingMainTutor implements MainWorkbookTutor {
  readonly reviews: ReviewInput[] = [];
  readonly restores: MainTutorContext[] = [];
  readonly replies: Array<MainTutorContext & { learnerMessage: TimelineMessage }> = [];
  readonly blockSummaries: Array<MainTutorContext & { lessonId: string; blockId: string; coveredThroughId: string }> = [];
  readonly lessonSummaries: Array<MainTutorContext & { lessonId: string; coveredThroughId: string }> = [];
  disposed = false;
  replyQueue: Array<string | Error | Promise<string>> = [];

  protected defaultReply = "Try the workspace-relative path.";
  protected blockSummaryFor = (blockId: string): string => `Summary of ${blockId}.`;
  protected lessonSummaryFor = (lessonId: string): string => `Summary of ${lessonId}.`;

  async restore(input: MainTutorContext): Promise<void> { this.restores.push(input); }

  async reply(input: MainTutorContext & { learnerMessage: TimelineMessage }): Promise<string> {
    this.replies.push(input);
    return unwrap(await (this.replyQueue.shift() ?? this.defaultReply));
  }


  async review(input: ReviewInput): Promise<TutorDecision> {
    this.reviews.push(input);
    return this.decide(input);
  }

  protected async decide(_input: ReviewInput): Promise<TutorDecision> {
    return { outcome: "feedback", message: "Keep going." };
  }

  async summarizeBlock(input: MainTutorContext & { lessonId: string; blockId: string; coveredThroughId: string }): Promise<string> {
    this.blockSummaries.push(input);
    return this.blockSummaryFor(input.blockId);
  }

  async summarizeLesson(input: MainTutorContext & { lessonId: string; coveredThroughId: string }): Promise<string> {
    this.lessonSummaries.push(input);
    return this.lessonSummaryFor(input.lessonId);
  }

  dispose(): void { this.disposed = true; }
}

/** Answers reviews from a queue primed by the test, in order. */
export class QueuedMainTutor extends RecordingMainTutor {
  queue: QueuedDecision[];
  constructor(...queue: QueuedDecision[]) { super(); this.queue = queue; }

  protected override async decide(input: ReviewInput): Promise<TutorDecision> {
    const next = this.queue.shift() ?? { outcome: "feedback" as const, message: "Keep going." };
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(input) : next;
  }
}

export class RecordingPracticeCoach implements PracticeCoach {
  readonly assessments: Array<{ attempt: Attempt; rubric: string }> = [];
  queue: QueuedCoachOutcome[] = [];
  disposed = false;

  async assess(input: { attempt: Attempt; rubric: string }): Promise<PracticeCoachOutcome> {
    this.assessments.push(input);
    return unwrap(await (this.queue.shift() ?? { outcome: "ready", text: "Ordinary terminal handoff." }));
  }

  dispose(): void { this.disposed = true; }
}
