import { describe, expect, it } from "vitest";
import { TerminalObservation, type TerminalObservationFact } from "../src/workbook/terminal-observation.js";

function setup() {
  const facts: TerminalObservationFact[] = [];
  let next = 1;
  return {
    facts,
    observation: new TerminalObservation({
      blockId: "practice",
      createAttemptId: () => `attempt-${next++}`,
      emit: (fact) => facts.push(fact),
    }),
  };
}

describe("TerminalObservation", () => {
  it("does not create a model boundary from ordinary terminal bytes", () => {
    const { observation, facts } = setup();
    observation.observeInteractiveInput("npm test");
    observation.observeTerminalOutput("prompt");
    expect(facts).toEqual([]);
  });

  it("uses Bash submission and completion markers for one self-contained final fact", () => {
    const { observation, facts } = setup();
    observation.observeCommandSubmitted({ command: "cat -n  " });
    observation.observeTerminalOutput("waiting\r\n");
    observation.observeInteractiveInput("line\r");
    observation.observeTerminalOutput("     1\tline\r\n");
    observation.observeCommandFinished({ exitStatus: 0 });

    expect(facts).toEqual([
      { type: "terminal-command-submitted", blockId: "practice", attemptId: "attempt-1", command: "cat -n  " },
      { type: "terminal-command-finished", blockId: "practice", attemptId: "attempt-1", evidence: {
        blockId: "practice", attemptId: "attempt-1", command: "cat -n  ", exitStatus: 0,
        interactions: [
          { type: "terminal-output", data: "waiting\r\n" },
          { type: "interactive-input", data: "line\r" },
          { type: "terminal-output", data: "     1\tline\r\n" },
        ],
      } },
    ]);
  });

  it("discards an unfinished attempt when a new Bash command supersedes it", () => {
    const { observation, facts } = setup();
    observation.observeCommandSubmitted({ command: "old" });
    observation.observeTerminalOutput("old output");
    observation.observeCommandSubmitted({ command: "new" });
    observation.observeTerminalOutput("new output");
    observation.observeCommandFinished({ exitStatus: 130 });

    expect(facts.map((fact) => fact.type)).toEqual(["terminal-command-submitted", "terminal-command-submitted", "terminal-command-finished"]);
    expect(facts.at(-1)).toMatchObject({ type: "terminal-command-finished", attemptId: "attempt-2", evidence: { command: "new", exitStatus: 130 } });
  });
});
