/**
 * The one owner of the page's scroll position.
 *
 * Every programmatic movement of the window goes through here, and nothing here moves the page
 * except in answer to something the learner did: opening the page, following a link, pressing
 * Continue, using Back, or pressing the "new below" chip. Content arriving on its own — a tutor
 * reply, a review, a block the tutor advanced — is *announced* instead: if it landed below the
 * fold the chip lights up, and the learner decides when to go and look.
 *
 * Two rules keep this the only owner:
 *
 * 1. Scrolls are instant. A smooth scroll is a promise about where the page will be in a second,
 *    and any layout change or learner input during that second breaks it. An instant scroll has
 *    already happened by the time anything else runs.
 * 2. Nothing else calls `scrollIntoView`, `scrollTo` or `scrollBy` on the window. The reading
 *    line, the sidebar and passive promotion only *read* the viewport (see `reading-line.ts`);
 *    the activity band has fixed geometry so layout never answers a scroll (see `activity-band.tsx`).
 *
 * Because the module holds the only scroll policy, "keep the learner's position if the next step
 * is already visible" is a decision made once, here, rather than by each caller.
 */
import { useSyncExternalStore } from "react";
import type { PublicWorkbookState } from "../../src/workbook/public-contract.js";

/** Where a block's start counts as "at the top of the reading area". Shared with the reading line. */
export const READING_LINE_TOP_PX = 120;

export type HistoryMode = "push" | "replace" | "none";

export interface NavigateOptions {
  /** Leave the page alone when the target's start is already in the reading area. Continue wants this; a link does not. */
  readonly keepIfVisible?: boolean;
}

/**
 * The area of the viewport the learner can read: from the top down to the fixed composer dock,
 * or the bottom of the window when there is no dock.
 */
export function safeViewportBottom(doc: Document = document, win: Window = window): number {
  const composer = doc.querySelector(".timeline-composer-dock");
  const top = composer?.getBoundingClientRect().top;
  return typeof top === "number" && top > 0 ? Math.min(top, win.innerHeight) : win.innerHeight;
}

/**
 * Whether a block whose bounding box is `rect` starts inside the reading area. A box with no size
 * has not been laid out and cannot be visible, which is also what a headless DOM reports.
 */
export function blockStartVisible(rect: Pick<DOMRectReadOnly, "top" | "height" | "width">, safeBottom: number): boolean {
  if (rect.width === 0 && rect.height === 0) return false;
  return rect.top >= 0 && rect.top <= safeBottom - READING_LINE_TOP_PX;
}

/** Whether content whose bounding box is `rect` sits entirely below the reading area. */
export function contentBelowFold(rect: Pick<DOMRectReadOnly, "top" | "height" | "width">, safeBottom: number): boolean {
  if (rect.width === 0 && rect.height === 0) return false;
  return rect.top >= safeBottom;
}

// A learner-initiated navigation writes the URL itself. The passive scroll commit that follows a
// scroll event would otherwise overwrite that fragment with whatever block the reading line
// happened to cross on the way, so history writes from scrolling are held off briefly after one.
const PASSIVE_HISTORY_SUPPRESSION_MS = 450;
let passiveHistorySuppressedUntil = 0;

export function passiveHistoryAllowed(now = Date.now()): boolean {
  return now > passiveHistorySuppressedUntil;
}

export function replaceUrlAnchor(anchorId: string): void {
  passiveHistorySuppressedUntil = Date.now() + PASSIVE_HISTORY_SUPPRESSION_MS;
  if (typeof history !== "undefined") history.replaceState(null, "", `#${anchorId}`);
}

function focusTargetWithin(element: HTMLElement): HTMLElement | null {
  // A block that carries a live editor is a block the learner came to type in; the terminal is
  // deliberately not focused, because xterm would then swallow every key including the ones that
  // scroll the page.
  const editor = element.querySelector<HTMLElement>('.cm-content[contenteditable="true"]');
  if (editor) return editor;
  return element.matches("h1,h2,h3,[tabindex]") ? element : element.querySelector<HTMLElement>("h1,h2,h3,[tabindex]");
}

/**
 * Bring the block `anchorId` to the top of the reading area, write the URL, and move keyboard
 * focus into it. Returns false when there is no such element, so callers can retry after a render.
 */
export function navigateToAnchor(anchorId: string, mode: HistoryMode = "push", options: NavigateOptions = {}): boolean {
  if (typeof document === "undefined") return false;
  const element = document.getElementById(anchorId);
  if (!element) return false;
  passiveHistorySuppressedUntil = Date.now() + PASSIVE_HISTORY_SUPPRESSION_MS;
  const fragment = `#${anchorId}`;
  if (typeof history !== "undefined" && mode === "push") history.pushState(null, "", fragment);
  if (typeof history !== "undefined" && mode === "replace") history.replaceState(null, "", fragment);
  const alreadyVisible = options.keepIfVisible === true && blockStartVisible(element.getBoundingClientRect(), safeViewportBottom());
  if (!alreadyVisible) element.scrollIntoView({ behavior: "instant", block: "start" });
  if (mode === "push") focusTargetWithin(element)?.focus?.({ preventScroll: true });
  clearUnseen();
  return true;
}

// ---------------------------------------------------------------------------------------------
// Scheduled work: navigations and announcements that must wait for the DOM to reflect a state.
//
// A Continue answers with a new state, and the block the learner is going to changes shape when
// that state commits: the old band becomes history, the successor grows its own band. A scroll
// issued before that commit lands on the old layout and is then pushed out of place by the new
// one. So callers schedule the navigation with the state it needs, and the App flushes after
// every commit; the scroll happens in a layout effect, on the DOM the learner is about to see.

