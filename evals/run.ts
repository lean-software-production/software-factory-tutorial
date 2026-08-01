#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { deterministicGate } from "./harness/assertions.js";
import { invokeJudge, judgePass, judgePrompt, loadActiveSpec, runJudgeCalibration, verifyJudgeResult } from "./harness/judge.js";
import { runPersonaSession } from "./harness/session.js";
import { shouldRetry } from "./harness/retry.js";
import { cleanupWorkspace, createWorkspace } from "./harness/workspace.js";
import { scenarios } from "./scenarios/lesson-001/scenarios.js";
import { lesson002Scenarios } from "./scenarios/lesson-002/scenarios.js";
import { lesson003Scenarios } from "./scenarios/lesson-003/scenarios.js";
import { lesson004Scenarios } from "./scenarios/lesson-004/scenarios.js";
import type { Scenario } from "./scenarios/lesson-001/scenarios.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reports = join(root, "evals/reports");
const allScenarios = [...scenarios, ...lesson002Scenarios, ...lesson003Scenarios, ...lesson004Scenarios];

function usage(): void {
  console.log(`Live tutorial evals (real model calls; not part of npm test)

Usage:
  npm run eval -- --scenario learner-led-happy-path
  npm run eval -- --lesson 002
  npm run eval -- --all --yes
  npm run eval -- --scenario learner-led-happy-path --repeat 3
  npm run eval -- --calibrate

A scope is required unless running judge calibration. EVAL_JUDGE_MODEL selects the judge model. The lesson-001 suite is about 120,000 model tokens and normally takes 10–30 minutes.`);
}

function selected(args: string[]): Scenario[] {
  const scenarioIndex = args.indexOf("--scenario"); const lessonIndex = args.indexOf("--lesson");
  if (args.includes("--all")) return allScenarios;
  if (scenarioIndex >= 0 && args[scenarioIndex + 1]) {
    const scenario = allScenarios.find((item) => item.id === args[scenarioIndex + 1]);
    if (!scenario) throw new Error(`Unknown scenario '${args[scenarioIndex + 1]}'.`);
    return [scenario];
  }
  if (lessonIndex >= 0 && args[lessonIndex + 1]) {
    const lesson = args[lessonIndex + 1].padStart(3, "0"); const result = allScenarios.filter((item) => item.lesson === lesson);
    if (!result.length) throw new Error(`No scenarios for lesson ${lesson}.`);
    return result;
  }
  return [];
}

async function runOnce(scenario: Scenario, repetition: number): Promise<{ passed: boolean; percentage?: number; directory: string; retry: string; error?: string }> {
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${scenario.id}-${repetition}`;
  const directory = join(reports, runId); await mkdir(directory, { recursive: true });
  const workspace = await createWorkspace(root, scenario.id);
  let keep = true;
  try {
    const trace = await runPersonaSession({ repositoryRoot: root, workspace, webRoot: join(root, "tutorial-engine/dist/web"), scenario, reportDirectory: directory });
    const gate = await deterministicGate(scenario, workspace, trace);
    const spec = await loadActiveSpec(workspace, scenario.lesson);
    const rawJudge = await invokeJudge(judgePrompt(scenario, spec, trace, gate));
    const judge = verifyJudgeResult(rawJudge, trace.events, scenario);
    const verdict = judgePass(judge);
    const passed = gate.passed && verdict.passed;
    await Promise.all([
      writeFile(join(directory, "gate.json"), JSON.stringify(gate, null, 2)),
      writeFile(join(directory, "judge.json"), JSON.stringify(judge, null, 2)),
      writeFile(join(directory, "transcript.md"), trace.events.map((event, index) => `### ${index} — ${event.type}\n\n\`\`\`json\n${JSON.stringify(event, null, 2)}\n\`\`\``).join("\n\n")),
      writeFile(join(directory, "summary.md"), `# ${scenario.id}\n\nDeterministic gate: **${gate.passed ? "pass" : "fail"}**\n\nJudge: **${Math.round(verdict.percentage * 100)}%** (${verdict.passed ? "pass" : "fail"})\n\n${judge.summary}\n`),
      writeFile(join(directory, "metadata.json"), JSON.stringify({ gitRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim(), node: process.version, tutorModel: process.env.PI_MODEL ?? "tutorial default", judgeModel: process.env.EVAL_JUDGE_MODEL, scenario: scenario.id, timestamps: { started: trace.startedAt, ended: trace.endedAt } }, null, 2))
    ]);
    keep = !passed;
    return { passed, percentage: verdict.percentage, directory, retry: "first-pass" };
  } catch (error) {
    await writeFile(join(directory, "failure.txt"), error instanceof Error ? error.stack ?? error.message : String(error));
    return { passed: false, directory, retry: shouldRetry(error) ? "infrastructure" : "non-retryable", error: error instanceof Error ? error.message : String(error) };
  } finally { await cleanupWorkspace(workspace, keep); }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help")) { usage(); return; }
  if (args.includes("--calibrate")) {
    if (!process.env.EVAL_JUDGE_MODEL) throw new Error("Set EVAL_JUDGE_MODEL before running judge calibration.");
    const results = await runJudgeCalibration(join(root, "evals/judge-calibration"));
    for (const result of results) console.log(`${result.file}: ${result.passed ? "PASS" : "FAIL"} (${Math.round(result.percentage * 100)}%)`);
    if (!results.every((result) => result.passed)) process.exitCode = 1;
    return;
  }
  const chosen = selected(args);
  if (!chosen.length) { usage(); process.exitCode = 1; return; }
  const repeatIndex = args.indexOf("--repeat"); const repeat = repeatIndex >= 0 ? Number(args[repeatIndex + 1]) : 1;
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 3) throw new Error("--repeat must be 1, 2, or 3.");
  if (!process.env.EVAL_JUDGE_MODEL) throw new Error("Set EVAL_JUDGE_MODEL before running paid live evals.");
  if (args.includes("--all") && !args.includes("--yes")) throw new Error(`--all can cost about ${allScenarios.length * 20_000} tokens. Re-run with --yes to confirm.`);
  console.log(`Selected: ${chosen.map((item) => item.id).join(", ")}\nTutor: ${process.env.PI_MODEL ?? "tutorial default"}\nJudge: ${process.env.EVAL_JUDGE_MODEL}\nEstimated budget: ${chosen.length * repeat * 20_000} model tokens.`);
  const results: Array<{ scenario: string; runs: Awaited<ReturnType<typeof runOnce>>[] }> = [];
  for (const scenario of chosen) {
    const runs = [];
    for (let attempt = 0; attempt < repeat; attempt++) {
      let result = await runOnce(scenario, attempt + 1);
      if (result.retry === "infrastructure") { const retried = await runOnce(scenario, attempt + 1); result = { ...retried, retry: retried.passed ? "pass-after-infrastructure-retry" : "infrastructure-retry-failed" }; }
      runs.push(result);
      console.log(`${scenario.id}: ${result.passed ? "PASS" : "FAIL"} (${result.retry}) — ${result.directory}`);
    }
    results.push({ scenario: scenario.id, runs });
  }
  const stable = results.every(({ runs }) => {
    const passing = runs.filter((run) => run.passed).length;
    const percentages = runs.map((run) => run.percentage ?? 0).sort((a, b) => a - b);
    return repeat === 1 ? passing === 1 : passing >= 2 && percentages[Math.floor(percentages.length / 2)] >= 0.8;
  });
  await mkdir(reports, { recursive: true }); await writeFile(join(reports, "latest.json"), JSON.stringify(results, null, 2));
  if (!stable) process.exitCode = 1;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
