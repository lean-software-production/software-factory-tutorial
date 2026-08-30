import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { copyAuthoredWorkbookEvalTrace, enumerateAuthoredWorkbookEvalJudgeCitations, projectAuthoredWorkbookEvalTraceForJudge, type AuthoredWorkbookEvalCitation, type AuthoredWorkbookEvalJudgeTrace, type AuthoredWorkbookEvalTrace } from "./public-trace.js";

export const AUTHORED_WORKBOOK_JUDGE_COMMAND_TIMEOUT_MS = 120_000;
export const AUTHORED_WORKBOOK_JUDGE_PROMPT_MAX_BYTES = 1_048_576;
export const AUTHORED_WORKBOOK_JUDGE_STDOUT_MAX_BYTES = 262_144;

const SCENARIO_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const CRITERION_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_SCENARIO_TEXT_BYTES = 8 * 1024;
const MAX_CRITERIA = 20;
const MAX_JUDGE_RATIONALE_BYTES = 2 * 1024;
const MAX_JUDGE_SUMMARY_BYTES = 4 * 1024;

const JUDGE_COMMAND_FAILURE_MESSAGE = "Judge command failed before returning a bounded JSON result.";
const JUDGE_COMMAND_TIMEOUT_MESSAGE = "Judge command timed out before returning a bounded JSON result.";
const JUDGE_COMMAND_PROMPT_TOO_LARGE_MESSAGE = "Judge prompt exceeded the bounded input size limit.";
const JUDGE_COMMAND_OUTPUT_TOO_LARGE_MESSAGE = "Judge command exceeded the bounded output size limit.";
const JUDGE_COMMAND_INVALID_JSON_MESSAGE = "Judge command returned invalid bounded JSON.";
const JUDGE_COMMAND_CANCELLED_MESSAGE = "Judge command cancelled before returning a bounded JSON result.";

export interface AuthoredWorkbookEvalScenarioCriterion {
  id: string;
  title: string;
  description: string;
}

/** Scenario-public descriptor rebuilt by scenario code. Never pass lesson specs or tutor rubrics directly. */
export interface AuthoredWorkbookEvalScenarioPublicDescriptor {
  id: string;
  title: string;
  description: string;
  criteria: AuthoredWorkbookEvalScenarioCriterion[];
}

export interface AuthoredWorkbookEvalGateAssertion {
  name: string;
  passed: boolean;
  detail?: string;
}

/** Internal deterministic gate result. Details are local diagnostics only. */
export interface AuthoredWorkbookEvalGateResult {
  passed: boolean;
  assertions: AuthoredWorkbookEvalGateAssertion[];
}

export interface AuthoredWorkbookEvalPublicGateResult {
  passed: boolean;
  assertionCount: number;
  failureCount: number;
  assertions: Array<{ index: number; passed: boolean }>;
  detailPolicy: "assertion-details-omitted-from-public-report";
}

export interface AuthoredWorkbookEvalJudgeCriterionScore {
  score: 0 | 1 | 2;
  citations: number[];
  rationale: string;
}

export interface AuthoredWorkbookEvalJudgeResult {
  criteria: Record<string, AuthoredWorkbookEvalJudgeCriterionScore>;
  summary: string;
}

export interface AuthoredWorkbookEvalVerdict {
  passed: boolean;
  percentage: number;
  rule: "all-criteria-positive-and-aggregate-at-least-80-percent";
}

export interface AuthoredWorkbookJudgeCommandRequest {
  prompt: string;
  model?: string;
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  spawnProcess?: AuthoredWorkbookJudgeSpawn;
}

export type AuthoredWorkbookJudgeSpawn = (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
export type AuthoredWorkbookJudgeCommandLabel = "configured-command";

type PromptCitation = AuthoredWorkbookEvalCitation & { value: unknown };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string") throw new Error(`Invalid ${label}.`);
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw new Error(`${label} exceeds the authored workbook eval length limit.`);
  return value;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const keys = Object.keys(value);
  if (keys.length !== allowed.length || keys.some((key) => !allowedSet.has(key))) throw new Error(`Invalid ${label}.`);
}

