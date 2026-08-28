import { WebSocket } from "ws";
import { parsePublicTerminalMessage, type PublicTerminalLegacyFrame, type PublicTerminalMessage } from "../../tutorial-engine/src/workbook/public-terminal-contract.js";
import { assertNoPrivateTutorState, recordEditorStatus, recordPublicState, recordReflectionTurn, recordTerminalTranscript } from "./session.js";
import type { PublicWorkbookState, V2SessionTrace, V2TerminalTranscriptEntry } from "./types.js";

export type WorkbookApiState = PublicWorkbookState & { [key: string]: any };

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type WebSocketConstructor = typeof WebSocket;

export interface V2WorkbookDriverOptions {
  serverUrl: string;
  trace: V2SessionTrace;
  fetch?: FetchLike;
  WebSocket?: WebSocketConstructor;
  terminalTimeoutMs?: number;
  terminalReviewTimeoutMs?: number;
  editorReviewTimeoutMs?: number;
}

export interface SubmitTerminalCommandOptions {
  label?: string;
  complete?: boolean;
  timeoutMs?: number;
}

export interface SubmitEditorDraftOptions {
  label?: string;
  timeoutMs?: number;
}

export class V2WorkbookDriver {
  readonly serverUrl: string;
  readonly trace: V2SessionTrace;
  readonly #fetch: FetchLike;
  readonly #WebSocket: WebSocketConstructor;
  readonly #terminalTimeoutMs: number;
  readonly #terminalReviewTimeoutMs: number;
  readonly #editorReviewTimeoutMs: number;
  readonly #editorRevisions = new Map<string, number>();

  constructor(options: V2WorkbookDriverOptions) {
    this.serverUrl = options.serverUrl.replace(/\/$/, "");
    this.trace = options.trace;
    this.#fetch = options.fetch ?? fetch;
    this.#WebSocket = options.WebSocket ?? WebSocket;
    this.#terminalTimeoutMs = options.terminalTimeoutMs ?? 5_000;
    this.#terminalReviewTimeoutMs = options.terminalReviewTimeoutMs ?? 120_000;
    this.#editorReviewTimeoutMs = options.editorReviewTimeoutMs ?? 120_000;
  }

  async readState(label = "state"): Promise<WorkbookApiState> {
    return this.#requestState("GET", "/api/workbook/state", undefined, label);
  }

  async completeIntroduction(label = "introduction"): Promise<WorkbookApiState> {
    let state = await this.#requestState("POST", "/api/workbook/introduction", undefined, label);
    while (state.currentBlock?.origin === "structural" && state.progress?.activeBlockId && state.progress.activeBlockId !== "workbook--complete") {
      state = await this.#requestState("POST", "/api/workbook/complete-block", { blockId: state.progress.activeBlockId }, `${label}:structural:${state.progress.activeBlockId}`);
    }
    return state;
  }

