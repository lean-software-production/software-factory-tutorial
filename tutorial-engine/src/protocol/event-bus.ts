import type { TutorialEvent } from "./events.js";

export type EventListener = (event: TutorialEvent) => void;

/** Small replaying event bus so a refreshed browser receives the current transcript. */
export class TutorialEventBus {
  readonly #events: TutorialEvent[] = [];
  readonly #listeners = new Set<EventListener>();

  publish(event: TutorialEvent): void {
    if (event.type !== "snapshot") this.#events.push(event);
    for (const listener of this.#listeners) listener(event);
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  history(): readonly TutorialEvent[] {
    return this.#events;
  }
}
