import { WebSocket } from "ws";
import { parsePublicWorkbookState, type PublicWorkbookState } from "../../tutorial-engine/src/workbook/public-contract.js";
import { parsePublicTerminalMessage, type PublicTerminalFrame } from "../../tutorial-engine/src/workbook/public-terminal-contract.js";
import {
  recordAuthoredWorkbookEvalEditorStatus,
  recordAuthoredWorkbookEvalPublicState,
  recordAuthoredWorkbookEvalReflectionTurn,
  recordAuthoredWorkbookEvalTerminalTranscript,
  type AuthoredWorkbookEvalEditorEntry,
  type AuthoredWorkbookEvalSessionTrace,
  type AuthoredWorkbookEvalTerminalTranscriptEntry
} from "./public-trace.js";

export type WorkbookApiState = PublicWorkbookState;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type WebSocketConstructor = typeof WebSocket;
export type TerminalFeedbackExpectation = string | RegExp | ((message: string, state: WorkbookApiState) => boolean);

interface TerminalReviewBaseline {
  terminalSignature: string;
  timelineSequence: number;
  terminalRevision?: number;
}

export interface AuthoredWorkbookDriverOptions {
  serverUrl: string;
  trace: AuthoredWorkbookEvalSessionTrace;
  fetch?: FetchLike;
  WebSocket?: WebSocketConstructor;
  terminalTimeoutMs?: number;
  terminalReviewTimeoutMs?: number;
  editorReviewTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxStructuralAutoProgressionSteps?: number;
  /**
   * Runner-private shell prefix prepended only to WebSocket input bytes. It is stripped from
   * all driver-recorded trace/state/transcript data and must never appear in reports.
   */
  privateTerminalShellPrefix?: string;
  signal?: AbortSignal;
}

export interface SubmitTerminalCommandOptions {
  label?: string;
  complete?: boolean;
  timeoutMs?: number;
  expectedFeedback?: TerminalFeedbackExpectation;
}

export interface SubmitEditorDraftOptions {
  label?: string;
  timeoutMs?: number;
}

class WorkbookHttpStatusError extends Error {
  constructor(readonly method: "GET" | "POST", readonly path: string, readonly status: number) {
    super(`${method} ${path} failed with HTTP ${status}.`);
  }
}

export class AuthoredWorkbookDriver {
  readonly serverUrl: string;
  readonly trace: AuthoredWorkbookEvalSessionTrace;
  readonly #fetch: FetchLike;
  readonly #WebSocket: WebSocketConstructor;
  readonly #terminalTimeoutMs: number;
  readonly #terminalReviewTimeoutMs: number;
  readonly #editorReviewTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  readonly #maxStructuralAutoProgressionSteps: number;
  readonly #privateTerminalShellPrefix?: string;
  readonly #privateTerminalNeedles: readonly string[];
  readonly #signal?: AbortSignal;

  constructor(options: AuthoredWorkbookDriverOptions) {
    this.serverUrl = options.serverUrl.replace(/\/$/, "");
    this.trace = options.trace;
    this.#fetch = options.fetch ?? fetch;
    this.#WebSocket = options.WebSocket ?? WebSocket;
    this.#terminalTimeoutMs = options.terminalTimeoutMs ?? 5_000;
    this.#terminalReviewTimeoutMs = options.terminalReviewTimeoutMs ?? 120_000;
    this.#editorReviewTimeoutMs = options.editorReviewTimeoutMs ?? 120_000;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.#maxStructuralAutoProgressionSteps = options.maxStructuralAutoProgressionSteps ?? 100;
    this.#privateTerminalShellPrefix = normalizePrivateTerminalShellPrefix(options.privateTerminalShellPrefix);
    this.#privateTerminalNeedles = privateTerminalNeedles(this.#privateTerminalShellPrefix);
    this.#signal = options.signal;
  }

  async readState(label = "state"): Promise<WorkbookApiState> {
    return this.#requestState("GET", "/api/workbook/state", undefined, label);
  }

