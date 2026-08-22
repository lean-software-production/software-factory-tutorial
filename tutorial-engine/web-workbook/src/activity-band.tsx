import React, { useState } from "react";
import { BlockView, type Block, type Progress, type State } from "./workbook-ui";

/**
 * The only live practice surface. Its sticky wrapper lets the learner refer to the
 * activity while the durable conversation scrolls below it.
 */
export function ActivityBand({ lessonId, activeBlock, progress, refresh, onHint }: {
  lessonId: string;
  activeBlock: Block;
  progress: Progress;
  refresh(state: State): void;
  onHint?(blockId: string): Promise<void>;
}) {
  const [hintPending, setHintPending] = useState(false);
  const activeProgress = progress.blocks.find((block) => block.id === activeBlock.id);
  if (!activeProgress?.active || !["terminal-practice", "editor-practice"].includes(activeBlock.type)) return null;

  const requestHint = async () => {
    if (!onHint || hintPending) return;
    setHintPending(true);
    try {
      await onHint(activeBlock.id);
    } finally {
      setHintPending(false);
    }
  };

  return <section className="current-activity-band" data-activity-type={activeBlock.type} aria-label={`Current activity: ${activeBlock.title}`}>
    {onHint && <div className="activity-assist"><button className="button secondary get-hint" disabled={hintPending} onClick={() => void requestHint()}>Get a hint</button></div>}
    <BlockView lessonId={lessonId} block={activeBlock} progress={progress} refresh={refresh} />
  </section>;
}
