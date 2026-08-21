import React from "react";
import { BlockView, type Block, type Progress, type State } from "./workbook-ui";

/**
 * The only live practice surface. Its sticky wrapper lets the learner refer to the
 * activity while the durable conversation scrolls below it.
 */
export function ActivityBand({ lessonId, activeBlock, progress, refresh }: {
  lessonId: string;
  activeBlock: Block;
  progress: Progress;
  refresh(state: State): void;
}) {
  const activeProgress = progress.blocks.find((block) => block.id === activeBlock.id);
  if (!activeProgress?.active || !["terminal-practice", "editor-practice", "reflection"].includes(activeBlock.type)) return null;

  return <section className="current-activity-band" data-activity-type={activeBlock.type} aria-label={`Current activity: ${activeBlock.title}`}>
    <BlockView lessonId={lessonId} block={activeBlock} progress={progress} refresh={refresh} />
  </section>;
}