  async continueBlock(blockId: string, label = `continue:${blockId}`): Promise<WorkbookApiState> {
    return this.submitWorkbookAction(await this.#canonicalBlockId(blockId), "continue", {}, label);
  }

  async submitReflection(blockId: string, response: string, label = `reflection:${blockId}:submit`): Promise<WorkbookApiState> {
    blockId = await this.#canonicalBlockId(blockId);
    const state = await this.submitWorkbookAction(blockId, "reflection-submit", { response }, label);
    this.#recordReflectionConversation(blockId, state);
    if (this.#reflectionReviewComplete(blockId, state)) return state;
    return this.#waitForReflectionReview(blockId, `${label}:reviewed`, this.#editorReviewTimeoutMs);
  }

  async submitReflectionFollowUp(blockId: string, response: string, label = `reflection:${blockId}:follow-up`): Promise<WorkbookApiState> {
    blockId = await this.#canonicalBlockId(blockId);
    const state = await this.submitWorkbookAction(blockId, "reflection-follow-up", { response }, label);
    this.#recordReflectionConversation(blockId, state);
    if (this.#reflectionReviewComplete(blockId, state)) return state;
    return this.#waitForReflectionReview(blockId, `${label}:reviewed`, this.#editorReviewTimeoutMs);
  }

  async completeReflection(blockId: string, label = `reflection:${blockId}:complete`): Promise<WorkbookApiState> {
    return this.submitWorkbookAction(await this.#canonicalBlockId(blockId), "continue", {}, label);
  }

  async completeTerminalBlock(blockId: string, label = `terminal:${blockId}:complete`): Promise<WorkbookApiState> {
    return this.submitWorkbookAction(await this.#canonicalBlockId(blockId), "continue", {}, label);
  }

  async submitWorkbookAction(blockId: string, action: string, payload: Record<string, unknown> = {}, label = `${action}:${blockId}`): Promise<WorkbookApiState> {
    return this.#requestState("POST", "/api/workbook/events", { blockId, action, ...payload }, label);
  }

  async #canonicalBlockId(blockId: string): Promise<string> {
    if (blockId.includes("--") || blockId.startsWith("workbook--") || blockId.startsWith("part--")) return blockId;
    const state = await this.readState(`resolve:${blockId}`);
    const match = Array.isArray(state.orderedBlocks) ? state.orderedBlocks.find((candidate: any) => candidate?.declaredId === blockId || candidate?.id === blockId) : undefined;
    return typeof match?.id === "string" ? match.id : blockId;
  }

  async submitEditorDraft(blockId: string, text: string, options: SubmitEditorDraftOptions = {}): Promise<WorkbookApiState> {
    const authoredBlockId = blockId;
    blockId = await this.#canonicalBlockId(blockId);
    const revision = (this.#editorRevisions.get(blockId) ?? 0) + 1;
    const label = options.label ?? `editor:${authoredBlockId}`;
    const submitted = await this.#requestState("POST", "/api/workbook/editor", { blockId, revision, text }, `${label}:reviewing`);
    this.#editorRevisions.set(blockId, revision);
    const submittedStatus = this.#recordEditorProgress(blockId, revision, submitted);
    if (submittedStatus === "feedback" || submittedStatus === "unlocked") return submitted;
    return this.#waitForEditorReview(blockId, revision, `${label}:reviewed`, options.timeoutMs ?? this.#editorReviewTimeoutMs);
  }

  async submitTerminalCommand(blockId: string, command: string, options: SubmitTerminalCommandOptions = {}): Promise<WorkbookApiState> {
    const authoredBlockId = blockId;
    blockId = await this.#canonicalBlockId(blockId);
    const input = /[\r\n]$/.test(command) ? command : `${command}\r`;
    const acceptedState = await this.#submitTerminalInput(blockId, input, options.label ?? `terminal:${authoredBlockId}`, options.timeoutMs ?? this.#terminalReviewTimeoutMs);
    if (options.complete === false) return acceptedState;
    return this.completeTerminalBlock(blockId);
  }

  async #requestState(method: "GET" | "POST", path: string, body: unknown, label: string): Promise<WorkbookApiState> {
    const response = await this.#fetch(`${this.serverUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let json: unknown;
    try { json = text ? JSON.parse(text) : {}; }
    catch { throw new Error(`${method} ${path} returned non-JSON response (${response.status}).`); }
    assertNoPrivateTutorState(json);
    if (!response.ok) {
      const message = json && typeof json === "object" && "error" in json && typeof (json as { error?: unknown }).error === "string"
        ? (json as { error: string }).error
        : response.statusText;
      throw new Error(`${method} ${path} failed (${response.status}): ${message}`);
    }
    const stateJson = json && typeof json === "object" && "outcome" in json && "state" in json ? (json as { state: unknown }).state : json;
    return recordPublicState(this.trace, label, stateJson).state as WorkbookApiState;
  }

  #recordReflectionConversation(blockId: string, state: WorkbookApiState): void {
    const turns = state.progress?.reflectionConversations?.[blockId];
    if (!Array.isArray(turns)) return;
    const existingCount = this.trace.reflections.filter((entry) => entry.blockId === blockId).length;
    for (const turn of turns.slice(existingCount)) {
      if (!turn || typeof turn !== "object") continue;
      const role = (turn as { role?: unknown }).role;
      const text = (turn as { text?: unknown }).text;
      if ((role !== "learner" && role !== "tutor") || typeof text !== "string") continue;
      recordReflectionTurn(this.trace, { blockId, role, text });
    }
  }

  #reflectionReviewComplete(blockId: string, state: WorkbookApiState): boolean {
    const blocks = state.progress?.blocks;
    if (!Array.isArray(blocks)) return false;
    const block = blocks.find((candidate: any) => candidate?.id === blockId);
    const status = block?.checkpoint?.status;
    if (status === "accepted") return this.#reflectionHasTutorReplyAfterLatestLearner(blockId, state);
    if (status === "feedback") return this.#reflectionHasTutorReplyAfterLatestLearner(blockId, state);
    return false;
  }

  #reflectionHasTutorReplyAfterLatestLearner(blockId: string, state: WorkbookApiState): boolean {
    const turns = state.progress?.reflectionConversations?.[blockId];
    if (!Array.isArray(turns)) return false;
    const latestLearner = turns.map((turn: any) => turn?.role).lastIndexOf("learner");
    if (latestLearner < 0) return false;
    return turns.slice(latestLearner + 1).some((turn: any) => turn?.role === "tutor" && typeof turn.text === "string" && turn.text.trim().length > 0);
  }

  async #waitForReflectionReview(blockId: string, label: string, timeoutMs: number): Promise<WorkbookApiState> {
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;
    while (Date.now() <= deadline) {
      await delay(25);
      const state = await this.readState(`${label}:${++attempt}`);
      this.#recordReflectionConversation(blockId, state);
      if (this.#reflectionReviewComplete(blockId, state)) return state;
    }
    throw new Error(`Timed out waiting for reflection review for ${blockId}.`);
  }

  async #waitForEditorReview(blockId: string, revision: number, label: string, timeoutMs: number): Promise<WorkbookApiState> {
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;
    while (Date.now() <= deadline) {
      await delay(25);
      const state = await this.readState(`${label}:${++attempt}`);
      const status = this.#recordEditorProgress(blockId, revision, state);
      if (status === "feedback" || status === "unlocked") return state;
    }
    throw new Error(`Timed out waiting for editor-practice review for ${blockId} revision ${revision}.`);
  }