  async completeIntroduction(label = "introduction"): Promise<WorkbookApiState> {
    let state = await this.#requestState("POST", "/api/workbook/introduction", undefined, label);
    const visited = new Set<string>();
    let steps = 0;
    while (state.currentBlock?.origin === "structural" && state.progress.activeBlockId !== "workbook--complete") {
      const activeBlockId = state.progress.activeBlockId;
      if (visited.has(activeBlockId)) throw new Error(`Structural workbook introduction progression repeated block '${activeBlockId}'.`);
      visited.add(activeBlockId);
      if (++steps > this.#maxStructuralAutoProgressionSteps) throw new Error("Structural workbook introduction progression exceeded the step limit.");
      state = await this.#requestState("POST", "/api/workbook/complete-block", { blockId: activeBlockId }, `${label}:structural:${activeBlockId}`);
    }
    return state;
  }

  async continueBlock(blockId: string, label = `continue:${blockId}`): Promise<WorkbookApiState> {
    const canonicalBlockId = await this.#canonicalBlockId(blockId);
    if (isStructuralWorkbookBlockId(canonicalBlockId)) {
      const state = await this.readState(`${label}:active`);
      if (state.currentBlock?.id === canonicalBlockId && state.currentBlock.origin !== "lesson") {
        const canComplete = state.progress.canComplete;
        if (canComplete?.blockId !== canonicalBlockId || canComplete.eligible !== true) throw new Error(`Workbook structural block '${canonicalBlockId}' is active but not eligible to continue.`);
        const advanced = await this.#requestState("POST", "/api/workbook/complete-block", { blockId: canonicalBlockId }, label);
        if (advanced.progress.activeBlockId !== canonicalBlockId || workbookBlockState(advanced, canonicalBlockId)?.completed === true) return advanced;
        throw new Error(`Workbook structural block '${canonicalBlockId}' did not advance after continue.`);
      }
    }
    return this.submitWorkbookAction(canonicalBlockId, "continue", {}, label);
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
    const canonicalBlockId = await this.#canonicalBlockId(blockId);
    try {
      return await this.submitWorkbookAction(canonicalBlockId, "continue", {}, label);
    } catch (error) {
      if (!isHttpStatusError(error, "POST", "/api/workbook/events", 409)) throw error;
      const state = await this.readState(`${label}:conflict-state`);
      if (terminalCompletionAlreadyApplied(state, canonicalBlockId)) return state;
      throw error;
    }
  }

  async submitWorkbookAction(blockId: string, action: string, payload: Record<string, unknown> = {}, label = `${action}:${blockId}`): Promise<WorkbookApiState> {
    return this.#requestState("POST", "/api/workbook/events", { blockId, action, ...payload }, label);
  }

  async submitEditorDraft(blockId: string, text: string, options: SubmitEditorDraftOptions = {}): Promise<WorkbookApiState> {
    const authoredBlockId = blockId;
    blockId = await this.#canonicalBlockId(blockId);
    const label = options.label ?? `editor:${authoredBlockId}`;
    const submitted = await this.#requestState("POST", "/api/workbook/editor", { blockId, text }, `${label}:reviewing`);
    const submittedBlock = workbookBlockState(submitted, blockId);
    const revision = submittedBlock?.revision;
    if (!Number.isInteger(revision) || (revision as number) < 1) throw new Error(`Workbook editor response did not include a submitted public revision for ${blockId}.`);
    const submittedStatus = this.#recordEditorProgress(blockId, revision as number, submitted);
    if (submittedStatus === "feedback" || submittedStatus === "unlocked") return submitted;
    return this.#waitForEditorReview(blockId, revision as number, `${label}:reviewed`, options.timeoutMs ?? this.#editorReviewTimeoutMs);
  }

  async submitTerminalCommand(blockId: string, command: string, options: SubmitTerminalCommandOptions = {}): Promise<WorkbookApiState> {
    const authoredBlockId = blockId;
    blockId = await this.#canonicalBlockId(blockId);
    const logicalInput = /[\r\n]$/.test(command) ? command : `${command}\r`;
    const socketInput = this.#privateTerminalShellPrefix === undefined ? logicalInput : `${this.#privateTerminalShellPrefix}\n${logicalInput}`;
    const label = options.label ?? `terminal:${authoredBlockId}`;
    const reviewed = await this.#submitTerminalInput(blockId, socketInput, logicalInput, label, options.timeoutMs ?? this.#terminalReviewTimeoutMs, options.expectedFeedback);
    const terminal = terminalStateFor(reviewed, blockId);
    if (terminal?.phase === "feedback" || options.complete === false) return reviewed;
    return this.completeTerminalBlock(blockId);
  }

  async #canonicalBlockId(blockId: string): Promise<string> {
    if (blockId.includes("--") || blockId.startsWith("workbook--") || blockId.startsWith("part--")) return blockId;
    const state = await this.readState(`resolve:${blockId}`);
    const matches = state.orderedBlocks?.filter((candidate) => candidate.declaredId === blockId || candidate.id === blockId) ?? [];
    const activeId = state.progress.activeBlockId;
    const activeOrdered = matches.find((candidate) => candidate.id === activeId);
    if (activeOrdered) return activeOrdered.id;
    if ((state.currentBlock?.declaredId === blockId || state.currentBlock?.id === blockId) && state.currentBlock.id === activeId) return state.currentBlock.id;
    if (matches.length === 0) return blockId;
    if (matches.length === 1) return matches[0]!.id;
    throw new Error(`Ambiguous workbook block id '${blockId}' matches ${matches.map((match) => match.id).join(", ")}. Use a canonical block id.`);
  }

