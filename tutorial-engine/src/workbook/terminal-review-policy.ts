import type { TerminalReviewRequestMode } from "./timeline.js";

export const TERMINAL_AUTOMATIC_REVIEW_CALL_BUDGET = 2;
export const TERMINAL_MANUAL_REVIEW_CALL_BUDGET = 1;
export const TERMINAL_TOTAL_REVIEW_CALL_BUDGET = TERMINAL_AUTOMATIC_REVIEW_CALL_BUDGET + TERMINAL_MANUAL_REVIEW_CALL_BUDGET;

export type TerminalReviewRequestLike = {
  type: "terminal-review-requested";
  attemptId: string;
  mode: TerminalReviewRequestMode;
};

export type TerminalReviewCallCounts = {
  automatic: number;
  manual: number;
  total: number;
};

export function terminalReviewCallCounts(records: readonly TerminalReviewRequestLike[], input: { attemptId: string }): TerminalReviewCallCounts {
  const requests = records.filter((record) => record.attemptId === input.attemptId);
  const automatic = requests.filter((record) => record.mode === "automatic").length;
  const manual = requests.filter((record) => record.mode === "manual").length;
  return { automatic, manual, total: requests.length };
}

export function terminalReviewNextCallNumber(counts: TerminalReviewCallCounts): number {
  return counts.total + 1;
}

export function canStartAutomaticTerminalReview(counts: TerminalReviewCallCounts): boolean {
  return counts.automatic < TERMINAL_AUTOMATIC_REVIEW_CALL_BUDGET && counts.total < TERMINAL_TOTAL_REVIEW_CALL_BUDGET;
}

export function canStartManualTerminalReview(counts: TerminalReviewCallCounts): boolean {
  return counts.manual < TERMINAL_MANUAL_REVIEW_CALL_BUDGET && counts.total < TERMINAL_TOTAL_REVIEW_CALL_BUDGET;
}
