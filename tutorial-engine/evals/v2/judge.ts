import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { V2GateResult, V2Scenario } from "./scenarios.js";
import { copyV2JudgeTrace } from "./session.js";
import { V2_ENGINE_EVAL_MARKERS, type V2ArtifactSnapshot, type V2EngineEvalMarkers, type V2JudgeCitation, type V2JudgeTrace } from "./types.js";

export interface JudgeDimension { score: 0 | 1 | 2; citations: number[]; rationale: string; }

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Judge did not return JSON.");
  return JSON.parse(fenced.slice(start, end + 1));
}

export const V2_JUDGE_COMMAND_TIMEOUT_MS = 120_000;
export const V2_JUDGE_PROMPT_MAX_BYTES = 1_048_576;
export const V2_JUDGE_STDOUT_MAX_BYTES = 262_144;
const V2_JUDGE_COMMAND_FAILURE_MESSAGE = "Judge command failed before returning a bounded JSON result.";
const V2_JUDGE_COMMAND_TIMEOUT_MESSAGE = "Judge command timed out before returning a bounded JSON result.";
const V2_JUDGE_COMMAND_PROMPT_TOO_LARGE_MESSAGE = "Judge prompt exceeded the bounded input size limit.";
const V2_JUDGE_COMMAND_OUTPUT_TOO_LARGE_MESSAGE = "Judge command exceeded the bounded output size limit.";
const V2_JUDGE_COMMAND_INVALID_JSON_MESSAGE = "Judge command returned invalid bounded JSON.";
const V2_JUDGE_COMMAND_CANCELLED_MESSAGE = "Judge command cancelled before returning a bounded JSON result.";

export interface JudgeCommandRequest { prompt: string; model?: string; environment?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal }

export type JudgeCommandLabel = "default-pi" | "configured-command";

function judgeCommandLabel(environment: NodeJS.ProcessEnv): JudgeCommandLabel {
  return environment.EVAL_JUDGE_COMMAND === undefined ? "default-pi" : "configured-command";
}

function judgeCommandParts(environment: NodeJS.ProcessEnv): [string, ...string[]] {
  const [command, ...args] = (environment.EVAL_JUDGE_COMMAND ?? "pi --no-session").trim().split(/\s+/);
  if (!command) throw new Error("EVAL_JUDGE_COMMAND is empty.");
  return [command, ...args];
}

