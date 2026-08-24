import React, { useEffect, useRef } from "react";
import { BlockView, type Block, type Progress, type State } from "./workbook-ui";

/**
 * The only live practice surface. Its sticky wrapper lets the learner refer to the
 * activity while the durable conversation scrolls below it.
 */
export function ActivityBand({ lessonId, activeBlock, progress, refresh, onTerminalInsertionChange }: {
  lessonId: string;
  activeBlock: Block;
  progress: Progress;
  refresh(state: State): void;
  onTerminalInsertionChange?(insertCommand: (() => void) | undefined): void;
}) {
  const bandRef = useRef<HTMLElement | null>(null);
  const focusedForBlock = useRef<string>();
  useEffect(() => () => onTerminalInsertionChange?.(undefined), [activeBlock.id, onTerminalInsertionChange]);
  const activeProgress = progress.blocks.find((block) => block.id === activeBlock.id);
  useEffect(() => {
    focusedForBlock.current = undefined;
  }, [activeBlock.id]);
  useEffect(() => {
    if (!activeProgress?.active || activeProgress.checkpoint?.status === "accepted" || typeof IntersectionObserver === "undefined") return;
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
  }, [activeBlock.id, activeProgress?.active, activeProgress?.checkpoint?.status]);
  if (!activeProgress?.active || activeProgress.checkpoint?.status === "accepted" || !["terminal-practice", "editor-practice"].includes(activeBlock.type)) return null;

  return <section ref={bandRef} className="current-activity-band" data-activity-type={activeBlock.type} aria-label="Current practice activity">
    <BlockView lessonId={lessonId} block={activeBlock} progress={progress} refresh={refresh} showAuthoredContent={false} onTerminalInsertionChange={onTerminalInsertionChange} />
  </section>;
}
