export const TERMINAL_OUTPUT_QUIET_MS = 1_000;

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

export interface TerminalOutputSettledFact {
  readonly type: "terminal-output-settled";
  readonly blockId: string;
  readonly attemptId: string;
  /** Monotonically increases only when this attempt receives non-empty output. */
  readonly outputRevision: number;
}

export interface TerminalCommandFinishedFact {
  readonly type: "terminal-command-finished";
  readonly blockId: string;
  readonly attemptId: string;
  readonly evidence: TerminalCommandEvidence;
}

export type TerminalObservationFact =
  | TerminalCommandSubmittedFact
  | TerminalOutputSettledFact
  | TerminalCommandFinishedFact;

export interface TerminalObservationScheduler {
  schedule(delayMs: number, callback: () => void): unknown;
  cancel(handle: unknown): void;
}

export interface TerminalObservationOptions {
  readonly blockId: string;
  readonly scheduler: TerminalObservationScheduler;
  readonly createAttemptId: () => string;
  readonly emit: (fact: TerminalObservationFact) => void;
}

type ActiveAttempt = {
  readonly attemptId: string;
  readonly command: string;
  readonly interactions: TerminalInteraction[];
  outputRevision: number;
  settledOutputRevision: number;
  quietTimer: unknown | undefined;
};

/**
 * Pure state machine for the observation lifecycle of commands Bash has accepted.
 * The caller supplies all terminal signals and controls time through the scheduler.
 */
export class TerminalObservation {
  readonly #blockId: string;
  readonly #scheduler: TerminalObservationScheduler;
  readonly #createAttemptId: () => string;
  readonly #emit: (fact: TerminalObservationFact) => void;
  #active: ActiveAttempt | undefined;

  constructor(options: TerminalObservationOptions) {
    this.#blockId = options.blockId;
    this.#scheduler = options.scheduler;
    this.#createAttemptId = options.createAttemptId;
    this.#emit = options.emit;
  }

  observeCommandSubmitted(marker: BashCommandSubmittedMarker): void {
    this.#discardActiveAttempt();
    const attempt: ActiveAttempt = {
      attemptId: this.#createAttemptId(),
      command: marker.command,
      interactions: [],
      outputRevision: 0,
      settledOutputRevision: 0,
      quietTimer: undefined
    };
    this.#active = attempt;
    this.#emit({
      type: "terminal-command-submitted",
      blockId: this.#blockId,
      attemptId: attempt.attemptId,
      command: attempt.command
    });
  }

  observeTerminalOutput(data: string): void {
    const attempt = this.#active;
    if (!attempt || data.length === 0) return;

    attempt.interactions.push({ type: "terminal-output", data });
    attempt.outputRevision += 1;
    this.#restartQuietTimer(attempt);
  }

  observeInteractiveInput(data: string): void {
    const attempt = this.#active;
    if (!attempt || data.length === 0) return;
    attempt.interactions.push({ type: "interactive-input", data });
  }

  observeCommandFinished(marker: BashCommandFinishedMarker): void {
    const attempt = this.#active;
    if (!attempt) return;

    this.#cancelQuietTimer(attempt);
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
        exitStatus: marker.exitStatus
      }
    });
  }

  /** Discards an unfinished attempt and prevents its quiet checkpoint from firing. */
  cancel(): void {
    this.#discardActiveAttempt();
  }

  /** Closing has the same state-machine effect as cancelling an unfinished attempt. */
  close(): void {
    this.cancel();
  }

  #restartQuietTimer(attempt: ActiveAttempt): void {
    this.#cancelQuietTimer(attempt);
    const outputRevision = attempt.outputRevision;
    attempt.quietTimer = this.#scheduler.schedule(TERMINAL_OUTPUT_QUIET_MS, () => {
      if (this.#active !== attempt || attempt.outputRevision !== outputRevision || attempt.settledOutputRevision === outputRevision) return;
      attempt.quietTimer = undefined;
      attempt.settledOutputRevision = outputRevision;
      this.#emit({
        type: "terminal-output-settled",
        blockId: this.#blockId,
        attemptId: attempt.attemptId,
        outputRevision
      });
    });
  }

  #cancelQuietTimer(attempt: ActiveAttempt): void {
    if (attempt.quietTimer === undefined) return;
    this.#scheduler.cancel(attempt.quietTimer);
    attempt.quietTimer = undefined;
  }

  #discardActiveAttempt(): void {
    if (!this.#active) return;
    this.#cancelQuietTimer(this.#active);
    this.#active = undefined;
  }
}
