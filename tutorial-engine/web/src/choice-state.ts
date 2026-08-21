import type { TutorialEvent } from "../../src/protocol/events.js";

export function resolvedChoiceSelections(events: readonly TutorialEvent[]): ReadonlyMap<string, string> {
  const selections = new Map<string, string>();
  for (const event of events) {
    if (event.type === "choice-resolved") selections.set(event.id, event.optionId);
  }
  return selections;
}