export async function invokeJudgeCommand(request: JudgeCommandRequest): Promise<unknown> {
  const environment = request.environment ?? process.env;
  const model = request.model ?? environment.EVAL_JUDGE_MODEL;
  if (!model?.trim()) throw new Error("EVAL_JUDGE_MODEL is required for a live eval judge call.");
  if (Buffer.byteLength(request.prompt, "utf8") > V2_JUDGE_PROMPT_MAX_BYTES) throw new Error(V2_JUDGE_COMMAND_PROMPT_TOO_LARGE_MESSAGE);
  const [command, ...args] = judgeCommandParts(environment);
  const output = await new Promise<string>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, [...args, "--model", model, "-p"], {
        env: { PATH: environment.PATH ?? "", HOME: environment.HOME ?? "", NO_COLOR: "1" },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true
      });
    } catch {
      reject(new Error(V2_JUDGE_COMMAND_FAILURE_MESSAGE));
      return;
    }
    const timeoutMs = request.timeoutMs ?? V2_JUDGE_COMMAND_TIMEOUT_MS;
    let stdoutBytes = 0;
    let stdoutChunks: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let cancelling = false;
    let exited = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupAbort = () => undefined as void;
    const killChild = (signal: NodeJS.Signals): void => {
      if (child.pid && child.pid > 0) {
        try { process.kill(-child.pid, signal); } catch { /* ignore process-group kill races */ }
      }
      try { child.kill(signal); } catch { /* ignore kill races */ }
    };
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      cleanupAbort();
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.stdin.removeAllListeners();
      child.removeAllListeners("error");
      action();
    };
    const cancel = (message: string): void => {
      if (settled) return;
      cancelling = true;
      try { child.stdin.end(); } catch { try { child.stdin.destroy(); } catch { /* ignore */ } }
      killChild("SIGTERM");
      if (!exited) {
        killTimer = setTimeout(() => {
          if (exited) return;
          killTimer = undefined;
          killChild("SIGKILL");
        }, 500);
        killTimer.unref?.();
      }
      settle(() => reject(new Error(message)));
    };
    if (request.signal) {
      if (request.signal.aborted) { cancel(V2_JUDGE_COMMAND_CANCELLED_MESSAGE); return; }
      const abortListener = () => cancel(V2_JUDGE_COMMAND_CANCELLED_MESSAGE);
      request.signal.addEventListener("abort", abortListener, { once: true });
      cleanupAbort = () => request.signal?.removeEventListener("abort", abortListener);
    }
    timer = setTimeout(() => {
      timedOut = true;
      cancel(V2_JUDGE_COMMAND_TIMEOUT_MESSAGE);
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.length;
      if (stdoutBytes > V2_JUDGE_STDOUT_MAX_BYTES) {
        stdoutChunks = [];
        cancel(V2_JUDGE_COMMAND_OUTPUT_TOO_LARGE_MESSAGE);
        return;
      }
      stdoutChunks.push(buffer);
    });
    child.stdout.once("error", () => { if (!cancelling) settle(() => reject(new Error(V2_JUDGE_COMMAND_FAILURE_MESSAGE))); });
    child.stderr.on("data", () => { /* stderr is intentionally not retained; it can contain paths or secrets. */ });
    child.stderr.once("error", () => { if (!cancelling) settle(() => reject(new Error(V2_JUDGE_COMMAND_FAILURE_MESSAGE))); });
    child.once("error", () => { if (!cancelling) settle(() => reject(new Error(V2_JUDGE_COMMAND_FAILURE_MESSAGE))); });
    child.once("close", (code) => {
      exited = true;
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
      if (timedOut || cancelling) return;
      settle(() => code === 0 ? resolve(Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8")) : reject(new Error(V2_JUDGE_COMMAND_FAILURE_MESSAGE)));
    });
    child.stdin.once("error", () => { if (!cancelling) settle(() => reject(new Error(V2_JUDGE_COMMAND_FAILURE_MESSAGE))); });
    try { child.stdin.end(request.prompt, "utf8", () => { /* successful stdin completion is not a result boundary. */ }); }
    catch { settle(() => reject(new Error(V2_JUDGE_COMMAND_FAILURE_MESSAGE))); }
  });
  try { return extractJson(output); }
  catch { throw new Error(V2_JUDGE_COMMAND_INVALID_JSON_MESSAGE); }
}

async function invokeJudge(prompt: string, model = process.env.EVAL_JUDGE_MODEL): Promise<unknown> {
  return invokeJudgeCommand({ prompt, model });
}

export interface V2JudgeCommandPreflightResult {
  commandLabel: JudgeCommandLabel;
  model: string;
  capabilities: { jsonObject: true };
}

