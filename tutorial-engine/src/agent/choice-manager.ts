import type { ChoiceOption } from "../protocol/events.js";

interface PendingChoice {
  options: Set<string>;
  resolve: (optionId: string) => void;
  reject: (error: Error) => void;
}

/** Bridges a blocking Pi tool call to a browser choice. */
export class ChoiceManager {
  readonly #pending = new Map<string, PendingChoice>();

  get pendingIds(): readonly string[] {
    return [...this.#pending.keys()];
  }

  wait(id: string, options: ChoiceOption[], signal?: AbortSignal): Promise<string> {
    if (this.#pending.has(id)) throw new Error(`Choice '${id}' is already pending.`);
    return new Promise<string>((resolve, reject) => {
      const abort = () => {
        this.#pending.delete(id);
        reject(new Error("Choice cancelled."));
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.#pending.set(id, {
        options: new Set(options.map((option) => option.id)),
        resolve: (optionId) => {
          signal?.removeEventListener("abort", abort);
          this.#pending.delete(id);
          resolve(optionId);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", abort);
          this.#pending.delete(id);
          reject(error);
        }
      });
    });
  }

  choose(id: string, optionId: string): boolean {
    const choice = this.#pending.get(id);
    if (!choice || !choice.options.has(optionId)) return false;
    choice.resolve(optionId);
    return true;
  }

  cancelAll(reason = "Choice cancelled."): string[] {
    const cancelled = [...this.#pending.keys()];
    for (const choice of this.#pending.values()) choice.reject(new Error(reason));
    this.#pending.clear();
    return cancelled;
  }
}
