import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { tutorialSessionStatePath, tutorialStatePath } from "./tutorial-state.js";
import type { ReflectionTurn } from "./reflection.js";

export type AttemptKind = "editor" | "terminal" | "reflection";
export type AttemptStatus = "working" | "reviewing" | "feedback" | "accepted" | "superseded";
export type AttemptEvidence =
  | { kind: "editor"; text: string }
  | { kind: "terminal"; transcript: string; terminalHtml: string }
  | { kind: "reflection"; response: string; conversation: ReflectionTurn[] };

export interface Attempt {
  id: string;
  lessonId: string;
  blockId: string;
  version: number;
  evidence: AttemptEvidence;
  status: AttemptStatus;
  feedback?: string;
  /** Last actionable feedback kept visible while a replacement review is pending or retryable. */
  retainedFeedback?: string;
  /** The visible feedback is a retryable transport/provider notice, not actionable tutor feedback. */
  reviewUnavailable?: boolean;
  /** Historical terminal-only quick-feedback state; excluded from Main Tutor context and timeline. */
  privateQuickFeedback?: boolean;
  successMessage?: string;
}

export type SubmitAttempt = (input: { lessonId: string; blockId: string; evidence: AttemptEvidence; privateGuidance: string }) => Promise<void>;

type AttemptInput = Omit<Attempt, "id" | "version" | "status"> & { version?: number };
type AttemptPointer = { id: string; lessonId: string; blockId: string; version: number };

const MAX_TEXT_BYTES = 64_000;
const MAX_TRANSCRIPT_BYTES = 64_000;
const MAX_REFLECTION_BYTES = 4_000;
const ID_PATTERN = /^[0-9a-f-]{36}$/i;

function assertIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
}

function encodedSegment(value: string, label: string): string {
  assertIdentifier(value, label);
  const encoded = encodeURIComponent(value);
  if (!encoded || encoded === "." || encoded === ".." || encoded.includes("/")) throw new Error(`${label} is unsafe.`);
  return encoded;
}

function assertEvidence(evidence: AttemptEvidence): void {
  if (evidence.kind === "editor") {
    if (typeof evidence.text !== "string" || Buffer.byteLength(evidence.text, "utf8") > MAX_TEXT_BYTES) throw new Error("Editor attempt text is invalid.");
    return;
  }
  if (evidence.kind === "terminal") {
    if (typeof evidence.transcript !== "string" || typeof evidence.terminalHtml !== "string" || Buffer.byteLength(evidence.transcript, "utf8") > MAX_TRANSCRIPT_BYTES || Buffer.byteLength(evidence.terminalHtml, "utf8") > MAX_TEXT_BYTES) throw new Error("Terminal attempt evidence is invalid.");
    return;
  }
  if (typeof evidence.response !== "string" || Buffer.byteLength(evidence.response, "utf8") > MAX_REFLECTION_BYTES || !Array.isArray(evidence.conversation) || evidence.conversation.some((turn) => !turn || (turn.role !== "learner" && turn.role !== "tutor") || typeof turn.text !== "string")) {
    throw new Error("Reflection attempt evidence is invalid.");
  }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error: any) { if (error?.code === "ENOENT") return undefined; throw error; }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export interface AttemptStoreRoots { stateRoot: string; }

export class AttemptStore {
  readonly workspace: string;
  readonly stateRoot: string;

  constructor(workspace: string);
  constructor(roots: AttemptStoreRoots);
  constructor(input: string | AttemptStoreRoots) {
    if (typeof input === "string") {
      this.workspace = resolve(input);
      this.stateRoot = tutorialStatePath(this.workspace);
    } else {
      this.stateRoot = resolve(input.stateRoot);
      this.workspace = this.stateRoot;
    }
  }

