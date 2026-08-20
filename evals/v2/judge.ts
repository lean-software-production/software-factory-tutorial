import { invokeJudge, judgePass, type JudgeDimension } from "../harness/judge.js";
import type { V2GateResult, V2Scenario } from "./scenarios.js";
import type { V2ArtifactSnapshot, V2SessionTrace } from "./types.js";

export interface V2JudgeResult {
  dimensions: Record<V2JudgeDimensionName, JudgeDimension>;
  summary: string;
}

export interface V2Report {
  scenario: Pick<V2Scenario, "id" | "title" | "description" | "criteria" | "actions">;
  modelIdentities: { tutor: string; judge: string };
  gate: V2GateResult;
  trace: V2SessionTrace;
  judge: V2JudgeResult;
  artifacts: V2ArtifactSnapshot[];
  verdict: { passed: boolean; percentage: number };
}

export type V2JudgeDimensionName = "protocolUse" | "tutorQuality" | "criteriaFit";

const dimensions: V2JudgeDimensionName[] = ["protocolUse", "tutorQuality", "criteriaFit"];

export function buildV2JudgePrompt(scenario: V2Scenario, trace: V2SessionTrace, gate: V2GateResult): string {
  const citations = enumerateTraceCitations(trace);
  return `You are a strict, stateless evaluator of one live v2 workbook tutoring session. Return JSON only.

Scenario:
${JSON.stringify({ id: scenario.id, title: scenario.title, description: scenario.description, criteria: scenario.criteria }, null, 2)}

Recorded public trace. Citation IDs are the id fields in this array. The trace contains only public workbook state, learner-visible terminal transcript, public reflection turns, workbook events, and artifact snapshots:
${JSON.stringify(citations, null, 2)}

Deterministic protocol gate:
${JSON.stringify(gate, null, 2)}

Score these dimensions from 0 to 2:
- protocolUse: the tutor/session followed the v2 workbook protocol and used recorded state instead of hidden information.
- tutorQuality: the tutor gave concise, accurate, learner-centered help for this scenario.
- criteriaFit: the session satisfies the scenario criteria above.

Return exactly {"dimensions":{"protocolUse":{"score":0,"citations":[0],"rationale":"..."},"tutorQuality":{"score":0,"citations":[0],"rationale":"..."},"criteriaFit":{"score":0,"citations":[0],"rationale":"..."}},"summary":"..."}. Every citation must identify one trace citation ID above.`;
}

export async function judgeV2Trace(scenario: V2Scenario, trace: V2SessionTrace, gate: V2GateResult): Promise<V2JudgeResult> {
  const raw = await invokeJudge(buildV2JudgePrompt(scenario, trace, gate));
  return verifyV2JudgeResult(raw, trace);
}

export function verifyV2JudgeResult(value: unknown, trace: V2SessionTrace): V2JudgeResult {
  if (!value || typeof value !== "object") throw new Error("Judge response is not an object.");
  const candidate = value as { dimensions?: Record<string, JudgeDimension>; summary?: unknown };
  if (!candidate.dimensions || typeof candidate.summary !== "string") throw new Error("Judge response has no dimensions or summary.");
  const maxCitation = enumerateTraceCitations(trace).length;
  const output = {} as Record<V2JudgeDimensionName, JudgeDimension>;
  for (const dimension of dimensions) {
    const score = candidate.dimensions[dimension];
    if (!score || ![0, 1, 2].includes(score.score) || !Array.isArray(score.citations) || typeof score.rationale !== "string") throw new Error(`Judge response is invalid for ${dimension}.`);
    if (!score.citations.every((id) => Number.isInteger(id) && id >= 0 && id < maxCitation)) throw new Error(`Judge cited an unknown trace citation for ${dimension}.`);
    output[dimension] = score;
  }
  return { dimensions: output, summary: candidate.summary };
}

export function v2JudgePass(result: V2JudgeResult): { passed: boolean; percentage: number } {
  return judgePass(result);
}

export function createV2Report(options: { scenario: V2Scenario; trace: V2SessionTrace; gate: V2GateResult; judge: V2JudgeResult; tutorModel: string; judgeModel: string }): V2Report {
  return {
    scenario: {
      id: options.scenario.id,
      title: options.scenario.title,
      description: options.scenario.description,
      criteria: options.scenario.criteria,
      actions: options.scenario.actions
    },
    modelIdentities: { tutor: options.tutorModel, judge: options.judgeModel },
    gate: options.gate,
    trace: options.trace,
    judge: options.judge,
    artifacts: options.trace.artifacts,
    verdict: v2JudgePass(options.judge)
  };
}

function enumerateTraceCitations(trace: V2SessionTrace): Array<{ id: number; kind: string; value: unknown }> {
  return [
    ...trace.publicStates.map((value) => ({ kind: "publicState", value })),
    ...trace.terminalTranscript.map((value) => ({ kind: "terminalTranscript", value })),
    ...trace.reflections.map((value) => ({ kind: "reflection", value })),
    ...trace.events.map((value) => ({ kind: "event", value })),
    ...trace.artifacts.map((value) => ({ kind: "artifact", value }))
  ].map((entry, id) => ({ id, ...entry }));
}
