/**
 * The one reader of the viewport.
 *
 * Three things in the workbook want to know where the learner is: the sidebar highlights the
 * lesson under the reading line, the URL fragment follows the block under it, and a ready
 * successor that crosses it completes the block before it. They used to keep separate scroll
 * listeners and measure the page independently. Now the App subscribes once, and one frame
 * handler answers all three questions from one sweep of the block positions.
 *
 * This module only reads. It never scrolls (that is `scroll-authority.ts`) and never resizes
 * anything (the activity band's geometry is fixed in the stylesheet).
 */
import type { PublicWorkbookState } from "../../src/workbook/public-contract.js";
import { READING_LINE_TOP_PX } from "./scroll-authority.js";

export { READING_LINE_TOP_PX };
export const READING_LINE_HYSTERESIS_PX = 12;
export const READING_LINE_ADVANCE_TOP_PX = READING_LINE_TOP_PX - READING_LINE_HYSTERESIS_PX;
export const READING_LINE_RETURN_TOP_PX = READING_LINE_TOP_PX + READING_LINE_HYSTERESIS_PX;

type State = PublicWorkbookState;
type CanonicalBlockCandidate = { id: string; top: number };

export function revealedCanonicalBlockIds(state: State): string[] {
  const revealed = state.revealedBlockIds ?? state.progress.blocks.filter((block) => block.emerged).map((block) => block.id);
  if (!state.orderedBlocks?.length) return revealed;
  const revealedSet = new Set(revealed);
  const ordered = state.orderedBlocks.map((block) => block.id).filter((id) => revealedSet.has(id));
  return [...ordered, ...revealed.filter((id) => !ordered.includes(id))];
}

function canonicalBlockCandidates(state: State): CanonicalBlockCandidate[] {
  return revealedCanonicalBlockIds(state).flatMap((id) => {
    const element = typeof document !== "undefined" ? document.getElementById(id) : null;
    return element ? [{ id, top: element.getBoundingClientRect().top }] : [];
  });
}

function lastCandidateAtOrAbove(candidates: readonly CanonicalBlockCandidate[], top: number): CanonicalBlockCandidate | undefined {
  return candidates.filter((candidate) => candidate.top <= top).at(-1);
}

/**
 * The revealed block under the reading line, with hysteresis so a block whose top sits near the
 * line does not flicker between two answers on every pixel of scroll.
 */
export function canonicalBlockInView(state: State, currentBlockId?: string): string | undefined {
  const candidates = canonicalBlockCandidates(state);
  if (candidates.length === 0) return currentBlockId ?? state.progress.activeBlockId;
  const currentIndex = currentBlockId ? candidates.findIndex((candidate) => candidate.id === currentBlockId) : -1;
  if (currentIndex < 0) return lastCandidateAtOrAbove(candidates, READING_LINE_ADVANCE_TOP_PX)?.id ?? state.progress.activeBlockId;

  const later = lastCandidateAtOrAbove(candidates.slice(currentIndex + 1), READING_LINE_ADVANCE_TOP_PX);
  if (later) return later.id;

  const current = candidates[currentIndex]!;
  if (current.top >= READING_LINE_RETURN_TOP_PX) return lastCandidateAtOrAbove(candidates.slice(0, currentIndex), READING_LINE_RETURN_TOP_PX)?.id ?? candidates[0]?.id ?? current.id;
  return current.id;
}

/** A ready successor whose top has reached the reading line completes the block before it. */
export function readySuccessorCrossedReadingLine(top: number): boolean {
  return top <= READING_LINE_TOP_PX;
}

/**
 * Subscribe `onFrame` to viewport changes: scroll and resize, coalesced to one call per animation
 * frame when the environment has frames, and called synchronously where it does not.
 */
export function subscribeViewport(onFrame: () => void): () => void {
  let scheduled = false;
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : undefined;
  const run = () => { scheduled = false; onFrame(); };
  const request = () => {
    if (!raf) { onFrame(); return; }
    if (scheduled) return;
    scheduled = true;
    raf(run);
  };
  addEventListener("scroll", request, { passive: true });
  addEventListener("resize", request);
  return () => {
    removeEventListener("scroll", request);
    removeEventListener("resize", request);
  };
}