export function copyAuthoredWorkbookEvalScenarioPublicDescriptor(value: unknown): AuthoredWorkbookEvalScenarioPublicDescriptor {
  if (!isPlainRecord(value) || !Array.isArray(value.criteria)) throw new Error("Invalid authored workbook eval scenario descriptor.");
  const id = boundedString(value.id, "scenario id", 128);
  if (!SCENARIO_ID_PATTERN.test(id)) throw new Error("Invalid scenario id.");
  const criteria = value.criteria.map((criterion, index): AuthoredWorkbookEvalScenarioCriterion => {
    if (!isPlainRecord(criterion)) throw new Error(`Invalid scenario criterion at index ${index}.`);
    const criterionId = boundedString(criterion.id, "criterion id", 64);
    if (!CRITERION_ID_PATTERN.test(criterionId)) throw new Error(`Invalid scenario criterion id at index ${index}.`);
    return {
      id: criterionId,
      title: boundedString(criterion.title, "criterion title", MAX_SCENARIO_TEXT_BYTES),
      description: boundedString(criterion.description, "criterion description", MAX_SCENARIO_TEXT_BYTES)
    };
  });
  if (criteria.length === 0 || criteria.length > MAX_CRITERIA) throw new Error("Invalid scenario criteria count.");
  const seen = new Set<string>();
  for (const criterion of criteria) {
    if (seen.has(criterion.id)) throw new Error(`Duplicate scenario criterion id '${criterion.id}'.`);
    seen.add(criterion.id);
  }
  return {
    id,
    title: boundedString(value.title, "scenario title", MAX_SCENARIO_TEXT_BYTES),
    description: boundedString(value.description, "scenario description", MAX_SCENARIO_TEXT_BYTES),
    criteria
  };
}

export function projectAuthoredWorkbookGateForPublicReport(gate: AuthoredWorkbookEvalGateResult): AuthoredWorkbookEvalPublicGateResult {
  if (!isPlainRecord(gate) || typeof gate.passed !== "boolean" || !Array.isArray(gate.assertions)) throw new Error("Invalid deterministic gate result.");
  return {
    passed: gate.passed,
    assertionCount: gate.assertions.length,
    failureCount: gate.assertions.filter((assertion) => isPlainRecord(assertion) && assertion.passed === false).length,
    assertions: gate.assertions.map((assertion, index) => {
      if (!isPlainRecord(assertion) || typeof assertion.passed !== "boolean") throw new Error("Invalid deterministic gate result.");
      return { index, passed: assertion.passed };
    }),
    detailPolicy: "assertion-details-omitted-from-public-report"
  };
}

function valueForCitation(trace: AuthoredWorkbookEvalJudgeTrace, citation: AuthoredWorkbookEvalCitation): unknown {
  switch (citation.kind) {
    case "publicState": return trace.publicStates[citation.ref.index];
    case "terminalTranscript": return trace.terminalTranscript[citation.ref.index];
    case "reflection": return trace.reflections[citation.ref.index];
    case "editor": return trace.editors[citation.ref.index];
    case "progressionEvent": return trace.progressionEvents[citation.ref.index];
    case "artifact": return trace.artifacts[citation.ref.index];
  }
}

function citationsForPrompt(trace: AuthoredWorkbookEvalJudgeTrace): PromptCitation[] {
  return enumerateAuthoredWorkbookEvalJudgeCitations(trace).map((citation) => ({ ...citation, value: valueForCitation(trace, citation) }));
}

function resultShapeForScenario(scenario: AuthoredWorkbookEvalScenarioPublicDescriptor): Record<string, AuthoredWorkbookEvalJudgeCriterionScore> {
  const shape: Record<string, AuthoredWorkbookEvalJudgeCriterionScore> = {};
  for (const criterion of scenario.criteria) shape[criterion.id] = { score: 0, citations: [0], rationale: "..." };
  return shape;
}

export function buildAuthoredWorkbookJudgePrompt(scenarioInput: AuthoredWorkbookEvalScenarioPublicDescriptor, traceInput: AuthoredWorkbookEvalTrace, gateInput: AuthoredWorkbookEvalGateResult): string {
  const scenario = copyAuthoredWorkbookEvalScenarioPublicDescriptor(scenarioInput);
  const trace = projectAuthoredWorkbookEvalTraceForJudge(traceInput);
  const gate = projectAuthoredWorkbookGateForPublicReport(gateInput);
  const prompt = `You are a strict, stateless evaluator of one authored workbook tutoring session. Return JSON only. Use only the data in this prompt.

Scenario-public descriptor. This descriptor was rebuilt by scenario code and intentionally contains only id, title, description, and scenario-authored public criteria. It does not contain lesson specs, tutor frontmatter, private rubrics, prerequisite internals, private steering, credentials, config, or disposable paths:
${JSON.stringify(scenario, null, 2)}

Allowlisted Judge-specific structural public workbook trace. Complete browser-public workbook states are compacted here for Judge/report use only; deterministic gates retain their complete state snapshots outside this prompt:
${JSON.stringify(trace, null, 2)}

Trace citations. Each citation references one trace channel and includes the public value to inspect. Use citation ids in your result; do not invent ids:
${JSON.stringify(citationsForPrompt(trace), null, 2)}

Structural deterministic gate summary. Gate assertion details are local diagnostics and are omitted here:
${JSON.stringify(gate, null, 2)}

Score each exact scenario criterion from 0 to 2. Return exactly this JSON shape and no markdown:
${JSON.stringify({ criteria: resultShapeForScenario(scenario), summary: "..." }, null, 2)}
Every criterion key must be present exactly once with no extra criteria. Each citation must identify one trace citation id above. Rationale and summary must be concise and based only on public trace evidence.`;
  return prompt;
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Judge did not return JSON.");
  return JSON.parse(fenced.slice(start, end + 1));
}

