import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { TutorialEvent } from "../../tutorial-engine/src/protocol/events.js";
import type { Scenario } from "../scenarios/lesson-001/scenarios.js";
import type { GateResult } from "./assertions.js";
import type { SessionTrace } from "./session.js";

export interface JudgeDimension { score: 0 | 1 | 2; citations: number[]; rationale: string; }
export interface JudgeResult { dimensions: Record<string, JudgeDimension>; summary: string; }

const dimensions = ["personaRespect", "accuracy", "stepSize", "mistakeDiagnosis", "guidance"] as const;

export function judgePrompt(scenario: Scenario, spec: string, trace: SessionTrace, gate: GateResult): string {
  const applicable = dimensions.filter((dimension) => scenario.mode === "mistake" || dimension !== "mistakeDiagnosis");
  const numbered = trace.events.map((event, index) => ({ id: index, event }));
  return `You are a strict, stateless evaluator of a live tutoring session. Return JSON only.\n\nScenario: ${scenario.description}\nExpected mistake: ${scenario.expectedMistake ?? "none"}\n\nActive specification:\n${spec}\n\nTranscript and audit events (event IDs are citation IDs):\n${JSON.stringify(numbered)}\n\nCanonical learner patch/message pairs (the tutor events precede each atomic patch; a correction checkpoint proves feedback and a new choice occurred before repair):\n${JSON.stringify(trace.patchPairs ?? [])}\n\nDeterministic gate:\n${JSON.stringify(gate)}\n\nScore these applicable dimensions ${JSON.stringify(applicable)} from 0 to 2: personaRespect, accuracy, stepSize, mistakeDiagnosis (mistakes only), guidance. 0 misses the requirement, 1 is partial, 2 fully meets it. Accuracy=2 requires the specification's stated implementation order. MistakeDiagnosis=2 identifies defect, consequence, and why correction matters. Guidance=2 is the smallest action consistent with learner control. Return exactly {"dimensions":{"personaRespect":{"score":0,"citations":[1],"rationale":"..."},...},"summary":"..."}. Every citation must identify an event above.`;
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  const start = fenced.indexOf("{"); const end = fenced.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Judge did not return JSON.");
  return JSON.parse(fenced.slice(start, end + 1));
}

export function verifyJudgeResult(value: unknown, events: TutorialEvent[], scenario: Scenario): JudgeResult {
  if (!value || typeof value !== "object") throw new Error("Judge response is not an object.");
  const candidate = value as { dimensions?: Record<string, JudgeDimension>; summary?: unknown };
  if (!candidate.dimensions || typeof candidate.summary !== "string") throw new Error("Judge response has no dimensions or summary.");
  const output: Record<string, JudgeDimension> = {};
  for (const dimension of dimensions) {
    if (dimension === "mistakeDiagnosis" && scenario.mode !== "mistake") continue;
    const score = candidate.dimensions[dimension];
    if (!score || ![0, 1, 2].includes(score.score) || !Array.isArray(score.citations) || typeof score.rationale !== "string") throw new Error(`Judge response is invalid for ${dimension}.`);
    if (!score.citations.every((id) => Number.isInteger(id) && id >= 0 && id < events.length)) throw new Error(`Judge cited an unknown event for ${dimension}.`);
    output[dimension] = score;
  }
  return { dimensions: output, summary: candidate.summary };
}

export function judgePass(result: JudgeResult): { passed: boolean; percentage: number } {
  const scores = Object.values(result.dimensions).map((dimension) => dimension.score);
  const total = scores.reduce<number>((sum, score) => sum + score, 0); const maximum = scores.length * 2;
  return { passed: scores.every((score) => score > 0) && total / maximum >= 0.8, percentage: maximum ? total / maximum : 0 };
}

export async function invokeJudge(prompt: string, model = process.env.EVAL_JUDGE_MODEL): Promise<unknown> {
  if (!model) throw new Error("EVAL_JUDGE_MODEL is required for a live eval judge call.");
  const [command, ...args] = (process.env.EVAL_JUDGE_COMMAND ?? "pi --no-session").split(/\s+/);
  if (!command) throw new Error("EVAL_JUDGE_COMMAND is empty.");
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(command, [...args, "--model", model, "-p"], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    let text = ""; let error = "";
    child.stdout.on("data", (chunk) => { text += String(chunk); }); child.stderr.on("data", (chunk) => { error += String(chunk); });
    child.once("error", reject); child.once("close", (code) => code === 0 ? resolve(text) : reject(new Error(`Judge command exited ${code}: ${error}`)));
    child.stdin.end(prompt);
  });
  return extractJson(output);
}

export interface CalibrationPacket {
  version: number;
  kind: "good" | "bad";
  expect: { minimumPercentage?: number; maximumPercentage?: number; allDimensionsAboveZero?: boolean; atLeastOneZero?: boolean };
  packet: { scenario: string; transcript: string };
}

export async function runJudgeCalibration(directory: string): Promise<Array<{ file: string; passed: boolean; percentage: number }>> {
  const files = (await readdir(directory)).filter((file) => file.endsWith(".json")).sort();
  const results = [];
  for (const file of files) {
    const packet = JSON.parse(await readFile(join(directory, file), "utf8")) as CalibrationPacket;
    const scenario: Scenario = { id: packet.packet.scenario, lesson: "001", mode: packet.packet.scenario.includes("mistake") ? "mistake" : "hands-on", description: "Calibration packet", patches: [] };
    const events: TutorialEvent[] = [{ type: "assistant-message", messageId: "calibration", markdown: packet.packet.transcript }];
    const trace = { events, messages: [], snapshots: {}, startedAt: "calibration", endedAt: "calibration" } as SessionTrace;
    const gate: GateResult = { passed: true, assertions: [] };
    const raw = await invokeJudge(judgePrompt(scenario, "Calibration packet; score only the supplied transcript.", trace, gate));
    const verdict = judgePass(verifyJudgeResult(raw, events, scenario));
    const scores = Object.values(verifyJudgeResult(raw, events, scenario).dimensions).map((dimension) => dimension.score);
    const passed = (packet.expect.minimumPercentage === undefined || verdict.percentage >= packet.expect.minimumPercentage)
      && (packet.expect.maximumPercentage === undefined || verdict.percentage <= packet.expect.maximumPercentage)
      && (!packet.expect.allDimensionsAboveZero || scores.every((score) => score > 0))
      && (!packet.expect.atLeastOneZero || scores.some((score) => score === 0));
    results.push({ file, passed, percentage: verdict.percentage });
  }
  return results;
}

export async function loadActiveSpec(workspace: string, lesson: string): Promise<string> {
  const ledger = await readFile(join(workspace, "docs/specs/README.md"), "utf8");
  const rows = ledger.split(/\r?\n/).filter((line) => line.trimStart().startsWith("|"));
  for (const row of rows) {
    const cells = row.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 3 || cells[0] === "Iteration" || cells[0].startsWith("---")) continue;
    if (cells[2] === "Done") continue;
    const link = cells[0]?.match(/\[([^\]]+)\]\(([^)]+)\)/);
    const id = link?.[1] ?? cells[0];
    const href = link?.[2];
    if (!href) throw new Error(`Active ledger row for lesson '${id}' has no specification link.`);
    if (id !== lesson) throw new Error(`Workspace active lesson is '${id}', not requested lesson '${lesson}'.`);
    return readFile(resolve(workspace, "docs/specs", href), "utf8");
  }
  throw new Error(`Active specification for lesson '${lesson}' was not found in docs/specs/README.md.`);
}
