import { describe, expect, it } from "vitest";
import {
  TERMINAL_OUTPUT_QUIET_MS,
  TerminalObservation,
  type TerminalObservationFact,
  type TerminalObservationScheduler
} from "../src/workbook/terminal-observation.js";

class FakeScheduler implements TerminalObservationScheduler {
  readonly scheduledDelays: number[] = [];
  #nextHandle = 0;
  #callbacks = new Map<number, () => void>();

  schedule(delayMs: number, callback: () => void): number {
    const handle = this.#nextHandle++;
    this.scheduledDelays.push(delayMs);
    this.#callbacks.set(handle, callback);
    return handle;
  }

  cancel(handle: unknown): void {
    this.#callbacks.delete(handle as number);
  }

  runPending(): void {
    const callbacks = [...this.#callbacks.values()];
    this.#callbacks.clear();
    callbacks.forEach((callback) => callback());
  }

  get pendingCount(): number {
    return this.#callbacks.size;
  }
}

function setup() {
  const scheduler = new FakeScheduler();
  const facts: TerminalObservationFact[] = [];
  let nextAttemptId = 1;
  const observation = new TerminalObservation({
    blockId: "lesson-003:practice-command",
    scheduler,
    createAttemptId: () => `attempt-${nextAttemptId++}`,
    emit: (fact) => facts.push(fact)
  });
  return { observation, scheduler, facts };
}

describe("TerminalObservation", () => {
  it("does not create an attempt or emit facts while the learner only types", () => {
    const { observation, facts } = setup();

    observation.observeInteractiveInput("npm test");
    observation.observeTerminalOutput("prompt echo");

    expect(facts).toEqual([]);
  });

  it("emits one submitted fact with the exact command from Bash's marker", () => {
    const { observation, facts } = setup();
    const command = "printf '%s\\n' 'exact spacing'  ";

    observation.observeCommandSubmitted({ command });

    expect(facts).toEqual([{
      type: "terminal-command-submitted",
      blockId: "lesson-003:practice-command",
      attemptId: "attempt-1",
      command
    }]);
  });

  it("emits one quiet checkpoint for each changed output revision", () => {
    const { observation, scheduler, facts } = setup();
    observation.observeCommandSubmitted({ command: "npm test" });

    observation.observeTerminalOutput("first chunk");
    observation.observeTerminalOutput("second chunk");
    expect(scheduler.scheduledDelays).toEqual([TERMINAL_OUTPUT_QUIET_MS, TERMINAL_OUTPUT_QUIET_MS]);
    expect(scheduler.pendingCount).toBe(1);

    scheduler.runPending();
    scheduler.runPending();
    expect(facts.filter((fact) => fact.type === "terminal-output-settled")).toEqual([{
      type: "terminal-output-settled",
      blockId: "lesson-003:practice-command",
      attemptId: "attempt-1",
      outputRevision: 2,
      evidence: {
        blockId: "lesson-003:practice-command",
        attemptId: "attempt-1",
        command: "npm test",
        interactions: [
          { type: "terminal-output", data: "first chunk" },
          { type: "terminal-output", data: "second chunk" }
        ]
      }
    }]);

    observation.observeTerminalOutput("third chunk");
    scheduler.runPending();
    expect(facts.filter((fact) => fact.type === "terminal-output-settled")).toHaveLength(2);
    expect(facts.at(-1)).toMatchObject({ type: "terminal-output-settled", outputRevision: 3 });
  });

  it("associates interactive input with the active command attempt", () => {
    const { observation, facts } = setup();
    observation.observeCommandSubmitted({ command: "cat" });
    observation.observeInteractiveInput("first line\\n");
    observation.observeTerminalOutput("first line\\r\\n");
    observation.observeInteractiveInput("second line\\n");
    observation.observeCommandFinished({ exitStatus: 0 });

    const finished = facts.at(-1);
    expect(finished).toMatchObject({ type: "terminal-command-finished", attemptId: "attempt-1" });
    if (!finished || finished.type !== "terminal-command-finished") throw new Error("Expected finished fact.");
    expect(finished.evidence.interactions).toEqual([
      { type: "interactive-input", data: "first line\\n" },
      { type: "terminal-output", data: "first line\\r\\n" },
      { type: "interactive-input", data: "second line\\n" }
    ]);
  });

  it("finishing cancels the quiet checkpoint and seals self-contained evidence", () => {
    const { observation, scheduler, facts } = setup();
    observation.observeCommandSubmitted({ command: "false" });
    observation.observeInteractiveInput("\\u0003");
    observation.observeTerminalOutput("interrupted\\r\\n");

    observation.observeCommandFinished({ exitStatus: 130 });
    expect(scheduler.pendingCount).toBe(0);
    scheduler.runPending();

    expect(facts).toEqual([
      {
        type: "terminal-command-submitted",
        blockId: "lesson-003:practice-command",
        attemptId: "attempt-1",
        command: "false"
      },
      {
        type: "terminal-command-finished",
        blockId: "lesson-003:practice-command",
        attemptId: "attempt-1",
        evidence: {
          blockId: "lesson-003:practice-command",
          attemptId: "attempt-1",
          command: "false",
          interactions: [
            { type: "interactive-input", data: "\\u0003" },
            { type: "terminal-output", data: "interrupted\\r\\n" }
          ],
          exitStatus: 130
        }
      }
    ]);
  });

  it("ignores output and input after a command has finished", () => {
    const { observation, scheduler, facts } = setup();
    observation.observeCommandSubmitted({ command: "echo done" });
    observation.observeTerminalOutput("done\\n");
    observation.observeCommandFinished({ exitStatus: 0 });

    observation.observeTerminalOutput("late output\\n");
    observation.observeInteractiveInput("late input");
    scheduler.runPending();

    expect(facts).toHaveLength(2);
    const finished = facts[1];
    if (!finished || finished.type !== "terminal-command-finished") throw new Error("Expected finished fact.");
    expect(finished.evidence.interactions).toEqual([{ type: "terminal-output", data: "done\\n" }]);
  });
});