function judgeCommandParts(environment: NodeJS.ProcessEnv): [string, ...string[]] {
  const configured = environment.EVAL_JUDGE_COMMAND?.trim();
  if (!configured) throw new Error("EVAL_JUDGE_COMMAND is required for an authored workbook eval judge call.");
  const [command, ...args] = configured.split(/\s+/);
  if (!command) throw new Error("EVAL_JUDGE_COMMAND is required for an authored workbook eval judge call.");
  return [command, ...args];
}

export async function invokeAuthoredWorkbookJudgeCommand(request: AuthoredWorkbookJudgeCommandRequest): Promise<unknown> {
  const environment = request.environment ?? process.env;
  const model = request.model ?? environment.EVAL_JUDGE_MODEL;
  if (!model?.trim()) throw new Error("EVAL_JUDGE_MODEL is required for an authored workbook eval judge call.");
  if (Buffer.byteLength(request.prompt, "utf8") > AUTHORED_WORKBOOK_JUDGE_PROMPT_MAX_BYTES) throw new Error(JUDGE_COMMAND_PROMPT_TOO_LARGE_MESSAGE);
  const [command, ...configuredArgs] = judgeCommandParts(environment);
  const spawnProcess = request.spawnProcess ?? spawn;
  const output = await new Promise<string>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnProcess(command, [...configuredArgs, "--model", model, "-p"], {
        env: { PATH: environment.PATH ?? "", HOME: environment.HOME ?? "", NO_COLOR: "1" },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true
      });
    } catch {
      reject(new Error(JUDGE_COMMAND_FAILURE_MESSAGE));
      return;
    }
    const timeoutMs = request.timeoutMs ?? AUTHORED_WORKBOOK_JUDGE_COMMAND_TIMEOUT_MS;
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
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      cleanupAbort();
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.stdin.removeAllListeners();
      child.removeAllListeners("error");
    };
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
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
      if (request.signal.aborted) {
        cancel(JUDGE_COMMAND_CANCELLED_MESSAGE);
        return;
      }
      const abortListener = () => cancel(JUDGE_COMMAND_CANCELLED_MESSAGE);
      request.signal.addEventListener("abort", abortListener, { once: true });
      cleanupAbort = () => request.signal?.removeEventListener("abort", abortListener);
    }
    timer = setTimeout(() => {
      timedOut = true;
      cancel(JUDGE_COMMAND_TIMEOUT_MESSAGE);
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.length;
      if (stdoutBytes > AUTHORED_WORKBOOK_JUDGE_STDOUT_MAX_BYTES) {
        stdoutChunks = [];
        cancel(JUDGE_COMMAND_OUTPUT_TOO_LARGE_MESSAGE);
        return;
      }
      stdoutChunks.push(buffer);
    });
    child.stdout.once("error", () => { if (!cancelling) settle(() => reject(new Error(JUDGE_COMMAND_FAILURE_MESSAGE))); });
    child.stderr.on("data", () => { /* stderr is intentionally discarded; it may contain secrets or paths. */ });
    child.stderr.once("error", () => { if (!cancelling) settle(() => reject(new Error(JUDGE_COMMAND_FAILURE_MESSAGE))); });
    child.once("error", () => { if (!cancelling) settle(() => reject(new Error(JUDGE_COMMAND_FAILURE_MESSAGE))); });
    child.once("close", (code) => {
      exited = true;
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
      if (timedOut || cancelling) return;
      settle(() => code === 0 ? resolve(Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8")) : reject(new Error(JUDGE_COMMAND_FAILURE_MESSAGE)));
    });
    child.stdin.once("error", () => { if (!cancelling) settle(() => reject(new Error(JUDGE_COMMAND_FAILURE_MESSAGE))); });
    try { child.stdin.end(request.prompt, "utf8", () => { /* successful stdin completion is not a result boundary. */ }); }
    catch { settle(() => reject(new Error(JUDGE_COMMAND_FAILURE_MESSAGE))); }
  });
  try { return extractJson(output); }
  catch { throw new Error(JUDGE_COMMAND_INVALID_JSON_MESSAGE); }
}

