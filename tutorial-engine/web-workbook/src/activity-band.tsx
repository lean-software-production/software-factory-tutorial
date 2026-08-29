import React, { useCallback, useEffect, useRef } from "react";
import { BlockView, type Block, type Progress, type State } from "./workbook-ui.js";

const CANVAS_INSET_PX = 24;
const TRANSITION_START_PX = 220;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function px(value: number) {
  return `${Math.round(value * 1000) / 1000}px`;
}

type ActivityRect = Pick<DOMRectReadOnly, "left" | "width">;

export function activityGeometryFor({ mainRect, inlineRect, progress, canvasInset = CANVAS_INSET_PX }: { mainRect: ActivityRect; inlineRect: ActivityRect; progress: number; canvasInset?: number }) {
  const inset = Math.min(canvasInset, Math.max(0, (mainRect.width - 1) / 2));
  const inlineWidth = Math.max(0, inlineRect.width);
  const expandedWidth = Math.max(0, mainRect.width - inset * 2);
  const clampedProgress = clamp(progress, 0, 1);
  const width = inlineWidth + (expandedWidth - inlineWidth) * clampedProgress;
  const inlineLeft = inlineRect.left;
  const expandedLeft = mainRect.left + inset;
  const left = inlineLeft + (expandedLeft - inlineLeft) * clampedProgress;
  const center = left + width / 2;
  return {
    left,
    width,
    top: inset * clampedProgress,
    canvasInset: inset,
    canvasCenter: mainRect.left + mainRect.width / 2,
    center,
    expandedWidth
  };
}

function documentTopFromLayout(element: HTMLElement) {
  let top = 0;
  let current: HTMLElement | null = element;
  while (current) {
    top += current.offsetTop;
    current = current.offsetParent as HTMLElement | null;
  }
  if (top > 0) return top;
  return element.getBoundingClientRect().top + window.scrollY;
}

/**
 * The only live practice surface. Its sticky wrapper lets the learner refer to the
 * activity while the durable conversation scrolls below it.
 */