  async create(input: AttemptInput): Promise<Attempt> {
    assertIdentifier(input.lessonId, "Attempt lesson ID");
    assertIdentifier(input.blockId, "Attempt block ID");
    assertEvidence(input.evidence);
    const previous = await this.current(input.lessonId, input.blockId);
    if (previous?.status === "accepted") throw new Error("Accepted work cannot be replaced before continuation.");
    const previousVersion = previous?.version ?? 0;
    const requestedVersion = input.version;
    if (requestedVersion !== undefined && (!Number.isSafeInteger(requestedVersion) || requestedVersion <= previousVersion)) throw new Error("Attempt revision is stale.");
    const retainedFeedback = previous?.evidence.kind === "editor" && input.evidence.kind === "editor" ? previous.retainedFeedback ?? (previous.status === "feedback" && !previous.reviewUnavailable ? previous.feedback : undefined) : undefined;
    if (previous && previous.status !== "superseded") await this.#write({ ...previous, status: "superseded", feedback: undefined, retainedFeedback: undefined, reviewUnavailable: undefined, successMessage: undefined });
    const attempt: Attempt = { id: randomUUID(), lessonId: input.lessonId, blockId: input.blockId, version: requestedVersion ?? previousVersion + 1, evidence: input.evidence, status: "working", ...(retainedFeedback ? { retainedFeedback } : {}) };
    await this.#write(attempt);
    await writeJson(this.#currentPath(attempt.lessonId, attempt.blockId), this.#pointer(attempt));
    await writeJson(this.#idPath(attempt.id), this.#pointer(attempt));
    return attempt;
  }

  async current(lessonId: string, blockId: string): Promise<Attempt | undefined> {
    assertIdentifier(lessonId, "Attempt lesson ID");
    assertIdentifier(blockId, "Attempt block ID");
    const pointer = await readJson<AttemptPointer>(this.#currentPath(lessonId, blockId));
    if (!pointer) return undefined;
    return this.#readPointer(pointer);
  }

  async read(id: string): Promise<Attempt | undefined> {
    if (!ID_PATTERN.test(id)) throw new Error("Attempt ID is invalid.");
    const pointer = await readJson<AttemptPointer>(this.#idPath(id));
    if (!pointer || pointer.id !== id) return undefined;
    return this.#readPointer(pointer);
  }

  async list(lessonId: string, blockId: string): Promise<Attempt[]> {
    assertIdentifier(lessonId, "Attempt lesson ID");
    assertIdentifier(blockId, "Attempt block ID");
    let entries: Dirent[];
    try {
      entries = await readdir(this.#blockDirectory(lessonId, blockId), { withFileTypes: true });
    } catch (error: any) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const pointers = entries.flatMap((entry): AttemptPointer[] => {
      if (!entry.isFile()) return [];
      const match = /^(\d+)-([0-9a-f-]{36})\.json$/i.exec(entry.name);
      const version = match?.[1];
      const id = match?.[2];
      if (!version || !id) return [];
      return [{ id, lessonId, blockId, version: Number(version) }];
    }).sort((left, right) => left.version - right.version);
    const attempts = await Promise.all(pointers.map((pointer) => this.#readPointer(pointer)));
    return attempts.filter((attempt): attempt is Attempt => Boolean(attempt));
  }

  async markReviewing(id: string): Promise<Attempt | undefined> {
    return this.#updateCurrent(id, (attempt) => ({ ...attempt, status: "reviewing", feedback: undefined }));
  }

  async markWorking(id: string): Promise<Attempt | undefined> {
    return this.#updateCurrent(id, (attempt) => ({ ...attempt, status: "working", feedback: undefined, reviewUnavailable: undefined, privateQuickFeedback: undefined }));
  }

  async markQuickWorking(id: string): Promise<Attempt | undefined> {
    return this.#updateCurrent(id, (attempt) => ({ ...attempt, status: "working", feedback: undefined, privateQuickFeedback: true }));
  }

  async markFeedback(id: string, message: string): Promise<Attempt | undefined> {
    const feedback = message.trim().slice(0, 1_000) || "The tutor is ready to check your next attempt.";
    return this.#updateCurrent(id, (attempt) => ({ ...attempt, status: "feedback", feedback, retainedFeedback: undefined, reviewUnavailable: undefined, privateQuickFeedback: undefined }));
  }

  async markReviewUnavailable(id: string, message: string): Promise<Attempt | undefined> {
    const feedback = message.trim().slice(0, 1_000) || "Review is temporarily unavailable. Please try another attempt in a moment.";
    return this.#updateCurrent(id, (attempt) => {
      const retainedFeedback = attempt.retainedFeedback ?? (attempt.status === "feedback" && !attempt.reviewUnavailable ? attempt.feedback : undefined);
      return { ...attempt, status: "feedback", feedback, ...(retainedFeedback ? { retainedFeedback } : { retainedFeedback: undefined }), reviewUnavailable: true, privateQuickFeedback: undefined };
    });
  }

  async markQuickFeedback(id: string, message: string): Promise<Attempt | undefined> {
    const feedback = message.trim().slice(0, 1_000) || "Check the terminal output and try again.";
    return this.#updateCurrent(id, (attempt) => ({ ...attempt, status: "feedback", feedback, retainedFeedback: undefined, reviewUnavailable: undefined, privateQuickFeedback: true }));
  }

  async acceptCurrent(id: string, successMessage: string): Promise<Attempt | undefined> {
    const message = successMessage.trim().slice(0, 1_000) || "Nice work — this attempt is accepted.";
    return this.#updateCurrent(id, (attempt) => ({ ...attempt, status: "accepted", feedback: undefined, retainedFeedback: undefined, reviewUnavailable: undefined, privateQuickFeedback: undefined, successMessage: message }));
  }

  async resetPresentationState(): Promise<void> {
    await rm(this.#root(), { recursive: true, force: true });
  }

  async #updateCurrent(id: string, update: (attempt: Attempt) => Attempt): Promise<Attempt | undefined> {
    const attempt = await this.read(id);
    if (!attempt || attempt.status === "superseded") return undefined;
    const current = await this.current(attempt.lessonId, attempt.blockId);
    if (!current || current.id !== attempt.id) return undefined;
    const next = update(attempt);
    await this.#write(next);
    return next;
  }

  async #readPointer(pointer: AttemptPointer): Promise<Attempt | undefined> {
    const attempt = await readJson<Attempt>(this.#attemptPath(pointer.lessonId, pointer.blockId, pointer.version, pointer.id));
    if (!attempt || attempt.id !== pointer.id || attempt.lessonId !== pointer.lessonId || attempt.blockId !== pointer.blockId || attempt.version !== pointer.version) throw new Error("Attempt state is corrupt.");
    assertEvidence(attempt.evidence);
    return attempt;
  }

  async #write(attempt: Attempt): Promise<void> {
    await writeJson(this.#attemptPath(attempt.lessonId, attempt.blockId, attempt.version, attempt.id), attempt);
  }

  #pointer(attempt: Attempt): AttemptPointer { return { id: attempt.id, lessonId: attempt.lessonId, blockId: attempt.blockId, version: attempt.version }; }
  #root(): string { return tutorialSessionStatePath(this.stateRoot, "workbook", "attempts"); }
  #blockDirectory(lessonId: string, blockId: string): string { return resolve(this.#root(), encodedSegment(lessonId, "Attempt lesson ID"), encodedSegment(blockId, "Attempt block ID")); }
  #attemptPath(lessonId: string, blockId: string, version: number, id: string): string { return resolve(this.#blockDirectory(lessonId, blockId), `${version}-${id}.json`); }
  #currentPath(lessonId: string, blockId: string): string { return resolve(this.#blockDirectory(lessonId, blockId), "current.json"); }
  #idPath(id: string): string { return resolve(this.#root(), "by-id", `${id}.json`); }
}
