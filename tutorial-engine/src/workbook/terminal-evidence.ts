import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tutorialSessionStatePath, tutorialStatePath } from "./tutorial-state.js";

export const MAX_TERMINAL_EVIDENCE_BYTES = 64_000;
export const MAX_TERMINAL_COMMAND_BYTES = 16_000;
export const MAX_TERMINAL_INTERACTIONS = 256;
export const MAX_TERMINAL_INTERACTION_BYTES = 16_000;

export type TerminalEvidenceRef = string;
export type TerminalInteraction = { kind: "input" | "output"; data: string };
export type RunningTerminalEvidence = {
  kind: "running";
  command: string;
  interactions: TerminalInteraction[];
};
export type FinishedTerminalEvidence = {
  kind: "finished";
  command: string;
  interactions: TerminalInteraction[];
  exitStatus: number;
};
export type TerminalEvidence = RunningTerminalEvidence | FinishedTerminalEvidence;

export type TerminalEvidenceReader = (evidenceRef: TerminalEvidenceRef) => TerminalEvidence | undefined;

export interface TerminalEvidenceRepositoryRoots {
  stateRoot: string;
  /** Test seam for proving a collision cannot overwrite an existing snapshot. */
  createEvidenceRef?: () => TerminalEvidenceRef;
}

const EVIDENCE_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertEvidenceRef(evidenceRef: string): void {
  if (!EVIDENCE_REF.test(evidenceRef)) throw new Error("Terminal evidence reference is invalid.");
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

/** Validates untrusted JSON before it is returned to a caller. */
export function validateTerminalEvidence(value: unknown): TerminalEvidence {
  if (!isRecord(value) || (value.kind !== "running" && value.kind !== "finished")) {
    throw new Error("Terminal evidence is invalid.");
  }
  assertText(value.command, "Terminal evidence command", MAX_TERMINAL_COMMAND_BYTES);
  assertInteractions(value.interactions);
  const interactions = value.interactions.map((interaction) => ({ ...interaction }));
  if (value.kind === "finished") {
    const exitStatus = value.exitStatus;
    assertExitStatus(exitStatus);
    const evidence: FinishedTerminalEvidence = { kind: "finished", command: value.command, interactions, exitStatus };
    if (Buffer.byteLength(JSON.stringify(evidence), "utf8") > MAX_TERMINAL_EVIDENCE_BYTES) {
      throw new Error("Terminal evidence exceeds the snapshot limit.");
    }
    return evidence;
  }
  const evidence: RunningTerminalEvidence = { kind: "running", command: value.command, interactions };
  if (Buffer.byteLength(JSON.stringify(evidence), "utf8") > MAX_TERMINAL_EVIDENCE_BYTES) {
    throw new Error("Terminal evidence exceeds the snapshot limit.");
  }
  return evidence;
}

export class TerminalEvidenceRepository {
  readonly stateRoot: string;
  readonly evidenceDirectory: string;
  readonly #createEvidenceRef: () => TerminalEvidenceRef;

  constructor(workspace: string);
  constructor(roots: TerminalEvidenceRepositoryRoots);
  constructor(input: string | TerminalEvidenceRepositoryRoots) {
    this.stateRoot = typeof input === "string" ? tutorialStatePath(resolve(input)) : resolve(input.stateRoot);
    this.evidenceDirectory = tutorialSessionStatePath(this.stateRoot, "workbook", "terminal-evidence");
    this.#createEvidenceRef = typeof input === "string" ? randomUUID : input.createEvidenceRef ?? randomUUID;
  }

  async writeRunning(input: Omit<RunningTerminalEvidence, "kind">): Promise<TerminalEvidenceRef> {
    return this.#write({ kind: "running", ...input });
  }

  async writeFinished(input: Omit<FinishedTerminalEvidence, "kind">): Promise<TerminalEvidenceRef> {
    return this.#write({ kind: "finished", ...input });
  }

  async read(evidenceRef: TerminalEvidenceRef): Promise<TerminalEvidence | undefined> {
    assertEvidenceRef(evidenceRef);
    try {
      return validateTerminalEvidence(JSON.parse(await readFile(this.#path(evidenceRef), "utf8")));
    } catch (error: any) {
      if (error?.code === "ENOENT") return undefined;
      throw new Error(`Terminal evidence ${evidenceRef} is corrupt: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async #write(value: TerminalEvidence): Promise<TerminalEvidenceRef> {
    const evidence = validateTerminalEvidence(value);
    const evidenceRef = this.#createEvidenceRef();
    assertEvidenceRef(evidenceRef);
    const path = this.#path(evidenceRef);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(evidence)}\n`, { encoding: "utf8", flag: "wx" });
      // link creates the destination atomically and fails when it already exists: a collision can
      // never replace evidence from a prior attempt, and readers never see a partial destination.
      await link(temporary, path);
      return evidenceRef;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  #path(evidenceRef: TerminalEvidenceRef): string {
    assertEvidenceRef(evidenceRef);
    return resolve(this.evidenceDirectory, `${evidenceRef}.json`);
  }
}