export async function judgeAuthoredWorkbookTraceFromPrompt(prompt: string, scenario: AuthoredWorkbookEvalScenarioPublicDescriptor, trace: AuthoredWorkbookEvalTrace): Promise<AuthoredWorkbookEvalJudgeResult> {
  const raw = await invokeAuthoredWorkbookJudgeCommand({ prompt });
  return verifyAuthoredWorkbookJudgeResult(raw, scenario, trace);
}

export async function judgeAuthoredWorkbookTrace(options: {
  scenario: AuthoredWorkbookEvalScenarioPublicDescriptor;
  trace: AuthoredWorkbookEvalTrace;
  gate: AuthoredWorkbookEvalGateResult;
  invokeFromPrompt?: (prompt: string, scenario: AuthoredWorkbookEvalScenarioPublicDescriptor, trace: AuthoredWorkbookEvalTrace) => Promise<AuthoredWorkbookEvalJudgeResult>;
}): Promise<AuthoredWorkbookEvalJudgeResult> {
  const scenario = copyAuthoredWorkbookEvalScenarioPublicDescriptor(options.scenario);
  const trace = copyAuthoredWorkbookEvalTrace(options.trace);
  const publicGate = projectAuthoredWorkbookGateForPublicReport(options.gate);
  if (!publicGate.passed) throw new Error("Deterministic gate failed before judge invocation.");
  const prompt = buildAuthoredWorkbookJudgePrompt(scenario, trace, options.gate);
  if (Buffer.byteLength(prompt, "utf8") > AUTHORED_WORKBOOK_JUDGE_PROMPT_MAX_BYTES) throw new Error(JUDGE_COMMAND_PROMPT_TOO_LARGE_MESSAGE);
  return (options.invokeFromPrompt ?? judgeAuthoredWorkbookTraceFromPrompt)(prompt, scenario, trace);
}

export function verifyAuthoredWorkbookJudgeResult(value: unknown, scenarioInput: AuthoredWorkbookEvalScenarioPublicDescriptor, traceInput: AuthoredWorkbookEvalTrace, options: { allowUncitedCriteria?: "deterministic-test" } = {}): AuthoredWorkbookEvalJudgeResult {
  const scenario = copyAuthoredWorkbookEvalScenarioPublicDescriptor(scenarioInput);
  const trace = projectAuthoredWorkbookEvalTraceForJudge(traceInput);
  if (!isPlainRecord(value)) throw new Error("Judge response is not an object.");
  assertExactKeys(value, ["criteria", "summary"], "judge response");
  if (!isPlainRecord(value.criteria)) throw new Error("Judge response has invalid criteria.");
  const expectedCriterionIds = scenario.criteria.map((criterion) => criterion.id);
  assertExactKeys(value.criteria, expectedCriterionIds, "judge criteria");
  const validCitationIds = new Set(enumerateAuthoredWorkbookEvalJudgeCitations(trace).map((citation) => citation.id));
  const criteria: Record<string, AuthoredWorkbookEvalJudgeCriterionScore> = {};
  for (const id of expectedCriterionIds) {
    const rawScore = value.criteria[id];
    if (!isPlainRecord(rawScore)) throw new Error(`Judge response is invalid for criterion ${id}.`);
    assertExactKeys(rawScore, ["score", "citations", "rationale"], `judge criterion ${id}`);
    if (rawScore.score !== 0 && rawScore.score !== 1 && rawScore.score !== 2) throw new Error(`Judge response is invalid for criterion ${id}.`);
    if (!Array.isArray(rawScore.citations) || !rawScore.citations.every((citation) => Number.isInteger(citation) && validCitationIds.has(citation))) throw new Error(`Judge cited an unknown trace citation for criterion ${id}.`);
    if (rawScore.citations.length === 0 && options.allowUncitedCriteria !== "deterministic-test") throw new Error(`Judge response is missing trace citations for criterion ${id}.`);
    const rationale = boundedString(rawScore.rationale, "judge rationale", MAX_JUDGE_RATIONALE_BYTES);
    criteria[id] = { score: rawScore.score, citations: [...rawScore.citations], rationale };
  }
  return { criteria, summary: boundedString(value.summary, "judge summary", MAX_JUDGE_SUMMARY_BYTES) };
}

export function authoredWorkbookJudgeVerdict(result: AuthoredWorkbookEvalJudgeResult): AuthoredWorkbookEvalVerdict {
  const scores = Object.values(result.criteria).map((criterion) => criterion.score);
  const total = scores.reduce<number>((sum, score) => sum + score, 0);
  const maximum = scores.length * 2;
  const percentage = maximum === 0 ? 0 : total / maximum;
  return { passed: scores.length > 0 && scores.every((score) => score > 0) && percentage >= 0.8, percentage, rule: "all-criteria-positive-and-aggregate-at-least-80-percent" };
}
