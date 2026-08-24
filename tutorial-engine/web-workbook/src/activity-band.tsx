import React, { useEffect } from "react";
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
  useEffect(() => () => onTerminalInsertionChange?.(undefined), [activeBlock.id, onTerminalInsertionChange]);
  const activeProgress = progress.blocks.find((block) => block.id === activeBlock.id);
  if (!activeProgress?.active || activeProgress.checkpoint?.status === "accepted" || !["terminal-practice", "editor-practice"].includes(activeBlock.type)) return null;

  return <section className="current-activity-band" data-activity-type={activeBlock.type} aria-label="Current practice activity">
    <BlockView lessonId={lessonId} block={activeBlock} progress={progress} refresh={refresh} showAuthoredContent={false} onTerminalInsertionChange={onTerminalInsertionChange} />
  </section>;
}
