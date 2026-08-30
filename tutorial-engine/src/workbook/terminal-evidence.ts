export const MAX_TERMINAL_EVIDENCE_BYTES = 96_000;
export const MAX_TERMINAL_COMMAND_BYTES = 16_000;
export const MAX_TERMINAL_INTERACTIONS = 256;
export const MAX_TERMINAL_INTERACTION_BYTES = 16_000;
export const MAX_TERMINAL_TRANSCRIPT_SNAPSHOT_BYTES = 16_000;
export const MAX_TERMINAL_TRANSCRIPT_SNAPSHOT_LABEL_BYTES = 120;

export type TerminalInteraction = { kind: "input" | "output"; data: string };
export type TerminalTranscriptSnapshot = { label: string; transcript: string; truncated: boolean };
/** Immutable evidence exists only after Bash has reported that the command finished. */
export type FinishedTerminalEvidence = {
  kind: "finished";
  command: string;
  interactions: TerminalInteraction[];
  exitStatus: number;
  /** Private, labelled, bounded transcript context available at command completion. */
  transcriptSnapshot?: TerminalTranscriptSnapshot;
};
export type TerminalEvidence = FinishedTerminalEvidence;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertText(value: unknown, label: string, maximumBytes: number): asserts value is string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new Error(`${label} is invalid.`);
  }
}

function assertInteractions(value: unknown): asserts value is TerminalInteraction[] {
  if (!Array.isArray(value) || value.length > MAX_TERMINAL_INTERACTIONS) {
    throw new Error("Terminal evidence interactions are invalid.");
  }
  for (const interaction of value) {
    if (!isRecord(interaction) || (interaction.kind !== "input" && interaction.kind !== "output")) {
      throw new Error("Terminal evidence interactions are invalid.");
    }
    assertText(interaction.data, "Terminal evidence interaction", MAX_TERMINAL_INTERACTION_BYTES);
  }
}

function assertExitStatus(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error("Terminal evidence exit status is invalid.");
  }
}

function assertTranscriptSnapshot(value: unknown): asserts value is TerminalTranscriptSnapshot {
  if (!isRecord(value) || typeof value.truncated !== "boolean") throw new Error("Terminal transcript snapshot is invalid.");
  assertText(value.label, "Terminal transcript snapshot label", MAX_TERMINAL_TRANSCRIPT_SNAPSHOT_LABEL_BYTES);
  assertText(value.transcript, "Terminal transcript snapshot", MAX_TERMINAL_TRANSCRIPT_SNAPSHOT_BYTES);
}

/** Validates an untrusted inline terminal evidence snapshot and returns a deep copy. */
export function validateTerminalEvidence(value: unknown): TerminalEvidence {
  if (!isRecord(value) || value.kind !== "finished") throw new Error("Terminal evidence is invalid.");
  assertText(value.command, "Terminal evidence command", MAX_TERMINAL_COMMAND_BYTES);
  assertInteractions(value.interactions);
  assertExitStatus(value.exitStatus);
  if (value.transcriptSnapshot !== undefined) assertTranscriptSnapshot(value.transcriptSnapshot);
  const evidence: FinishedTerminalEvidence = {
    kind: "finished",
    command: value.command,
    interactions: value.interactions.map((interaction) => ({ kind: interaction.kind, data: interaction.data })),
    exitStatus: value.exitStatus,
    ...(value.transcriptSnapshot ? { transcriptSnapshot: { ...value.transcriptSnapshot } } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(evidence), "utf8") > MAX_TERMINAL_EVIDENCE_BYTES) {
    throw new Error("Terminal evidence exceeds the snapshot limit.");
  }
  return evidence;
}
