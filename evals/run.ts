#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildV2JudgePrompt, createV2Report, judgeV2TraceFromPrompt, v2JudgePass } from "./v2/judge.js";
import { createEmptyV2SessionTrace } from "./v2/session.js";
import { deterministicV2Gate, runV2ScenarioSession, v2Scenarios, type V2Scenario } from "./v2/scenarios.js";
import { createEvaluationWorkspace } from "./v2/workspace.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reports = join(root, "evals/reports");

function usage(): void {
  console.log(`Live v2 workbook evals (real tutor and judge model calls; not part of npm test)

Usage:
  npm run eval -- --scenario v2-exact-command-success
  npm run eval -- --all --yes
  npm run eval -- --scenario v2-exact-command-success --repeat 3

A scope is required. EVAL_JUDGE_MODEL selects the judge model. TUTOR_MODEL optionally selects the tutor model used by the workbook tutor. Reports are written under evals/reports/.`);
}

export function selectV2Scenarios(args: string[]): V2Scenario[] {
  const scenarioIndex = args.indexOf("--scenario");
  if (args.includes("--all")) return v2Scenarios;
  if (scenarioIndex >= 0 && args[scenarioIndex + 1]) {
    const id = args[scenarioIndex + 1]!;
    const scenario = v2Scenarios.find((item) => item.id === id);
    if (!scenario) throw new Error(`Unknown v2 scenario '${id}'.`);
    return [scenario];
  }
  return [];
}

async function runOnce(scenario: V2Scenario, repetition: number): Promise<{ passed: boolean; percentage?: number; directory: string; error?: string }> {
  const started = new Date().toISOString();
  const runId = `${started.replace(/[:.]/g, "-")}-${scenario.id}-${repetition}`;
  const directory = join(reports, runId);
  await mkdir(directory, { recursive: true });
  const workspace = await createEvaluationWorkspace();
  const trace = createEmptyV2SessionTrace(scenario.id);
  let server: Awaited<ReturnType<typeof workspace.startServer>> | undefined;
  try {
    server = await workspace.startServer();
    await runV2ScenarioSession({ scenario, workspace, serverUrl: server.url, trace });
    const gate = deterministicV2Gate(scenario, trace);
    await Promise.all([
      writeFile(join(directory, "trace.json"), JSON.stringify(trace, null, 2)),
      writeFile(join(directory, "gate.json"), JSON.stringify(gate, null, 2)),
      writeFile(join(directory, "artifacts.json"), JSON.stringify(trace.artifacts, null, 2))
    ]);
    if (!gate.passed) {
      const failures = gate.assertions.filter((assertion) => !assertion.passed).map((assertion) => `${assertion.name}: ${assertion.detail}`).join("\n");
      await writeFile(join(directory, "failure.txt"), `Deterministic gate failed before judge invocation.\n${failures}\n`);
      return { passed: false, directory, error: "deterministic gate failed" };
    }

    const judgeInput = buildV2JudgePrompt(scenario, trace, gate);
    await writeFile(join(directory, "judge-input.txt"), judgeInput);
    const judge = await judgeV2TraceFromPrompt(judgeInput, trace);
    const verdict = v2JudgePass(judge);
    const report = createV2Report({
      scenario,
      trace,
      gate,
      judgeInput,
      judge,
      tutorModel: process.env.TUTOR_MODEL ?? "tutorial default",
      judgeModel: process.env.EVAL_JUDGE_MODEL ?? "unset"
    });
    const ended = new Date().toISOString();
    await Promise.all([
      writeFile(join(directory, "judge.json"), JSON.stringify(judge, null, 2)),
      writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2)),
      writeFile(join(directory, "summary.md"), `# ${scenario.id}\n\nDeterministic gate: **pass**\n\nJudge: **${Math.round(verdict.percentage * 100)}%** (${verdict.passed ? "pass" : "fail"})\n\n${judge.summary}\n`),
      writeFile(join(directory, "metadata.json"), JSON.stringify({
        gitRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim(),
        node: process.version,
        modelIdentities: report.modelIdentities,
        judgeInputFile: "judge-input.txt",
        scenario: scenario.id,
        timestamps: { started, ended },
        workspaceRoot: workspace.root
      }, null, 2))
    ]);
    return { passed: gate.passed && verdict.passed, percentage: verdict.percentage, directory };
  } catch (error) {
    await writeFile(join(directory, "failure.txt"), error instanceof Error ? error.stack ?? error.message : String(error));
    return { passed: false, directory, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (server) await server.close();
    await workspace.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help")) { usage(); return; }
  const chosen = selectV2Scenarios(args);
  if (!chosen.length) { usage(); process.exitCode = 1; return; }
  const repeatIndex = args.indexOf("--repeat");
  const repeat = repeatIndex >= 0 ? Number(args[repeatIndex + 1]) : 1;
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 3) throw new Error("--repeat must be 1, 2, or 3.");
  if (!process.env.EVAL_JUDGE_MODEL) throw new Error("Set EVAL_JUDGE_MODEL before running paid live evals.");
  if (args.includes("--all") && !args.includes("--yes")) throw new Error(`--all can spend model tokens across ${v2Scenarios.length} live scenarios. Re-run with --yes to confirm.`);

  await mkdir(reports, { recursive: true });
  console.log(`Selected: ${chosen.map((item) => item.id).join(", ")}\nTutor: ${process.env.TUTOR_MODEL ?? "tutorial default"}\nJudge: ${process.env.EVAL_JUDGE_MODEL}`);
  const results: Array<{ scenario: string; runs: Awaited<ReturnType<typeof runOnce>>[] }> = [];
  for (const scenario of chosen) {
    const runs = [];
    for (let attempt = 0; attempt < repeat; attempt++) {
      const result = await runOnce(scenario, attempt + 1);
      runs.push(result);
      console.log(`${scenario.id}: ${result.passed ? "PASS" : "FAIL"} — ${result.directory}`);
    }
    results.push({ scenario: scenario.id, runs });
  }
  await writeFile(join(reports, "latest.json"), JSON.stringify(results, null, 2));
  const stable = results.every(({ runs }) => repeat === 1 ? runs[0]?.passed === true : runs.filter((run) => run.passed).length >= 2);
  if (!stable) process.exitCode = 1;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