  #recordEditorProgress(blockId: string, revision: number, state: WorkbookApiState): "reviewing" | "feedback" | "unlocked" | undefined {
    const blocks = state.progress?.blocks;
    if (!Array.isArray(blocks)) return undefined;
    const block = blocks.find((candidate: any) => candidate?.id === blockId);
    if (!block || typeof block !== "object") return undefined;
    const checkpoint = (block as { checkpoint?: { status?: unknown; feedback?: unknown } }).checkpoint;
    const rawStatus = checkpoint?.status ?? (block as { editorStatus?: unknown }).editorStatus;
    const status = rawStatus === "accepted" ? "unlocked" : rawStatus;
    const publicRevision = (block as { revision?: unknown }).revision;
    if ((status !== "reviewing" && status !== "feedback" && status !== "unlocked") || publicRevision !== revision) return undefined;
    const feedback = typeof checkpoint?.feedback === "string" ? checkpoint.feedback : typeof (block as { feedback?: unknown }).feedback === "string" ? (block as { feedback: string }).feedback : undefined;
    recordEditorStatus(this.trace, feedback === undefined ? { blockId, revision, status } : { blockId, revision, status, feedback });
    return status;
  }

  async #waitForAcceptedCheckpoint(blockId: string, label: string, timeoutMs: number): Promise<WorkbookApiState> {
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;
    while (Date.now() <= deadline) {
      await delay(25);
      const state = await this.readState(`${label}:reviewed:${++attempt}`);
      const block = state.progress?.blocks?.find((candidate: any) => candidate?.id === blockId);
      if (block?.checkpoint?.status === "accepted") return state;
      if (block?.checkpoint?.status === "feedback") {
        const feedback = typeof block.checkpoint.feedback === "string" && block.checkpoint.feedback.trim().length > 0 ? `: ${block.checkpoint.feedback}` : ".";
        throw new Error(`Terminal attempt for ${blockId} received tutor feedback${feedback}`);
      }
    }
    throw new Error(`Timed out waiting for accepted terminal attempt for ${blockId}.`);
  }

  async #submitTerminalInput(blockId: string, input: string, label: string, reviewTimeoutMs: number): Promise<WorkbookApiState> {
    const ws = new this.#WebSocket(`${this.serverUrl.replace(/^http/, "ws")}/api/workbook/terminal`, { headers: { Origin: this.serverUrl } });
    let settled = false;
    let reviewStarted = false;
    let acceptedWaitStarted = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out connecting to workbook terminal for ${blockId}.`)), this.#terminalTimeoutMs);
        ws.once("open", () => { clearTimeout(timer); resolve(); });
        ws.once("error", (error) => { clearTimeout(timer); reject(error); });
      });

      recordTerminalTranscript(this.trace, { blockId, direction: "input", text: input });
      return await new Promise<WorkbookApiState>((resolve, reject) => {
        let submissionTimer: NodeJS.Timeout | undefined = setTimeout(() => finish(new Error(`Timed out waiting for terminal attempt submission for ${blockId}.`)), reviewTimeoutMs);
        const clearSubmissionTimer = () => {
          if (!submissionTimer) return;
          clearTimeout(submissionTimer);
          submissionTimer = undefined;
        };
        const finish = (result: Error | WorkbookApiState) => {
          if (settled) return;
          settled = true;
          clearSubmissionTimer();
          if (result instanceof Error) reject(result); else resolve(result);
        };
        ws.on("message", (data) => {
          const payload = data.toString();
          let frame: PublicTerminalMessage | undefined;
          try {
            // The private-state check reads the raw object, not the narrowed frame: a frame this
            // build has no branch for must still not be allowed to carry tutor guidance.
            assertNoPrivateTutorState(JSON.parse(payload), "terminal message");
            frame = parsePublicTerminalMessage(payload);
          } catch (error) {
            finish(error instanceof SyntaxError ? new Error("Workbook terminal sent a non-JSON message.") : error instanceof Error ? error : new Error(String(error)));
            return;
          }
          if (frame === undefined) return;

          const row = terminalTranscriptRow(frame, blockId);
          if (row) recordTerminalTranscript(this.trace, row);
          if (frame.type === "attempt-status" && frame.blockId === blockId && frame.status === "submitted" && !acceptedWaitStarted) {
            reviewStarted = true;
            acceptedWaitStarted = true;
            clearSubmissionTimer();
            void this.#waitForAcceptedCheckpoint(blockId, label, reviewTimeoutMs).then(finish, (error) => finish(error instanceof Error ? error : new Error(String(error))));
          }
        });
        ws.once("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
        ws.once("close", () => { if (!settled && !reviewStarted) finish(new Error(`Workbook terminal closed before ${blockId} was reviewed.`)); });
        ws.send(JSON.stringify({ type: "input", data: input }));
      });
    } finally {
      await closeWebSocket(ws);
    }
  }
}

export function createV2WorkbookDriver(options: V2WorkbookDriverOptions): V2WorkbookDriver {
  return new V2WorkbookDriver(options);
}

/**
 * Turns one socket frame into the transcript row that records it. The switch is over the union
 * `public-terminal-contract.ts` declares rather than over shapes described again here, so renaming
 * or adding a frame stops this file compiling instead of quietly dropping the frame from the trace.
 */
function terminalTranscriptRow(frame: PublicTerminalMessage, blockId: string): V2TerminalTranscriptEntry | undefined {
  switch (frame.type) {
    case "output": return { blockId, direction: "output", text: frame.data };
    case "attempt-status": return { blockId: frame.blockId ?? blockId, direction: "observer", text: `status:${frame.status}` };
    case "attempt-error": return { blockId: frame.blockId, direction: "observer", text: frame.message };
    case "terminal-error": return { blockId, direction: "observer", text: frame.message };
    case "busy": return { blockId, direction: "observer", text: frame.message };
    case "exit": return { blockId, direction: "observer", text: `exit:${frame.exitCode}${frame.signal === undefined ? "" : ` signal:${frame.signal}`}` };
    default: {
      // Only the frames no server sends are left. The annotation is the check: a new live frame
      // reaches here as an unassignable type until it gets a case above.
      const unsent: PublicTerminalLegacyFrame = frame;
      void unsent;
      return undefined;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function closeWebSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState === ws.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      ws.off("close", finish);
      resolve();
    };
    const timer = setTimeout(finish, 250);
    timer.unref?.();
    ws.once("close", finish);
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
  });
}
