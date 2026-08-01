import type { ReactNode } from "react";
import type { ChoiceIconCategory } from "../../src/protocol/events.js";

const iconPaths: Record<ChoiceIconCategory, ReactNode> = {
  do: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" /></>,
  show: <><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" /><circle cx="12" cy="12" r="2.5" /></>,
  confirm: <><circle cx="12" cy="12" r="9" /><path d="m8 12 2.5 2.5L16 9" /></>,
  automate: <><path d="m12 3-1.8 5.2L5 10l5.2 1.8L12 17l1.8-5.2L19 10l-5.2-1.8Z" /><path d="m19 16-.7 2.3L16 19l2.3.7L19 22l.7-2.3L22 19l-2.3-.7Z" /></>,
  pause: <><rect x="5" y="4" width="5" height="16" rx="1" /><rect x="14" y="4" width="5" height="16" rx="1" /></>,
  restart: <><path d="M20 11a8 8 0 1 0 1.2 5.5" /><path d="M20 4v7h-7" /></>
};

/** The fixed visual vocabulary for learner choices; text labels remain the accessible name. */
export function ChoiceIcon({ category }: { category: ChoiceIconCategory }) {
  return <svg className="choice-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{iconPaths[category]}</svg>;
}