  async #requestState(method: "GET" | "POST", path: string, body: unknown, label: string, signal?: AbortSignal): Promise<WorkbookApiState> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error("Timed out waiting for workbook HTTP response.")), this.#requestTimeoutMs);
    const combined = combineAbortSignals(this.#signal, signal, timeout.signal);
    const combinedSignal = combined.signal;
    try {
      throwIfAborted(combinedSignal);
      const response = await withAbort(this.#fetch(`${this.serverUrl}${path}`, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: combinedSignal
      }), combinedSignal);
      if (!response.ok) throw new WorkbookHttpStatusError(method, path, response.status);
      const text = await withAbort(response.text(), combinedSignal);
      let json: unknown;
      try { json = text ? JSON.parse(text) : {}; }
      catch { throw new Error(`${method} ${path} returned non-JSON response (${response.status}).`); }
      const stateJson = json && typeof json === "object" && "outcome" in json && "state" in json ? (json as { state: unknown }).state : json;
      throwIfAborted(combinedSignal);
      const sanitizedStateJson = sanitizePrivateTerminalValue(stateJson, this.#privateTerminalNeedles);
      const state = parsePublicWorkbookState(sanitizedStateJson);
      throwIfAborted(combinedSignal);
      return recordAuthoredWorkbookEvalPublicState(this.trace, label, state).state;
    } catch (error) {
      if (timeout.signal.aborted) throw new Error("Timed out waiting for workbook HTTP response.");
      if (this.#signal?.aborted || signal?.aborted) throw cancelledError();
      throw error;
    } finally {
      clearTimeout(timer);
      combined.cleanup();
    }
  }

