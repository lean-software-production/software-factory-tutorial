/** The authoritative Bash hook marks the exact command Bash accepted. */
export interface BashCommandSubmittedMarker {
  command: string;
}

/** The authoritative Bash hook marks the command's completion. */
export interface BashCommandFinishedMarker {
  exitStatus: number;
}

export type TerminalInteraction =
  | { readonly type: "interactive-input"; readonly data: string }
  | { readonly type: "terminal-output"; readonly data: string };

/** All information needed to understand one completed command without terminal state. */
export interface TerminalCommandEvidence {
  readonly blockId: string;
  readonly attemptId: string;
  readonly command: string;
  readonly interactions: readonly TerminalInteraction[];
  readonly exitStatus: number;
}

export interface TerminalCommandSubmittedFact {
  readonly type: "terminal-command-submitted";
  readonly blockId: string;
  readonly attemptId: string;
  readonly command: string;
}

export interface TerminalCommandFinishedFact {
  readonly type: "terminal-command-finished";
  readonly blockId: string;
  readonly attemptId: string;
  readonly evidence: TerminalCommandEvidence;
}

export type TerminalObservationFact = TerminalCommandSubmittedFact | TerminalCommandFinishedFact;

export interface TerminalObservationOptions {
  readonly blockId: string;
  readonly createAttemptId: () => string;
  readonly emit: (fact: TerminalObservationFact) => void;
}

type ActiveAttempt = {
  readonly attemptId: string;
  readonly command: string;
  readonly interactions: TerminalInteraction[];
};

/**
 * Pure state machine for the Bash-authoritative lifecycle of one command. Running output is
 * retained only in the final immutable snapshot: it is not an assessment checkpoint.
 */
export class TerminalObservation {
  readonly #blockId: string;
  readonly #createAttemptId: () => string;
  readonly #emit: (fact: TerminalObservationFact) => void;
  #active: ActiveAttempt | undefined;

  constructor(options: TerminalObservationOptions) {
    this.#blockId = options.blockId;
    this.#createAttemptId = options.createAttemptId;
    this.#emit = options.emit;
  }

  observeCommandSubmitted(marker: BashCommandSubmittedMarker): void {
    this.#active = {
      attemptId: this.#createAttemptId(),
      command: marker.command,
      interactions: [],
    };
    this.#emit({
      type: "terminal-command-submitted",
      blockId: this.#blockId,
      attemptId: this.#active.attemptId,
      command: this.#active.command,
    });
  }

  observeTerminalOutput(data: string): void {
    if (this.#active && data.length > 0) this.#active.interactions.push({ type: "terminal-output", data });
  }

  observeInteractiveInput(data: string): void {
    if (this.#active && data.length > 0) this.#active.interactions.push({ type: "interactive-input", data });
  }

  observeCommandFinished(marker: BashCommandFinishedMarker): void {
    const attempt = this.#active;
    if (!attempt) return;
    this.#active = undefined;
    this.#emit({
      type: "terminal-command-finished",
      blockId: this.#blockId,
      attemptId: attempt.attemptId,
      evidence: {
        blockId: this.#blockId,
        attemptId: attempt.attemptId,
        command: attempt.command,
        interactions: attempt.interactions.map((interaction) => ({ ...interaction })),
        exitStatus: marker.exitStatus,
      },
    });
  }

  /** Discards an unfinished attempt. */
  cancel(): void {
    this.#active = undefined;
  }

  /** Closing has the same state-machine effect as cancelling an unfinished attempt. */
  close(): void {
    this.cancel();
  }
}