export async function probeV2JudgeCommandModel(environment: NodeJS.ProcessEnv = process.env, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<V2JudgeCommandPreflightResult> {
  const model = environment.EVAL_JUDGE_MODEL?.trim();
  if (!model) throw new Error("EVAL_JUDGE_MODEL is required for a live eval judge preflight.");
  const commandLabel = judgeCommandLabel(environment);
  let raw: unknown;
  try {
    judgeCommandParts(environment);
    raw = await invokeJudgeCommand({
      environment,
      model,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      prompt: "Judge connectivity preflight. Return exactly {\"ok\":true} as JSON and no other text."
    });
  } catch {
    throw new Error(`Judge command/model preflight failed for ${commandLabel}/${model}.`);
  }
  if (!raw || typeof raw !== "object" || (raw as { ok?: unknown }).ok !== true) throw new Error(`Judge command/model preflight failed for ${commandLabel}/${model}.`);
  return { commandLabel, model, capabilities: { jsonObject: true } };
}

function judgePass(result: { dimensions: Record<string, JudgeDimension> }): { passed: boolean; percentage: number } {
  const scores = Object.values(result.dimensions).map((dimension) => dimension.score);
  const total = scores.reduce<number>((sum, score) => sum + score, 0);
  const maximum = scores.length * 2;
  return { passed: scores.every((score) => score > 0) && total / maximum >= 0.8, percentage: maximum ? total / maximum : 0 };
}

export interface V2JudgeResult {
  dimensions: Record<V2JudgeDimensionName, JudgeDimension>;
  summary: string;
}

export interface V2PublicGateResult {
  passed: boolean;
  assertionCount: number;
  failureCount: number;
  assertions: Array<{ index: number; passed: boolean }>;
  detailPolicy: "assertion-details-omitted-from-public-report";
}

export interface V2Report extends V2EngineEvalMarkers {
  scenario: Pick<V2Scenario, "id" | "title" | "description" | "criteria">;
  modelIdentities: { tutor: string; judge: string };
  gate: V2PublicGateResult;
  trace: V2JudgeTrace;
  judgeInput: { prompt: string };
  judge: V2JudgeResult;
  artifacts: V2ArtifactSnapshot[];
  verdict: { passed: boolean; percentage: number };
}

export type V2JudgeDimensionName = "protocolUse" | "tutorQuality" | "criteriaFit";

const dimensions: V2JudgeDimensionName[] = ["protocolUse", "tutorQuality", "criteriaFit"];

export function buildV2JudgePrompt(scenario: V2Scenario, trace: V2JudgeTrace, gate: V2GateResult): string {
  const citations = enumerateTraceCitations(trace);
  return `You are a strict, stateless evaluator of one live v2 workbook tutoring session. Return JSON only.

Scenario:
${JSON.stringify({ id: scenario.id, title: scenario.title, description: scenario.description, criteria: scenario.criteria }, null, 2)}

Allowlisted public judge trace. Citation IDs are the id fields in this array. This list contains public workbook state (including public editor projections and browser-public timeline metadata), learner-visible terminal transcript, public reflection turns, projected structural workbook progression events, and allowlisted artifact snapshots. Raw workbook timeline rows, raw event IDs, raw sequence numbers/timestamps, attempt/request/session IDs, inline terminal evidence snapshots, terminal lifecycle records, private summaries, private failures, terminal HTML, and unknown future event types are not included. Public scenario/lesson/block/citation IDs and artifact paths remain. Judge-channel entry timestamps are removed; public state may retain browser-public timeline metadata already exposed by the workbook:
${JSON.stringify(citations, null, 2)}

Deterministic protocol gate:
${JSON.stringify(projectV2GateForPublicReport(gate), null, 2)}

Score these dimensions from 0 to 2:
- protocolUse: the tutor/session followed the v2 workbook protocol and used recorded state instead of hidden information.
- tutorQuality: the tutor gave concise, accurate, learner-centered help for this scenario.
- criteriaFit: the session satisfies the scenario criteria above.

Return exactly {"dimensions":{"protocolUse":{"score":0,"citations":[0],"rationale":"..."},"tutorQuality":{"score":0,"citations":[0],"rationale":"..."},"criteriaFit":{"score":0,"citations":[0],"rationale":"..."}},"summary":"..."}. Every citation must identify one trace citation ID above.`;
}

export async function judgeV2TraceFromPrompt(prompt: string, trace: V2JudgeTrace): Promise<V2JudgeResult> {
  const raw = await invokeJudge(prompt);
  return verifyV2JudgeResult(raw, trace);
}

export async function judgeV2Trace(scenario: V2Scenario, trace: V2JudgeTrace, gate: V2GateResult): Promise<V2JudgeResult> {
  return judgeV2TraceFromPrompt(buildV2JudgePrompt(scenario, trace, gate), trace);
}

export function verifyV2JudgeResult(value: unknown, trace: V2JudgeTrace): V2JudgeResult {
  if (!value || typeof value !== "object") throw new Error("Judge response is not an object.");
  const candidate = value as { dimensions?: Record<string, JudgeDimension>; summary?: unknown };
  if (!candidate.dimensions || typeof candidate.summary !== "string") throw new Error("Judge response has no dimensions or summary.");
  const validCitationIds = new Set(enumerateTraceCitations(trace).map((citation) => citation.id));
  const output = {} as Record<V2JudgeDimensionName, JudgeDimension>;
  for (const dimension of dimensions) {
    const score = candidate.dimensions[dimension];
    if (!score || ![0, 1, 2].includes(score.score) || !Array.isArray(score.citations) || typeof score.rationale !== "string") throw new Error(`Judge response is invalid for ${dimension}.`);
    if (!score.citations.every((id) => Number.isInteger(id) && validCitationIds.has(id))) throw new Error(`Judge cited an unknown trace citation for ${dimension}.`);
    output[dimension] = { score: score.score, citations: [...score.citations], rationale: score.rationale };
  }
  return { dimensions: output, summary: candidate.summary };
}

export function v2JudgePass(result: V2JudgeResult): { passed: boolean; percentage: number } {
  return judgePass(result);
}

export function createV2Report(options: { scenario: V2Scenario; trace: V2JudgeTrace; gate: V2GateResult; judgeInput: string; judge: V2JudgeResult; tutorModel: string; judgeModel: string }): V2Report {
  const trace = copyV2JudgeTrace(options.trace);
  const expectedJudgeInput = buildV2JudgePrompt(options.scenario, trace, options.gate);
  if (options.judgeInput !== expectedJudgeInput) throw new Error("Judge input does not match the sanitized v2 judge prompt.");
  const judge = verifyV2JudgeResult(options.judge, trace);
  return {
    ...V2_ENGINE_EVAL_MARKERS,
    scenario: {
      id: options.scenario.id,
      title: options.scenario.title,
      description: options.scenario.description,
      criteria: options.scenario.criteria
    },
    modelIdentities: { tutor: options.tutorModel, judge: options.judgeModel },
    gate: projectV2GateForPublicReport(options.gate),
    trace,
    judgeInput: { prompt: options.judgeInput },
    judge,
    artifacts: trace.artifacts,
    verdict: v2JudgePass(judge)
  };
}

export function projectV2GateForPublicReport(gate: V2GateResult): V2PublicGateResult {
  return {
    passed: gate.passed,
    assertionCount: gate.assertions.length,
    failureCount: gate.assertions.filter((assertion) => !assertion.passed).length,
    assertions: gate.assertions.map((assertion, index) => ({ index, passed: assertion.passed })),
    detailPolicy: "assertion-details-omitted-from-public-report"
  };
}

export function enumerateTraceCitations(trace: V2JudgeTrace): V2JudgeCitation[] {
  const safeTrace = copyV2JudgeTrace(trace);
  const citations: V2JudgeCitation[] = [];
  for (const value of safeTrace.publicStates) citations.push({ id: citations.length, kind: "publicState", value });
  for (const value of safeTrace.terminalTranscript) citations.push({ id: citations.length, kind: "terminalTranscript", value });
  for (const value of safeTrace.reflections) citations.push({ id: citations.length, kind: "reflection", value });
  for (const value of safeTrace.editors) citations.push({ id: citations.length, kind: "editor", value });
  for (const value of safeTrace.progressionEvents) citations.push({ id: citations.length, kind: "progressionEvent", value });
  for (const value of safeTrace.artifacts) citations.push({ id: citations.length, kind: "artifact", value });
  return citations;
}
