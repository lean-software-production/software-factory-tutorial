import { describe, expect, it } from "vitest";
import {
  MAX_TERMINAL_COMMAND_BYTES,
  MAX_TERMINAL_EVIDENCE_BYTES,
  MAX_TERMINAL_INTERACTIONS,
  MAX_TERMINAL_INTERACTION_BYTES,
  MAX_TERMINAL_TRANSCRIPT_SNAPSHOT_BYTES,
  validateTerminalEvidence,
  type TerminalEvidence,
} from "../src/workbook/terminal-evidence.js";

describe("validateTerminalEvidence", () => {
  it("accepts a bounded finished snapshot and returns a deep copy", () => {
    const input: TerminalEvidence = {
      kind: "finished",
      command: "npm test",
      interactions: [{ kind: "input", data: "npm test\r" }, { kind: "output", data: "PASS\n" }],
      exitStatus: 0,
      transcriptSnapshot: { label: "Command-local terminal transcript at command completion", transcript: "PASS\n", truncated: false },
    };

    const validated = validateTerminalEvidence(input);
    input.interactions[0]!.data = "mutated";
    input.transcriptSnapshot!.transcript = "mutated";

    expect(validated).toEqual({
      kind: "finished",
      command: "npm test",
      interactions: [{ kind: "input", data: "npm test\r" }, { kind: "output", data: "PASS\n" }],
      exitStatus: 0,
      transcriptSnapshot: { label: "Command-local terminal transcript at command completion", transcript: "PASS\n", truncated: false },
    });
  });

  it("rejects an oversized command", () => {
    expect(() => validateTerminalEvidence({ kind: "finished", command: "x".repeat(MAX_TERMINAL_COMMAND_BYTES + 1), interactions: [], exitStatus: 0 }))
      .toThrow("Terminal evidence command is invalid.");
  });

  it("rejects oversized or too many interactions", () => {
    expect(() => validateTerminalEvidence({ kind: "finished", command: "ok", interactions: [{ kind: "output", data: "x".repeat(MAX_TERMINAL_INTERACTION_BYTES + 1) }], exitStatus: 0 }))
      .toThrow("Terminal evidence interaction is invalid.");
    expect(() => validateTerminalEvidence({ kind: "finished", command: "ok", interactions: Array.from({ length: MAX_TERMINAL_INTERACTIONS + 1 }, () => ({ kind: "output", data: "x" })), exitStatus: 0 }))
      .toThrow("Terminal evidence interactions are invalid.");
  });

  it("rejects an oversized aggregate evidence snapshot", () => {
    const data = "x".repeat(MAX_TERMINAL_INTERACTION_BYTES);
    const interactions = Array.from({ length: Math.ceil(MAX_TERMINAL_EVIDENCE_BYTES / MAX_TERMINAL_INTERACTION_BYTES) + 1 }, () => ({ kind: "output" as const, data }));

    expect(() => validateTerminalEvidence({ kind: "finished", command: "ok", interactions, exitStatus: 0 }))
      .toThrow("Terminal evidence exceeds the snapshot limit.");
  });

  it("rejects an oversized labelled transcript snapshot", () => {
    expect(() => validateTerminalEvidence({
      kind: "finished",
      command: "ok",
      interactions: [],
      exitStatus: 0,
      transcriptSnapshot: { label: "completion", transcript: "x".repeat(MAX_TERMINAL_TRANSCRIPT_SNAPSHOT_BYTES + 1), truncated: true },
    })).toThrow("Terminal transcript snapshot is invalid.");
  });
});
