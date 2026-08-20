import { WebSocket } from "ws";
import { assertNoPrivateTutorState, recordEditorStatus, recordPublicState, recordReflectionTurn, recordTerminalTranscript } from "./session.js";
import type { PublicWorkbookState, V2SessionTrace } from "./types.js";

export type WorkbookApiState = PublicWorkbookState & { [key: string]: any };

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type WebSocketConstructor = typeof WebSocket;

export interface V2WorkbookDriverOptions {
  serverUrl: string;
  trace: V2SessionTrace;
  fetch?: FetchLike;
  WebSocket?: WebSocketConstructor;
  terminalTimeoutMs?: number;
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
  readonly #editorRevisions = new Map<string, number>();

  constructor(options: V2WorkbookDriverOptions) {
    this.serverUrl = options.serverUrl.replace(/\/$/, "");
    this.trace = options.trace;
    this.#fetch = options.fetch ?? fetch;
    this.#WebSocket = options.WebSocket ?? WebSocket;
    this.#terminalTimeoutMs = options.terminalTimeoutMs ?? 5_000;
  }

  async readState(label = "state"): Promise<WorkbookApiState> {
    return this.#requestState("GET", "/api/workbook/state", undefined, label);
  }

  async completeIntroduction(label = "introduction"): Promise<WorkbookApiState> {
    return this.#requestState("POST", "/api/workbook/introduction", undefined, label);
  }

  async continueBlock(blockId: string, label = `continue:${blockId}`): Promise<WorkbookApiState> {
    return this.submitWorkbookAction(blockId, "continue", {}, label);
  }

  async submitReflection(blockId: string, response: string, label = `reflection:${blockId}:submit`): Promise<WorkbookApiState> {
    const state = await this.submitWorkbookAction(blockId, "reflection-submit", { response }, label);
    this.#recordReflectionConversation(blockId, state);
    return state;
  }

  async submitReflectionFollowUp(blockId: string, response: string, label = `reflection:${blockId}:follow-up`): Promise<WorkbookApiState> {
    const state = await this.submitWorkbookAction(blockId, "reflection-follow-up", { response }, label);
    this.#recordReflectionConversation(blockId, state);
    return state;
  }

  async completeReflection(blockId: string, label = `reflection:${blockId}:complete`): Promise<WorkbookApiState> {
    return this.submitWorkbookAction(blockId, "reflection-complete", {}, label);
  }

  async completeTerminalBlock(blockId: string, label = `terminal:${blockId}:complete`): Promise<WorkbookApiState> {
    return this.submitWorkbookAction(blockId, "complete", {}, label);
  }

  async submitWorkbookAction(blockId: string, action: string, payload: Record<string, unknown> = {}, label = `${action}:${blockId}`): Promise<WorkbookApiState> {
    return this.#requestState("POST", "/api/workbook/events", { blockId, action, ...payload }, label);
  }

  async submitEditorDraft(blockId: string, text: string, options: SubmitEditorDraftOptions = {}): Promise<WorkbookApiState> {
    const revision = (this.#editorRevisions.get(blockId) ?? 0) + 1;
    const label = options.label ?? `editor:${blockId}`;
    const submitted = await this.#requestState("POST", "/api/workbook/editor", { blockId, revision, text }, `${label}:reviewing`);
    this.#editorRevisions.set(blockId, revision);
    const submittedStatus = this.#recordEditorProgress(blockId, revision, submitted);
    if (submittedStatus === "feedback" || submittedStatus === "unlocked") return submitted;
    return this.#waitForEditorReview(blockId, revision, `${label}:reviewed`, options.timeoutMs ?? this.#terminalTimeoutMs);
  }

  async submitTerminalCommand(blockId: string, command: string, options: SubmitTerminalCommandOptions = {}): Promise<WorkbookApiState> {
    const input = /[\r\n]$/.test(command) ? command : `${command}\r`;
    const verifiedState = await this.#submitTerminalInput(blockId, input, options.label ?? `terminal:${blockId}:verified`, options.timeoutMs);
    if (options.complete === false) return verifiedState;
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
    return recordPublicState(this.trace, label, json).state as WorkbookApiState;
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
    const status = (block as { editorStatus?: unknown }).editorStatus;
    const publicRevision = (block as { revision?: unknown }).revision;
    if ((status !== "reviewing" && status !== "feedback" && status !== "unlocked") || publicRevision !== revision) return undefined;
    const feedback = typeof (block as { feedback?: unknown }).feedback === "string" ? (block as { feedback: string }).feedback : undefined;
    recordEditorStatus(this.trace, feedback === undefined ? { blockId, revision, status } : { blockId, revision, status, feedback });
    return status;
  }

  async #submitTerminalInput(blockId: string, input: string, label: string, timeoutMs = this.#terminalTimeoutMs): Promise<WorkbookApiState> {
    const ws = new this.#WebSocket(`${this.serverUrl.replace(/^http/, "ws")}/api/workbook/terminal`, { headers: { Origin: this.serverUrl } });
    let settled = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out connecting to workbook terminal for ${blockId}.`)), timeoutMs);
        ws.once("open", () => { clearTimeout(timer); resolve(); });
        ws.once("error", (error) => { clearTimeout(timer); reject(error); });
      });

      recordTerminalTranscript(this.trace, { blockId, direction: "input", text: input });
      return await new Promise<WorkbookApiState>((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error(`Timed out waiting for terminal verification for ${blockId}.`)), timeoutMs);
        const finish = (result: Error | WorkbookApiState) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (result instanceof Error) reject(result); else resolve(result);
        };
        ws.on("message", (data) => {
          let message: any;
          try { message = JSON.parse(data.toString()); }
          catch { finish(new Error("Workbook terminal sent a non-JSON message.")); return; }
          try { assertNoPrivateTutorState(message, "terminal message"); }
          catch (error) { finish(error instanceof Error ? error : new Error(String(error))); return; }

          if (message.type === "output" && typeof message.data === "string") {
            recordTerminalTranscript(this.trace, { blockId, direction: "output", text: message.data });
            return;
          }
          if (message.type === "observer-status") {
            recordTerminalTranscript(this.trace, { blockId: message.blockId ?? blockId, direction: "observer", text: `status:${message.status ?? "unknown"}` });
            return;
          }
          if (message.type === "advice" || message.type === "observer-error" || message.type === "terminal-error") {
            recordTerminalTranscript(this.trace, { blockId: message.blockId ?? blockId, direction: "observer", text: String(message.message ?? message.type) });
            return;
          }
          if (message.type === "verified-complete" && message.blockId === blockId) {
            recordTerminalTranscript(this.trace, { blockId, direction: "observer", text: String(message.summary ?? "verified") });
            const recorded = recordPublicState(this.trace, label, message.state).state as WorkbookApiState;
            finish(recorded);
          }
        });
        ws.once("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
        ws.once("close", () => { if (!settled) finish(new Error(`Workbook terminal closed before ${blockId} was verified.`)); });
        ws.send(JSON.stringify({ type: "input", data: input }));
      });
    } finally {
      if (!settled && ws.readyState === ws.OPEN) ws.close();
    }
  }
}

export function createV2WorkbookDriver(options: V2WorkbookDriverOptions): V2WorkbookDriver {
  return new V2WorkbookDriver(options);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
