import React, { useCallback, useEffect } from "react";
import { BlockView, type Block, type Progress, type State } from "./workbook-ui.js";

/**
 * The only live practice surface. Its sticky wrapper lets the learner refer to the activity while
 * the durable conversation scrolls below it.
 *
 * The band's geometry is fixed by the stylesheet and never answers the scroll position. It used
 * to widen as it rose, which made layout a function of scroll and scroll a function of layout: a
 * surface that grew under the learner's cursor scrolled the page to chase it, and the page moving
 * changed the surface again. Its height is bounded for the same reason — the editor scrolls inside
 * its own box — so a docked band always fits above the composer and typing never has to move the
 * window to keep the cursor in view.
 *
 * It also never takes keyboard focus on its own. Focus arrives with the learner: a click, or the
 * navigation that brought them here (see `scroll-authority.ts`).
 */
export function ActivityBand({ lessonId, activeBlock, progress, refresh, disabled = false, onTerminalInsertionChange, onEditorLocalRevision, onTerminalCommandRevision }: {
  lessonId: string;
  activeBlock: Block;
  progress: Progress;
  refresh(state: State): void;
  disabled?: boolean;
  onTerminalInsertionChange?(blockId: string, insertCommand: (() => void) | undefined): void;
  onEditorLocalRevision?(blockId: string, revision: number): void;
  onTerminalCommandRevision?(blockId: string, revision: number): void;
}) {
  const forwardTerminalInsertion = useCallback((insertCommand: (() => void) | undefined) => onTerminalInsertionChange?.(activeBlock.id, insertCommand), [activeBlock.id, onTerminalInsertionChange]);
  useEffect(() => () => onTerminalInsertionChange?.(activeBlock.id, undefined), [activeBlock.id, onTerminalInsertionChange]);
  const activeProgress = progress.blocks.find((block) => block.id === activeBlock.id);
  const activePractical = Boolean(activeProgress?.active && !activeProgress.completed && ["terminal-practice", "editor-practice"].includes(activeBlock.type));
  const readyTerminalPreload = Boolean(activeBlock.type === "terminal-practice" && activeProgress?.ready && !activeProgress.active && !activeProgress.completed);
  // Completion, not acceptance, is the handoff away from the live practice surface. A ready
  // terminal may keep this one live surface through same-block promotion.
  if (!activePractical && !readyTerminalPreload) return null;

  return <section className="current-activity-band" data-activity-type={activeBlock.type} data-activity-layout="sticky" data-activity-preloaded={readyTerminalPreload ? "true" : undefined} aria-label="Activity" aria-disabled={disabled ? "true" : undefined}>
    <BlockView lessonId={lessonId} block={activeBlock} progress={progress} refresh={refresh} disabled={disabled} onTerminalInsertionChange={forwardTerminalInsertion} onEditorLocalRevision={onEditorLocalRevision} onTerminalCommandRevision={onTerminalCommandRevision} />
  </section>;
}