type StateReady = (state: PublicWorkbookState) => boolean;
const SCHEDULED_WORK_TTL_MS = 2_000;
let scheduledNavigation: { anchorId: string; mode: HistoryMode; options: NavigateOptions; ready: StateReady; at: number } | undefined;
let scheduledAnnouncement: { anchorId: string; label: string; ready: StateReady; at: number } | undefined;

/** A state whose active block is `anchorId` (or which has completed the workbook, for its completion anchor). */
export function stateActivates(anchorId: string): StateReady {
  return (state) => (state.progress.activeAnchorId ?? state.progress.activeBlockId) === anchorId || Boolean(state.progress.workbookComplete && state.completion?.anchorId === anchorId);
}

/** Navigate to `anchorId` once a state satisfying `ready` has been committed to the DOM. */
export function scheduleNavigation(anchorId: string, mode: HistoryMode = "push", options: NavigateOptions = {}, ready: StateReady = stateActivates(anchorId)): void {
  scheduledNavigation = { anchorId, mode, options, ready, at: Date.now() };
}

/** Announce `anchorId` once a state satisfying `ready` has been committed to the DOM. */
export function scheduleAnnouncement(anchorId: string, label: string, ready: StateReady = stateActivates(anchorId)): void {
  scheduledAnnouncement = { anchorId, label, ready, at: Date.now() };
}

/** Called by the App in a layout effect after every state commit. */
export function flushScheduledViewportWork(state: PublicWorkbookState, now = Date.now()): void {
  if (scheduledNavigation) {
    if (now - scheduledNavigation.at > SCHEDULED_WORK_TTL_MS) scheduledNavigation = undefined;
    else if (scheduledNavigation.ready(state) && navigateToAnchor(scheduledNavigation.anchorId, scheduledNavigation.mode, scheduledNavigation.options)) scheduledNavigation = undefined;
  }
  if (scheduledAnnouncement) {
    const element = typeof document === "undefined" ? null : document.getElementById(scheduledAnnouncement.anchorId);
    if (now - scheduledAnnouncement.at > SCHEDULED_WORK_TTL_MS) scheduledAnnouncement = undefined;
    else if (scheduledAnnouncement.ready(state) && element) { announceContent(element, scheduledAnnouncement.label); scheduledAnnouncement = undefined; }
  }
}

// ---------------------------------------------------------------------------------------------
// Announced content: what arrived while the learner was reading somewhere else.

export interface UnseenContent {
  readonly anchorId: string;
  readonly label: string;
}

const unseenListeners = new Set<() => void>();
let unseen: UnseenContent | undefined;
let unseenObserver: IntersectionObserver | undefined;

function setUnseen(next: UnseenContent | undefined): void {
  if (unseen === next || (unseen && next && unseen.anchorId === next.anchorId && unseen.label === next.label)) return;
  unseen = next;
  for (const listener of unseenListeners) listener();
}

function clearUnseen(): void {
  unseenObserver?.disconnect();
  unseenObserver = undefined;
  setUnseen(undefined);
}

/**
 * Note that `element` just appeared or changed on its own. If it is below the reading area the
 * "new below" chip shows until the learner scrolls it into view or presses the chip. Nothing is
 * scrolled: the learner may be reading, or typing, or half-way through a thought.
 *
 * `representatives` are other elements that show the same content — a review is welded to its
 * practice surface as well as appended to the conversation — and if any of them is not below
 * the fold the learner can already see it, so nothing is announced.
 */
export function announceContent(element: HTMLElement, label: string, representatives: readonly HTMLElement[] = [element]): void {
  if (!element.id) return;
  const safeBottom = safeViewportBottom();
  if (representatives.some((candidate) => !contentBelowFold(candidate.getBoundingClientRect(), safeBottom))) return;
  unseenObserver?.disconnect();
  unseenObserver = undefined;
  setUnseen({ anchorId: element.id, label });
  if (typeof IntersectionObserver === "undefined") return;
  // The chip clears itself when the announced content scrolls into the reading area.
  const observer = new IntersectionObserver(([entry]) => {
    if (!entry?.isIntersecting) return;
    if (unseenObserver === observer) clearUnseen();
  }, { rootMargin: `0px 0px -${Math.max(0, window.innerHeight - safeViewportBottom() + READING_LINE_TOP_PX)}px 0px`, threshold: 0 });
  observer.observe(element);
  unseenObserver = observer;
}

/** The learner pressed the chip: go to the announced content. */
export function revealUnseen(): boolean {
  const target = unseen;
  if (!target) return false;
  const element = document.getElementById(target.anchorId);
  clearUnseen();
  if (!element) return false;
  element.scrollIntoView({ behavior: "instant", block: "start" });
  return true;
}

export function currentUnseen(): UnseenContent | undefined {
  return unseen;
}

function subscribeUnseen(listener: () => void): () => void {
  unseenListeners.add(listener);
  return () => { unseenListeners.delete(listener); };
}

export function useUnseenContent(): UnseenContent | undefined {
  return useSyncExternalStore(subscribeUnseen, currentUnseen, currentUnseen);
}

/** Test seam: forget any announced content between mounts. */
export function resetScrollAuthorityForTests(): void {
  clearUnseen();
  scheduledNavigation = undefined;
  scheduledAnnouncement = undefined;
  passiveHistorySuppressedUntil = 0;
}