export function ActivityBand({ lessonId, activeBlock, progress, refresh, onTerminalInsertionChange, onEditorLocalRevision }: {
  lessonId: string;
  activeBlock: Block;
  progress: Progress;
  refresh(state: State): void;
  onTerminalInsertionChange?(blockId: string, insertCommand: (() => void) | undefined): void;
  onEditorLocalRevision?(blockId: string, revision: number): void;
}) {
  const bandRef = useRef<HTMLElement | null>(null);
  const focusedForBlock = useRef<string | undefined>(undefined);
  const forwardTerminalInsertion = useCallback((insertCommand: (() => void) | undefined) => onTerminalInsertionChange?.(activeBlock.id, insertCommand), [activeBlock.id, onTerminalInsertionChange]);
  useEffect(() => () => onTerminalInsertionChange?.(activeBlock.id, undefined), [activeBlock.id, onTerminalInsertionChange]);
  const activeProgress = progress.blocks.find((block) => block.id === activeBlock.id);
  useEffect(() => {
    focusedForBlock.current = undefined;
  }, [activeBlock.id]);
  useEffect(() => {
    const element = bandRef.current;
    if (!element || typeof window === "undefined") return;
    const previousSibling = element.previousElementSibling;
    const inlineSource = previousSibling instanceof window.HTMLElement
      ? previousSibling
      : element.parentElement instanceof window.HTMLElement ? element.parentElement : null;
    const main = element.closest("main") as HTMLElement | null;
    let ticking = false;
    const setActivityGeometry = () => {
      ticking = false;
      const mainRect = main?.getBoundingClientRect();
      const inlineRect = inlineSource?.getBoundingClientRect();
      if (!mainRect || !inlineRect) return;

      const canvasInset = Math.min(CANVAS_INSET_PX, Math.max(0, (mainRect.width - 1) / 2));
      const naturalTop = documentTopFromLayout(element) - window.scrollY;
      const progress = clamp((TRANSITION_START_PX - naturalTop) / Math.max(1, TRANSITION_START_PX - canvasInset), 0, 1);
      const geometry = activityGeometryFor({ mainRect, inlineRect, progress, canvasInset });
      const expandedGeometry = activityGeometryFor({ mainRect, inlineRect, progress: 1, canvasInset });
      const leftOffset = geometry.left - inlineRect.left;
      const expandedLeftOffset = expandedGeometry.left - inlineRect.left;

      element.style.setProperty("--activity-expand", progress.toFixed(3));
      element.style.setProperty("--activity-canvas-inset", px(geometry.canvasInset));
      element.style.setProperty("--activity-inline-width", px(inlineRect.width));
      element.style.setProperty("--activity-expanded-width", px(geometry.expandedWidth));
      element.style.setProperty("--activity-canvas-center", px(geometry.canvasCenter));
      element.style.setProperty("--activity-expanded-left-offset", px(expandedLeftOffset));
      element.style.setProperty("--activity-width", px(geometry.width));
      element.style.setProperty("--activity-left-offset", px(leftOffset));
      element.style.setProperty("--activity-top", px(geometry.top));
    };
    const requestGeometry = () => {
      if (ticking) return;
      ticking = true;
      const schedule = window.requestAnimationFrame ?? ((callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0));
      schedule(setActivityGeometry);
    };
    const ResizeObserverClass = window.ResizeObserver;
    const resizeObserver = ResizeObserverClass ? new ResizeObserverClass(requestGeometry) : undefined;
    if (inlineSource) resizeObserver?.observe(inlineSource);
    if (main instanceof window.HTMLElement && main !== inlineSource) resizeObserver?.observe(main);
    window.addEventListener("scroll", requestGeometry, { passive: true });
    window.addEventListener("resize", requestGeometry);
    requestGeometry();
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("scroll", requestGeometry);
      window.removeEventListener("resize", requestGeometry);
    };
  }, [activeBlock.id]);
  useEffect(() => {
    if (activeBlock.type === "terminal-practice" || !activeProgress?.active || activeProgress.checkpoint?.status === "accepted" || typeof IntersectionObserver === "undefined") return;
    const element = bandRef.current;
    if (!element) return;
    let lastY = typeof scrollY === "number" ? scrollY : 0;
    const observer = new IntersectionObserver(([entry]) => {
      const currentY = typeof scrollY === "number" ? scrollY : lastY;
      const downward = currentY >= lastY;
      lastY = currentY;
      if (!entry?.isIntersecting || !downward || focusedForBlock.current === activeBlock.id) return;
      const focusTarget = element.querySelector<HTMLElement>(".cm-content[contenteditable='true'], .xterm-helper-textarea, textarea, [tabindex]");
      focusTarget?.focus?.({ preventScroll: true });
      focusedForBlock.current = activeBlock.id;
    }, { rootMargin: "-100px 0px -45% 0px", threshold: 0.15 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [activeBlock.id, activeBlock.type, activeProgress?.active, activeProgress?.checkpoint?.status]);
  const activePractical = Boolean(activeProgress?.active && ["terminal-practice", "editor-practice"].includes(activeBlock.type));
  const readyTerminalPreload = Boolean(activeBlock.type === "terminal-practice" && activeProgress?.ready && !activeProgress.active && !activeProgress.completed);
  // Accepted terminal history belongs beneath its authored timeline record, never in the live
  // activity band. A ready terminal may keep this one live surface through same-block promotion.
  const completedTerminal = activeBlock.type === "terminal-practice" && activeProgress?.terminal?.phase === "complete";
  if (completedTerminal || !activePractical && !readyTerminalPreload || activeProgress?.checkpoint?.status === "accepted" && activeBlock.type !== "terminal-practice") return null;

  return <>
    <section ref={bandRef} className="current-activity-band" data-activity-type={activeBlock.type} data-activity-layout="scroll-linked" data-activity-preloaded={readyTerminalPreload ? "true" : undefined} aria-label="Activity">
      <BlockView lessonId={lessonId} block={activeBlock} progress={progress} refresh={refresh} onTerminalInsertionChange={forwardTerminalInsertion} onEditorLocalRevision={onEditorLocalRevision} />
    </section>
  </>;
}