  #recordReflectionConversation(blockId: string, state: WorkbookApiState): void {
    const turns = state.progress.reflectionConversations[blockId];
    if (!Array.isArray(turns)) return;
    const existingCount = this.trace.reflections.filter((entry) => entry.blockId === blockId).length;
    for (const turn of turns.slice(existingCount)) {
      recordAuthoredWorkbookEvalReflectionTurn(this.trace, { blockId, role: turn.role, text: turn.text });
    }
  }

  #reflectionReviewComplete(blockId: string, state: WorkbookApiState): boolean {
    const block = state.progress.blocks.find((candidate) => candidate.id === blockId);
    const status = block?.checkpoint?.status;
    if (status === "accepted" || status === "feedback") return this.#reflectionHasTutorReplyAfterLatestLearner(blockId, state);
    return false;
  }

  #reflectionHasTutorReplyAfterLatestLearner(blockId: string, state: WorkbookApiState): boolean {
    const turns = state.progress.reflectionConversations[blockId];
    if (!Array.isArray(turns)) return false;
    const latestLearner = turns.map((turn) => turn.role).lastIndexOf("learner");
    if (latestLearner < 0) return false;
    return turns.slice(latestLearner + 1).some((turn) => turn.role === "tutor" && turn.text.trim().length > 0);
  }

  async #waitForReflectionReview(blockId: string, label: string, timeoutMs: number): Promise<WorkbookApiState> {
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const timeout = () => new Error(`Timed out waiting for reflection review for ${blockId}.`);
    const combined = combineAbortSignals(this.#signal, timeoutController.signal);
    try {
      const deadline = Date.now() + timeoutMs;
      let attempt = 0;
      while (Date.now() <= deadline) {
        await delay(25, combined.signal);
        const state = await this.#requestState("GET", "/api/workbook/state", undefined, `${label}:${++attempt}`, combined.signal);
        throwIfAborted(combined.signal);
        this.#recordReflectionConversation(blockId, state);
        if (this.#reflectionReviewComplete(blockId, state)) return state;
      }
      throw timeout();
    } catch (error) {
      if (timeoutController.signal.aborted) throw timeout();
      if (this.#signal?.aborted) throw cancelledError();
      throw error;
    } finally {
      clearTimeout(timer);
      combined.cleanup();
    }
  }

  async #waitForEditorReview(blockId: string, revision: number, label: string, timeoutMs: number): Promise<WorkbookApiState> {
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const timeout = () => new Error(`Timed out waiting for editor-practice review for ${blockId} revision ${revision}.`);
    const combined = combineAbortSignals(this.#signal, timeoutController.signal);
    try {
      const deadline = Date.now() + timeoutMs;
      let attempt = 0;
      while (Date.now() <= deadline) {
        await delay(25, combined.signal);
        const state = await this.#requestState("GET", "/api/workbook/state", undefined, `${label}:${++attempt}`, combined.signal);
        throwIfAborted(combined.signal);
        const status = this.#recordEditorProgress(blockId, revision, state);
        if (status === "feedback" || status === "unlocked") return state;
      }
      throw timeout();
    } catch (error) {
      if (timeoutController.signal.aborted) throw timeout();
      if (this.#signal?.aborted) throw cancelledError();
      throw error;
    } finally {
      clearTimeout(timer);
      combined.cleanup();
    }
  }

  #recordEditorProgress(blockId: string, revision: number, state: WorkbookApiState): AuthoredWorkbookEvalEditorEntry["status"] | undefined {
    const block = workbookBlockState(state, blockId);
    if (!block) return undefined;
    const rawStatus = block.checkpoint?.status ?? block.editorStatus;
    const status = rawStatus === "accepted" ? "unlocked" : rawStatus;
    if ((status !== "reviewing" && status !== "feedback" && status !== "unlocked") || block.revision !== revision) return undefined;
    const legacyFeedback = (block as unknown as { feedback?: unknown }).feedback;
    const feedback = block.checkpoint?.feedback ?? (typeof legacyFeedback === "string" ? legacyFeedback : undefined);
    recordAuthoredWorkbookEvalEditorStatus(this.trace, feedback === undefined ? { blockId, revision, status } : { blockId, revision, status, feedback });
    return status;
  }

  async #waitForTerminalReview(blockId: string, label: string, timeoutMs: number, expectedFeedback: TerminalFeedbackExpectation | undefined, baseline: TerminalReviewBaseline, signal: AbortSignal): Promise<WorkbookApiState> {
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;
    let observedReviewTransition = false;
    while (Date.now() <= deadline) {
      await delay(25, signal);
      throwIfAborted(signal);
      const state = await this.#requestState("GET", "/api/workbook/state", undefined, `${label}:reviewed:${++attempt}`, signal);
      throwIfAborted(signal);
      const terminal = terminalStateFor(state, blockId);
      const changedTerminal = terminalSignature(terminal) !== baseline.terminalSignature;
      const revisionAdvanced = terminalRevisionAdvanced(state, blockId, baseline.terminalRevision);
      const relevantTimeline = terminal?.phase === "feedback" || terminal?.phase === "accepted" ? hasRelevantTimelineAfter(state, blockId, baseline.timelineSequence, terminal.message) : false;
      if ((terminal?.phase === "running" || terminal?.phase === "checking") && (revisionAdvanced || changedTerminal)) observedReviewTransition = true;
      const correlated = revisionAdvanced || relevantTimeline || changedTerminal || observedReviewTransition;
      if (!correlated) continue;
      if (terminal?.phase === "accepted") {
        if (expectedFeedback !== undefined) throw new Error(`Expected terminal feedback for ${blockId}, but the attempt was accepted.`);
        return state;
      }
      if (terminal?.phase === "feedback") {
        if (expectedFeedback === undefined) throw new Error(`Terminal attempt for ${blockId} received tutor feedback: ${terminal.message}`);
        if (!feedbackMatches(expectedFeedback, terminal.message, state)) throw new Error(`Terminal attempt for ${blockId} received unexpected tutor feedback: ${terminal.message}`);
        return state;
      }
    }
    throw new Error(`Timed out waiting for terminal review for ${blockId}.`);
  }

  async #submitTerminalInput(blockId: string, socketInput: string, logicalInput: string, label: string, reviewTimeoutMs: number, expectedFeedback: TerminalFeedbackExpectation | undefined): Promise<WorkbookApiState> {
    throwIfAborted(this.#signal);
    let ws: WebSocket;
    try {
      ws = new this.#WebSocket(`${this.serverUrl.replace(/^http/, "ws")}/api/workbook/terminal`, { headers: { Origin: this.serverUrl } });
    } catch {
      throw new Error(`Workbook terminal socket could not be created for ${blockId}.`);
    }
    try {
      return await new Promise<WorkbookApiState>((resolve, reject) => {
        let settled = false;
        const reviewAbort = new AbortController();
        let reviewTimer: ReturnType<typeof setTimeout> | undefined;
        let openTimer: ReturnType<typeof setTimeout> | undefined;
        let cleanupSocket = () => {};
        let cleanupExternalAbort = () => {};
        const finish = (result: Error | WorkbookApiState) => {
          if (settled) return;
          settled = true;
          if (openTimer !== undefined) clearTimeout(openTimer);
          if (reviewTimer !== undefined) clearTimeout(reviewTimer);
          reviewAbort.abort(result instanceof Error ? result : undefined);
          cleanupSocket();
          cleanupExternalAbort();
          if (result instanceof Error) reject(result); else resolve(result);
        };
        const handleSocketError = () => finish(new Error(`Workbook terminal socket errored before terminal review completed for ${blockId}.`));
        const handleExternalAbort = () => finish(cancelledError());
        if (this.#signal) {
          if (this.#signal.aborted) handleExternalAbort();
          else {
            this.#signal.addEventListener("abort", handleExternalAbort, { once: true });
            cleanupExternalAbort = () => this.#signal?.removeEventListener("abort", handleExternalAbort);
          }
        }
        if (settled) return;
        const handleSocketClose = () => {
          if (!settled) finish(new Error(`Workbook terminal socket closed before terminal review completed for ${blockId}.`));
        };
        let bufferingDuringSend = false;
        let commandSent = false;
        const bufferedDuringSend: PublicTerminalFrame[] = [];
        const failFrame = (frame: PublicTerminalFrame): boolean => {
          if (frame.type === "terminal-error" || frame.type === "busy") {
            const row = terminalTranscriptRow(frame, blockId);
            if (row) recordAuthoredWorkbookEvalTerminalTranscript(this.trace, sanitizePrivateTerminalTranscriptEntry(row, this.#privateTerminalNeedles));
            finish(new Error(sanitizePrivateTerminalText(frame.message, this.#privateTerminalNeedles)));
            return true;
          }
          if (frame.type === "exit") {
            const row = terminalTranscriptRow(frame, blockId);
            if (row) recordAuthoredWorkbookEvalTerminalTranscript(this.trace, sanitizePrivateTerminalTranscriptEntry(row, this.#privateTerminalNeedles));
            finish(new Error(`Workbook terminal command exited with code ${frame.exitCode}${frame.signal === undefined ? "" : ` signal ${frame.signal}`}.`));
            return true;
          }
          return false;
        };
        const processPostSendFrame = (frame: PublicTerminalFrame) => {
          if (failFrame(frame)) return;
          const row = terminalTranscriptRow(frame, blockId);
          if (row) recordAuthoredWorkbookEvalTerminalTranscript(this.trace, sanitizePrivateTerminalTranscriptEntry(row, this.#privateTerminalNeedles));
        };
        const processPreSendFrame = (frame: PublicTerminalFrame) => {
          if (frame.type === "output") return;
          failFrame(frame);
        };
        const handleMessage = (data: { toString(): string }) => {
          const payload = data.toString();
          let frame: PublicTerminalFrame | undefined;
          try { frame = parsePublicTerminalMessage(payload); }
          catch (error) {
            finish(error instanceof SyntaxError ? new Error("Workbook terminal sent a non-JSON message.") : error instanceof Error ? error : new Error(String(error)));
            return;
          }
          if (!frame) return;
          if (bufferingDuringSend) {
            bufferedDuringSend.push(frame);
            return;
          }
          if (commandSent) processPostSendFrame(frame);
          else processPreSendFrame(frame);
        };
        const handleOpen = () => {
          clearTimeout(openTimer);
          if (settled) return;
          reviewTimer = setTimeout(() => finish(new Error(`Timed out waiting for terminal review for ${blockId}.`)), reviewTimeoutMs);
          void (async () => {
            const baselineState = await this.#requestState("GET", "/api/workbook/state", undefined, `${label}:baseline`, reviewAbort.signal);
            const baseline = terminalReviewBaseline(baselineState, blockId);
            throwIfAborted(reviewAbort.signal);
            if (settled) return;
            try {
              bufferingDuringSend = true;
              throwIfAborted(reviewAbort.signal);
              ws.send(JSON.stringify({ type: "input", data: socketInput }));
            } catch {
              bufferedDuringSend.length = 0;
              finish(new Error(`Workbook terminal socket send failed before terminal review completed for ${blockId}.`));
              return;
            } finally {
              bufferingDuringSend = false;
            }
            if (settled || reviewAbort.signal.aborted) {
              bufferedDuringSend.length = 0;
              return;
            }
            commandSent = true;
            recordAuthoredWorkbookEvalTerminalTranscript(this.trace, { blockId, direction: "input", text: logicalInput });
            for (const frame of bufferedDuringSend.splice(0)) processPostSendFrame(frame);
            if (settled || reviewAbort.signal.aborted) return;
            void this.#waitForTerminalReview(blockId, label, reviewTimeoutMs, expectedFeedback, baseline, reviewAbort.signal).then(finish, (error) => finish(error instanceof Error ? error : new Error(String(error))));
          })().catch((error) => {
            if (this.#signal?.aborted) finish(cancelledError());
            else finish(error instanceof Error ? error : new Error(String(error)));
          });
        };
        openTimer = setTimeout(() => finish(new Error(`Timed out connecting to workbook terminal for ${blockId}.`)), this.#terminalTimeoutMs);
        cleanupSocket = () => {
          ws.off("message", handleMessage);
          ws.off("error", handleSocketError);
          ws.off("close", handleSocketClose);
          ws.off("open", handleOpen);
        };
        ws.on("message", handleMessage);
        ws.once("error", handleSocketError);
        ws.once("close", handleSocketClose);
        ws.once("open", handleOpen);
      });
    } finally {
      await closeWebSocket(ws);
    }
  }
}

export function createAuthoredWorkbookDriver(options: AuthoredWorkbookDriverOptions): AuthoredWorkbookDriver {
  return new AuthoredWorkbookDriver(options);
}

function workbookBlockState(state: WorkbookApiState, blockId: string): PublicWorkbookState["progress"]["blocks"][number] | undefined {
  return state.progress.blocks.find((candidate) => candidate.id === blockId);
}

function terminalStateFor(state: WorkbookApiState, blockId: string): PublicWorkbookState["progress"]["blocks"][number]["terminal"] | undefined {
  return workbookBlockState(state, blockId)?.terminal;
}

function terminalCompletionAlreadyApplied(state: WorkbookApiState, blockId: string): boolean {
  const block = workbookBlockState(state, blockId);
  return state.progress.activeBlockId !== blockId
    && block?.completed === true
    && block.verified === true
    && block.workAccepted === true
    && block.terminal?.phase === "accepted";
}

function isStructuralWorkbookBlockId(blockId: string): boolean {
  return blockId === "workbook--introduction" || blockId === "workbook--complete" || blockId.startsWith("part--") || (blockId.startsWith("lesson--") && blockId.split("--").length === 2);
}

function isHttpStatusError(error: unknown, method: "GET" | "POST", path: string, status: number): error is WorkbookHttpStatusError {
  return error instanceof WorkbookHttpStatusError && error.method === method && error.path === path && error.status === status;
}

function terminalReviewBaseline(state: WorkbookApiState, blockId: string): TerminalReviewBaseline {
  return { terminalSignature: terminalSignature(terminalStateFor(state, blockId)), timelineSequence: maxTimelineSequence(state), terminalRevision: terminalRevisionFor(state, blockId) };
}

function terminalRevisionFor(state: WorkbookApiState, blockId: string): number | undefined {
  const revision = workbookBlockState(state, blockId)?.terminalRevision;
  return Number.isInteger(revision) && (revision as number) >= 0 ? revision as number : undefined;
}

function terminalRevisionAdvanced(state: WorkbookApiState, blockId: string, baselineRevision: number | undefined): boolean {
  const revision = terminalRevisionFor(state, blockId);
  if (revision === undefined) return false;
  return baselineRevision === undefined ? revision > 0 : revision > baselineRevision;
}

function terminalSignature(terminal: PublicWorkbookState["progress"]["blocks"][number]["terminal"] | undefined): string {
  return JSON.stringify(terminal ?? null);
}

function maxTimelineSequence(state: WorkbookApiState): number {
  return state.timeline.reduce((maximum, record) => Math.max(maximum, record.sequence), 0);
}

function hasRelevantTimelineAfter(state: WorkbookApiState, blockId: string, baselineSequence: number, terminalMessage: string): boolean {
  return state.timeline.some((record) => {
    if (record.sequence <= baselineSequence || record.blockId !== blockId && (!("blockInView" in record) || record.blockInView !== blockId)) return false;
    return record.type === "message" && record.text === terminalMessage;
  });
}

function feedbackMatches(expectation: TerminalFeedbackExpectation, message: string, state: WorkbookApiState): boolean {
  if (typeof expectation === "string") return message.includes(expectation);
  if (expectation instanceof RegExp) return expectation.test(message);
  return expectation(message, state);
}

function terminalTranscriptRow(frame: PublicTerminalFrame, blockId: string): AuthoredWorkbookEvalTerminalTranscriptEntry | undefined {
  switch (frame.type) {
    case "output": return { blockId, direction: "output", text: frame.data };
    case "terminal-error": return { blockId, direction: "observer", text: frame.message };
    case "busy": return { blockId, direction: "observer", text: frame.message };
    case "exit": return { blockId, direction: "observer", text: `exit:${frame.exitCode}${frame.signal === undefined ? "" : ` signal:${frame.signal}`}` };
  }
}

function normalizePrivateTerminalShellPrefix(prefix: string | undefined): string | undefined {
  if (prefix === undefined) return undefined;
  const trimmed = prefix.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function privateTerminalNeedles(prefix: string | undefined): readonly string[] {
  if (prefix === undefined) return [];
  return [...new Set([prefix, `${prefix}\n`, `${prefix}\r`, `${prefix}\r\n`])];
}

function sanitizePrivateTerminalTranscriptEntry(entry: AuthoredWorkbookEvalTerminalTranscriptEntry, needles: readonly string[]): AuthoredWorkbookEvalTerminalTranscriptEntry {
  if (needles.length === 0) return entry;
  return { ...entry, text: sanitizePrivateTerminalText(entry.text, needles) };
}

function sanitizePrivateTerminalValue(value: unknown, needles: readonly string[]): unknown {
  if (needles.length === 0) return value;
  if (typeof value === "string") return sanitizePrivateTerminalText(value, needles);
  if (Array.isArray(value)) return value.map((item) => sanitizePrivateTerminalValue(item, needles));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = sanitizePrivateTerminalValue(child, needles);
    return out;
  }
  return value;
}

function sanitizePrivateTerminalText(text: string, needles: readonly string[]): string {
  let sanitized = text;
  for (const needle of needles) sanitized = sanitized.split(needle).join("");
  return sanitized.replace(/^[\r\n]+/, "");
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(cancelledError());
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(cancelledError());
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }
    );
  });
}

function combineAbortSignals(...signals: Array<AbortSignal | undefined>): { signal: AbortSignal | undefined; cleanup: () => void } {
  const active = [...new Set(signals.filter((signal): signal is AbortSignal => signal !== undefined))];
  if (active.length === 0) return { signal: undefined, cleanup: () => {} };
  if (active.length === 1) return { signal: active[0], cleanup: () => {} };
  const controller = new AbortController();
  const listeners: Array<readonly [AbortSignal, () => void]> = [];
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  for (const signal of active) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    const listener = () => abort(signal);
    signal.addEventListener("abort", listener, { once: true });
    listeners.push([signal, listener]);
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
      listeners.length = 0;
    }
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw cancelledError();
}

function cancelledError(): Error {
  return new Error("Authored workbook driver operation was cancelled.");
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
      ws.off("error", finish);
      resolve();
    };
    const timer = setTimeout(finish, 250);
    timer.unref?.();
    ws.once("close", finish);
    ws.once("error", finish);
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
  });
}
