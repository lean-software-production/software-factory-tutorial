import { execFile, spawn } from "node:child_process";
import { cp, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { TutorDecision } from "../../../tutorial-engine/src/workbook/tutor.js";
import { RecordingMainTutor, RecordingPracticeCoach, type ReviewInput } from "../../../tutorial-engine/test/support/fake-tutors.js";
import {
  AUTHORED_COMMAND_STUB_NAMESPACE,
  AUTHORED_COMMAND_STUB_OWNER,
  AUTHORED_COMMAND_STUB_SCHEMA_VERSION,
  AUTHORED_STUB_RPC_EARLY_STEER_WINDOW_MS,
  createAuthoredCommandStubs,
  readAuthoredCommandStubEvidence,
  type AuthoredCommandInvocationEvidence,
  type AuthoredEventClass
} from "../command-stubs.js";
import type { AuthoredWorkbookEvalArtifactSnapshot, AuthoredWorkbookEvalSessionTrace, AuthoredWorkbookEvalTrace } from "../types.js";
import {
  AUTHORED_WORKBOOK_GATE_CHECKPOINT_LABELS,
  AUTHORED_WORKBOOK_PREREQUISITE_SEED_FILES,
  AUTHORED_WORKBOOK_SCENARIOS,
  authoredWorkbookScenarioById,
  createAuthoredWorkbookScenarioGateCheckpointRecorder,
  type AuthoredWorkbookScenarioDescriptor,
  type AuthoredWorkbookScenarioGateInput,
  type AuthoredWorkbookScenarioId
} from "../scenarios.js";
import { AuthoredWorkbookDriver } from "../driver.js";
import { readAuthoredWorkbookTimeline } from "../internal-timeline.js";
import { createEmptyAuthoredWorkbookEvalSessionTrace, projectAuthoredWorkbookEvalTrace } from "../public-trace.js";
import { dockerContainerUser, type TerminalPty, type TerminalPtyOptions } from "../../../tutorial-engine/src/workbook/terminal.js";
import { buildAuthoredWorkbookJudgePrompt, copyAuthoredWorkbookEvalScenarioPublicDescriptor } from "../judge.js";
import { createAuthoredWorkbookScenarioGateEvidenceCollector } from "../gate-evidence.js";
import { createAuthoredCurriculumSliceWorkspace } from "../workspace.js";
import { buildBoundedWorkspaceTar, dockerPopulateVolumeArguments, dockerVolumeCreateArguments, dockerVolumeRemoveArguments, dockerWorkspaceVolumeMount, WORKBOOK_TERMINAL_IMAGE } from "../preflight.js";
import type { AuthoredCurriculumSliceSessionCapability } from "../workspace.js";
const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];
const realPrerequisitesRoot = resolve(import.meta.dirname, "../prerequisites");
const lesson013RpcEventClasses: AuthoredEventClass[] = ["response", "queue_update", "tool_execution_start", "message_update", "message_end", "agent_end"];

class PrimerWorkflowFakeTutor extends RecordingMainTutor {
  protected override defaultReply = "Public fake tutor reply.";
  protected override blockSummaryFor = (blockId: string): string => `Public summary for ${blockId}.`;
  protected override lessonSummaryFor = (lessonId: string): string => `Public lesson summary for ${lessonId}.`;

  protected override async decide(input: ReviewInput): Promise<TutorDecision> {
    const response = input.attempt.evidence.kind === "reflection" ? input.attempt.evidence.response : "";
    return /more trust\/faith in the LLM/i.test(response)
      ? { outcome: "feedback", message: "The validation loop exists because you do not trust the model unchecked." }
      : { outcome: "accepted", message: "Accepted by deterministic fake tutor." };
  }
}

class Lessons003004WorkflowFakeTutor extends RecordingMainTutor {
  protected override defaultReply = "Public fake tutor reply.";
  protected override blockSummaryFor = (blockId: string): string => `Public summary for ${blockId}.`;
  protected override lessonSummaryFor = (lessonId: string): string => `Public lesson summary for ${lessonId}.`;

  protected override async decide(input: ReviewInput): Promise<TutorDecision> {
    if (input.attempt.evidence.kind === "reflection") return { outcome: "accepted", message: "Accepted reflection." };
    const command = terminalAttemptCommand(input) ?? "";
    if (/cat refactor-validate\.md\s*\\\s*\|/.test(command) && !command.includes("refactor-quality-before.txt")) {
      return { outcome: "feedback", message: "Carry the recorded quality baseline into the validator and tee findings for the next lesson." };
    }
    if (command.endsWith(lesson004WrongCommand) && !command.includes("cat > factory/refactor-validate.sh")) {
      return { outcome: "feedback", message: "Do not rerun only the validator; append findings to the doer context while preserving the baseline." };
    }
    if (command.endsWith(lesson004MultiplyCommand)) {
      return { outcome: "feedback", message: "Multiply has been repaired, but the divide branch still needs feedback before this can pass." };
    }
    return { outcome: "accepted", message: "Accepted by deterministic fake tutor." };
  }
}

class HostBashTerminalPty implements TerminalPty {
  #data?: (data: string) => void;
  #exit?: (event: { exitCode: number; signal?: number }) => void;
  #queue: Promise<void> = Promise.resolve();
  #killed = false;

  constructor(private readonly options: TerminalPtyOptions, private readonly env: NodeJS.ProcessEnv) {}

  open(): void {}
  resize(): void {}
  onData(callback: (data: string) => void): void { this.#data = callback; }
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): void { this.#exit = callback; }
  kill(): void { this.#killed = true; }

  write(data: string): void {
    const command = data.replace(/[\r\n]+$/, "");
    this.#data?.(`${bashCommandMarker(command)}\r\n`);
    this.#queue = this.#queue.then(async () => {
      if (this.#killed) return;
      const normalizedCommand = command.replace(/\r/g, "\n");
      const path = this.env.STUBBED_PATH ?? this.env.PATH ?? "";
      try {
        const { stdout, stderr } = await execFileAsync("/bin/bash", ["-lc", `export PATH=${shellQuote(path)}; ${normalizedCommand}`], {
          cwd: this.options.cwd,
          env: this.env,
          timeout: 60_000,
          encoding: "utf8",
          maxBuffer: 1024 * 1024
        });
        this.#data?.(`${stdout}${stderr}${bashFinishedMarker(0)}`);
      } catch (error) {
        const failed = error as { stdout?: string; stderr?: string; code?: unknown };
        this.#data?.(`${failed.stdout ?? ""}${failed.stderr ?? ""}${bashFinishedMarker(typeof failed.code === "number" ? failed.code : 1)}`);
      }
    }).catch(() => this.#exit?.({ exitCode: 1 }));
  }
}

function terminalAttemptCommand(input: ReviewInput): string | undefined {
  if (input.attempt.evidence.kind !== "terminal") return undefined;
  try {
    const parsed = JSON.parse(input.attempt.evidence.transcript) as { command?: unknown };
    return typeof parsed.command === "string" ? parsed.command.replace(/[\r\n]+$/, "") : undefined;
  } catch {
    return undefined;
  }
}

function bashCommandMarker(command: string): string {
  return `\x1b]633;workbook-command;${Buffer.from(command).toString("base64")}\x07`;
}

function bashFinishedMarker(exitStatus = 0): string {
  return `\x1b]633;workbook-finished;${exitStatus}\x07`;
}

const lesson001SimpleCommand = `pi -p "What is the capital of France?"`;
const lesson001SuppliedCommand = `echo "Describe what this calculator does, in three sentences." \\\n  | (cd calculator && pi --no-session --tools read,grep,find,ls -p)`;
const lesson001ChangedJobCommand = `echo "What files make up this calculator, and what does each one appear to do?" \\\n  | (cd calculator && pi --no-session --tools read,grep,find,ls -p)`;

const lesson004WrongCommand = `./factory/refactor-validate.sh`;
const lesson004CurrentEvidenceAndValidationCommand = String.raw`{
  echo "=== QUALITY BEFORE (recorded before the doer ran) ==="
  cat factory/.tmp/refactor-quality-before.txt
  echo
  echo "=== QUALITY NOW ==="
  if grep -q 'const readFirstOperand = (separator: "and" | "from" | "by"): number =>' calculator/src/index.ts \
    && [ "$(grep -c 'const first = readFirstOperand("by");' calculator/src/index.ts)" -eq 2 ] \
    && ! grep -q 'if (pieces\[place++\] !== "by") fail();' calculator/src/index.ts; then
    echo "All quality checks passed."
  else
    (cd calculator && node scripts/quality.mjs) || true
  fi
  echo
  echo "=== TESTS ==="
  (cd calculator && npm test 2>&1) || true
  echo
  echo "=== WORKING DIFF ==="
  git diff -- calculator/src/index.ts
} > factory/.tmp/refactor-current-evidence.txt
cat factory/refactor-validate.md factory/.tmp/refactor-current-evidence.txt \
  | (cd calculator && pi --no-session --tools read,grep,find,ls,bash -p) \
  | tee factory/.tmp/refactor-validate-findings.txt
rm factory/.tmp/refactor-current-evidence.txt`;
const lesson004MultiplyCommand = String.raw`node <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const path = 'calculator/src/index.ts';
let source = readFileSync(path, 'utf8');
source = source.replace(
  '    if (word === "multiply") {\n      const first = read();\n      if (pieces[place++] !== "by") fail();\n      const second = read();\n      return first * second;\n    }',
  '    if (word === "multiply") {\n      const first = readFirstOperand("by");\n      const second = read();\n      return first * second;\n    }'
);
writeFileSync(path, source);
NODE
${lesson004CurrentEvidenceAndValidationCommand}
printf '%s\n' 'MULTIPLY-ONLY TURN: current validator findings follow; divide remains for feedback.'; cat factory/.tmp/refactor-validate-findings.txt`;
const lesson004DivideCommand = String.raw`(cd factory \
  && cat refactor.md .tmp/refactor-validate-findings.txt \
  | (cd ../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p))
${lesson004CurrentEvidenceAndValidationCommand}
printf '%s\n' 'FEEDBACK TURN COMPLETED: prior validator findings were appended to the doer context; current findings follow.'; cat factory/.tmp/refactor-validate-findings.txt`;

const completedSource = `type Output = (line: string) => void;

const NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

/**
 * Evaluate the kata's tiny spoken-expression language.
 *
 * This is intentionally a single, inconvenient starting point for the kata:
 * it tokenises, parses, performs arithmetic, formats results, and knows about
 * command-line output. The behaviour is covered; the structure is not a model
 * to emulate.
 */
export function evaluateSpokenExpression(source: string): number {
  const pieces = source
    .toLowerCase()
    .replace(/\\(/g, " ( ")
    .replace(/\\)/g, " ) ")
    .trim()
    .split(/\\s+/)
    .filter(Boolean);
  let place = 0;

  const fail = (): never => {
    // Deliberately unhelpful starter error: a later kata step improves this.
    throw new Error("Could not work that out.");
  };

  const read = (): number => {
    const word = pieces[place++];
    if (!word) fail();

    if (word === "(") {
      const inside = read();
      if (pieces[place++] !== ")") fail();
      return inside;
    }

    if (/^\\d+$/.test(word)) return Number(word);

    const numberWord = NUMBER_WORDS[word];
    if (numberWord !== undefined) return numberWord;

    const readFirstOperand = (separator: "and" | "from" | "by"): number => {
      const first = read();
      if (pieces[place++] !== separator) fail();
      return first;
    };

    // Operators are prefix forms. Each branch repeats the same parser work on
    // purpose, leaving several safe seams for the refactoring lesson.
    if (word === "add") {
      const first = readFirstOperand("and");
      const second = read();
      return first + second;
    }

    if (word === "subtract") {
      const first = readFirstOperand("from");
      const second = read();
      return second - first;
    }

    if (word === "multiply") {
      const first = readFirstOperand("by");
      const second = read();
      return first * second;
    }

    if (word === "divide") {
      const first = readFirstOperand("by");
      const second = read();
      if (second === 0) fail();
      return first / second;
    }

    return fail();
  };

  const answer = read();
  if (place !== pieces.length) fail();
  return answer;
}

export function formatAnswer(answer: number): string {
  return \`Result: \${answer}\`;
}

/** Run the command-line behaviour without making tests replace process.exit. */
export function runCli(args: string[], write: Output, writeError: Output): number {
  if (args.length === 0) {
    writeError("Give me a spoken expression to calculate.");
    return 1;
  }

  try {
    write(formatAnswer(evaluateSpokenExpression(args.join(" "))));
    return 0;
  } catch {
    writeError("Unable to calculate that expression.");
    return 1;
  }
}
`;

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

describe("authored workbook scenario descriptors", () => {
  it("declares the four release journeys with budget source-of-truth model-call counts", () => {
    expect(AUTHORED_WORKBOOK_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      "primer-validation-misconception",
      "lesson-001-headless-boundary",
      "lessons-003-004-evidence-feedback",
      "lesson-013-operator-judgement"
    ]);

    for (const scenario of AUTHORED_WORKBOOK_SCENARIOS) {
      expect(scenario.criteria.length).toBeGreaterThan(0);
      expect(scenario.expectedModelCalls).toEqual({
        mainTutor: expect.any(Number),
        practiceCoach: expect.any(Number),
        judge: expect.any(Number),
        total: expect.any(Number)
      });
      expect(Object.keys(scenario.expectedModelCalls).sort()).toEqual(["judge", "mainTutor", "practiceCoach", "total"]);
      expect(Object.isFrozen(scenario)).toBe(true);
      expect(Object.isFrozen(scenario.selection.parts)).toBe(true);
      expect(Object.isFrozen(scenario.artifactAllowlist)).toBe(true);
      if (scenario.runnerPrivate) {
        expect(Object.isFrozen(scenario.runnerPrivate)).toBe(true);
        expect(Object.isFrozen(scenario.runnerPrivate.gateEvidence.workspaceFiles)).toBe(true);
        expect(Object.isFrozen(scenario.runnerPrivate.gateEvidence.workspacePathPrefixes)).toBe(true);
        expect(Object.isFrozen(scenario.runnerPrivate.mutationAllowlist.learnerWorkspaceFiles)).toBe(true);
        expect(Object.isFrozen(scenario.runnerPrivate.mutationAllowlist.learnerWorkspacePathPrefixes)).toBe(true);
      }
      if (scenario.gateCheckpoints) expect(Object.isFrozen(scenario.gateCheckpoints)).toBe(true);
      if (scenario.prerequisiteOverlay) {
        expect(Object.isFrozen(scenario.prerequisiteOverlay)).toBe(true);
        expect(Object.isFrozen(scenario.prerequisiteOverlay.files)).toBe(true);
      }
      expect(Object.isFrozen(scenario.criteria)).toBe(true);
      expect(Object.isFrozen(scenario.expectedModelCalls)).toBe(true);
      expect(Object.isFrozen(scenario.expectedModelCallDerivation)).toBe(true);
      expect(scenario.expectedModelCallDerivation.join("\n")).toMatch(/Main Tutor upper bound|Practice Coach upper bound|Judge/);
      expect(scenario.expectedModelCalls.judge).toBe(1);
      expect(scenario.expectedModelCalls.total).toBe(scenario.expectedModelCalls.mainTutor + scenario.expectedModelCalls.practiceCoach + scenario.expectedModelCalls.judge);
      expect(scenario.expectedModelCalls.total).toBeGreaterThan(1);
      if (scenario.id === "primer-validation-misconception") expect(scenario.expectedModelCalls.mainTutor).toBeGreaterThan(0);
      if (scenario.id === "lesson-001-headless-boundary") expect(scenario.expectedModelCalls.practiceCoach).toBeGreaterThan(0);
      if (scenario.id === "lessons-003-004-evidence-feedback") {
        expect(scenario.expectedModelCalls.mainTutor).toBeGreaterThan(0);
        expect(scenario.expectedModelCalls.practiceCoach).toBeGreaterThan(0);
      }
      if (scenario.id === "lesson-013-operator-judgement") {
        expect(scenario.expectedModelCalls.mainTutor).toBeGreaterThan(0);
        expect(scenario.expectedModelCalls.practiceCoach).toBeGreaterThan(0);
      }
    }

    expect(authoredWorkbookScenarioById("lesson-001-headless-boundary").stubLessonNumber).toBeUndefined();
    expect(authoredWorkbookScenarioById("lessons-003-004-evidence-feedback").stubLessonNumber).toBe(4);
    expect(authoredWorkbookScenarioById("lessons-003-004-evidence-feedback").prerequisiteOverlay).toMatchObject({ id: "lesson-003-prerequisites", workspaceId: "refactor-line" });
    expect(authoredWorkbookScenarioById("lesson-013-operator-judgement").stubLessonNumber).toBe(13);
    expect(authoredWorkbookScenarioById("lesson-013-operator-judgement").prerequisiteOverlay).toMatchObject({ id: "completed-factory-lesson-013", workspaceId: "refactor-line" });
  });

  it("scopes the validator verdict requirement to captured findings rather than terminal progress", async () => {
    const guidance = await readFile(resolve(import.meta.dirname, "../../../tutorial/lessons/003-build-a-validator/blocks/implementation-order.md"), "utf8");

    expect(guidance).toContain("The response file's first non-empty line must be exactly");
    expect(guidance).toContain("the terminal may print Starting validation... before it");
    expect(guidance).toMatch(/The\s+terminal announces `Starting validation\.\.\.` before Pi runs/);
    expect(guidance).toMatch(/that file's first non-empty line is\s+the `VERDICT`/);
  });

  it("declares model-call upper bounds above the computed authored drive path", async () => {
    for (const scenario of AUTHORED_WORKBOOK_SCENARIOS) {
      const recorder = new RecordingDriver();
      await scenario.drive({ driver: recorder });
      const calls = recorder.calls.map((call) => call.method);
      const terminalReviews = calls.filter((method) => method === "submitTerminalCommand").length;
      const reflectionReviews = calls.filter((method) => method === "submitReflection" || method === "submitReflectionFollowUp").length;
      const evaluatedBlocks = calls.filter((method) => method === "submitTerminalCommand" || method === "completeReflection" || method === "continueBlock").length;
      const lessonAndWorkbookSummaries = scenario.selection.parts.reduce((sum, part) => sum + part.lessons.length, 0) + 1;
      const computedMainTutorPath = terminalReviews + reflectionReviews + evaluatedBlocks + lessonAndWorkbookSummaries;
      expect(scenario.expectedModelCalls.mainTutor, scenario.id).toBeGreaterThanOrEqual(computedMainTutorPath);
      expect(scenario.expectedModelCalls.judge, scenario.id).toBe(1);
      if (terminalReviews > 0) expect(scenario.expectedModelCalls.practiceCoach, scenario.id).toBeGreaterThan(0);
      else expect(scenario.expectedModelCalls.practiceCoach, scenario.id).toBe(0);
    }
    expect(authoredWorkbookScenarioById("primer-validation-misconception").expectedModelCalls.mainTutor).toBeGreaterThanOrEqual(11);
    expect(authoredWorkbookScenarioById("lesson-001-headless-boundary").expectedModelCalls.mainTutor).toBeGreaterThanOrEqual(10);
  });

  it("drives scenarios through the public driver surface and preserves authored command lines", async () => {
    const recorder = new RecordingDriver();
    await authoredWorkbookScenarioById("lesson-001-headless-boundary").drive({ driver: recorder });

    expect(recorder.calls.filter((call) => call.method === "submitTerminalCommand").map((call) => call.command)).toEqual([
      lesson001SimpleCommand,
      lesson001SuppliedCommand,
      lesson001ChangedJobCommand
    ]);

    const stubbed = new RecordingDriver();
    await authoredWorkbookScenarioById("lessons-003-004-evidence-feedback").drive({ driver: stubbed });
    const commands = stubbed.calls.filter((call) => call.method === "submitTerminalCommand").map((call) => call.command ?? "");
    expect(commands[1]).not.toContain("sed -n '1,120p' factory/refactor-validate.sh");
    expect(commands[1]).toContain("./factory/refactor-validate.sh\ncat factory/.tmp/refactor-validate-findings.txt; printf");
    expect(commands[1]).toContain("grep -nF 'if [ ! -f .tmp/refactor-quality-before.txt ]; then' factory/refactor-validate.sh");
    expect(commands[1]).toContain("grep -oF -- '--tools read,grep,find,ls,bash -p' factory/refactor-validate.sh");
    expect(commands.some((command) => command.endsWith(lesson004WrongCommand))).toBe(true);
    expect(commands.some((command) => command.endsWith(lesson004MultiplyCommand))).toBe(true);
    expect(commands.some((command) => command.endsWith(lesson004DivideCommand))).toBe(true);
    expect(commands.every((command) => !command.startsWith("export PATH=") && !command.includes("AUTHORED_EVAL_COMMAND_STUB_CONFIG"))).toBe(true);

    const capstone = new RecordingDriver();
    await authoredWorkbookScenarioById("lesson-013-operator-judgement").drive({ driver: capstone });
    expect(capstone.calls.filter((call) => call.method === "submitReflectionFollowUp")).toHaveLength(0);
    const capstoneReflection = capstone.calls.find((call) => call.method === "submitReflection")?.response ?? "";
    for (const term of ["factory/refactor/", "refactor.md", "validate.md", "repair.md", "commit.md", "success.md", "start the doer", "hand/carry inputs", "branch on the validator VERDICT", "run repair", "stop when PASS", "most expensive unattended action", "event record"]) expect(capstoneReflection).toContain(term);
    const capstoneCommand = capstone.calls.find((call) => call.method === "submitTerminalCommand")?.command ?? "";
    expect(capstoneCommand).toContain("./factory/refactor/run.sh > .tmp/refactor-run.log 2>&1 &");
    expect(capstoneCommand).toContain("./factory/watch.sh refactor > .tmp/refactor-watch.log 2>&1 &");
    expect(capstoneCommand).toContain("tail -n 80 .tmp/refactor-run.log");
    expect(capstoneCommand).toContain("tail -n 80 .tmp/refactor-watch.log");
    expect(capstoneCommand).toContain("./factory/ask.sh refactor \"What happened in this run?\"");
    expect(capstoneCommand).not.toMatch(/ask\.sh refactor \"What happened in this run\?\"\s*>/);
    expect(capstoneCommand).toContain("./factory/steer.sh refactor \"Finish multiply and divide independently before validation.\"");
  });

  it("repairs legitimate Lesson 013 reflection feedback before completing the checkpoint", async () => {
    const scenario = authoredWorkbookScenarioById("lesson-013-operator-judgement");
    expect(scenario.expectedModelCalls.mainTutor).toBe(14);
    const driver = new Lesson013ReflectionFeedbackDriver();
    await scenario.drive({ driver });
    const reflectionCalls = driver.calls.filter((call) => ["submitReflection", "submitReflectionFollowUp", "completeReflection"].includes(call.method));
    expect(reflectionCalls.map((call) => call.method)).toEqual(["submitReflection", "submitReflectionFollowUp", "completeReflection"]);
    expect(reflectionCalls[1]!.response).toEqual(expect.stringContaining("factory/refactor/"));
    expect(reflectionCalls[1]!.response).toEqual(expect.stringContaining("five jobs"));
    expect(reflectionCalls[1]!.response).toEqual(expect.stringContaining("costly unattended action"));
  });

  it("captures runner-private gate checkpoints in authored order with an optional no-op default", async () => {
    const scenario = authoredWorkbookScenarioById("lessons-003-004-evidence-feedback");
    expect(AUTHORED_WORKBOOK_GATE_CHECKPOINT_LABELS).toEqual(["lessons003004:after-multiply-only"]);
    expect(Object.isFrozen(AUTHORED_WORKBOOK_GATE_CHECKPOINT_LABELS)).toBe(true);

    const noOpRecorder = new RecordingDriver();
    await scenario.drive({ driver: noOpRecorder });

    const checkpointRecorder = createAuthoredWorkbookScenarioGateCheckpointRecorder(scenario);
    const recorder = new RecordingDriver();
    const checkpointCallCounts: number[] = [];
    await scenario.drive({
      driver: recorder,
      captureGateCheckpoint: (label) => { checkpointRecorder.captureGateCheckpoint(label); checkpointCallCounts.push(recorder.calls.length); }
    });
    expect(checkpointRecorder.labels).toEqual(["lessons003004:after-multiply-only"]);
    const multiplyCall = recorder.calls.findIndex((call) => call.command?.endsWith(lesson004MultiplyCommand));
    const divideCall = recorder.calls.findIndex((call) => call.command?.endsWith(lesson004DivideCommand));
    expect(checkpointCallCounts).toEqual([multiplyCall + 1]);
    expect(divideCall).toBe(multiplyCall + 1);
    expect(() => checkpointRecorder.captureGateCheckpoint("lessons003004:after-multiply-only")).toThrow(/duplicate gate checkpoint/);
    const primerRecorder = createAuthoredWorkbookScenarioGateCheckpointRecorder(authoredWorkbookScenarioById("primer-validation-misconception"));
    expect(() => primerRecorder.captureGateCheckpoint("lessons003004:after-multiply-only")).toThrow(/does not declare gate checkpoint/);
    expect(() => createAuthoredWorkbookScenarioGateCheckpointRecorder({ id: "lessons-003-004-evidence-feedback", gateCheckpoints: ["unknown" as any] })).toThrow(/Unknown authored workbook gate checkpoint label/);
  });

  it("keeps runner-private evidence declarations frozen, path-safe, and out of public Judge descriptors", () => {
    const lesson013 = authoredWorkbookScenarioById("lesson-013-operator-judgement");
    expect(lesson013.runnerPrivate?.gateEvidence.workspaceFiles).toEqual(["factory/.tmp/authored-eval-command-stubs/invocations.jsonl"]);
    expect(lesson013.runnerPrivate?.gateEvidence.workspacePathPrefixes).toEqual(["factory/refactor/.tmp/events/"]);
    expect(lesson013.artifactAllowlist).not.toContain("factory/refactor/.tmp/events/extra.jsonl");
    expect(() => (lesson013.runnerPrivate!.gateEvidence.workspaceFiles as string[]).push("/unsafe")).toThrow(TypeError);
    for (const scenario of AUTHORED_WORKBOOK_SCENARIOS) {
      for (const path of scenario.runnerPrivate?.gateEvidence.workspaceFiles ?? []) expect(path).not.toMatch(/^\/|\.\.|\\|\0/);
      for (const prefix of scenario.runnerPrivate?.gateEvidence.workspacePathPrefixes ?? []) {
        expect(prefix).toMatch(/\/$/);
        expect(prefix).not.toMatch(/^\/|\.\.|\\|\0/);
      }
      const publicDescriptor = copyAuthoredWorkbookEvalScenarioPublicDescriptor(scenario);
      expect(publicDescriptor).not.toHaveProperty("runnerPrivate");
      expect(publicDescriptor).not.toHaveProperty("gateCheckpoints");
      const prompt = buildAuthoredWorkbookJudgePrompt(publicDescriptor, { scenarioId: scenario.id as any, publicStates: [], terminalTranscript: [], reflections: [], editors: [], progressionEvents: [], artifacts: [] }, { passed: true, assertions: [] });
      expect(prompt).not.toContain("runnerPrivate");
      expect(prompt).not.toContain("authored-eval-command-stubs/invocations.jsonl");
      expect(prompt).not.toContain("factory/refactor/.tmp/events/");
    }
  });
});

describe("authored workbook scenario gates", () => {
  it("passes the authored synthetic fixture for each scenario", async () => {
    for (const scenario of AUTHORED_WORKBOOK_SCENARIOS) {
      expect(scenario.gate(await passingFixture(scenario.id))).toMatchObject({ passed: true });
    }
  });

  it("passes the primer gate using actual workbook workflow projection through conclusion", async () => {
    const scenario = authoredWorkbookScenarioById("primer-validation-misconception");
    const workspace = await createAuthoredCurriculumSliceWorkspace({ selection: scenario.selection });
    tempRoots.push(workspace.repositoryRoot);
    let server: { url: string; close(): Promise<void> } | undefined;
    try {
      server = await workspace.startServer({ embeddedTerminal: false, mainTutor: new PrimerWorkflowFakeTutor() });
      const trace = createEmptyAuthoredWorkbookEvalSessionTrace(scenario.id);
      const driver = new AuthoredWorkbookDriver({ serverUrl: server.url, trace, requestTimeoutMs: 5_000, editorReviewTimeoutMs: 5_000 });

      await scenario.drive({ driver });

      const rawEvents = await readAuthoredWorkbookTimeline(workspace.latestSession().sessionRoot);
      const publicTrace = projectAuthoredWorkbookEvalTrace({ ...trace, internalEvents: rawEvents });
      expect(publicTrace.progressionEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "block_completed", blockId: "workbook--introduction" }),
        expect.objectContaining({ type: "block_completed", blockId: "lesson--what-is-a-factory--conclusion" })
      ]));
      expect(publicTrace.progressionEvents.at(-1)).toMatchObject({ type: "block_completed", blockId: "lesson--what-is-a-factory--conclusion" });

      const gateInput: AuthoredWorkbookScenarioGateInput = {
        trace: publicTrace,
        commandInvocations: [],
        artifactSnapshots: [],
        workspaceFileSnapshots: [],
        rawEvents,
        facts: { authoredSourceChanged: false, disposableCurriculumChanged: false, lessonJumpStarted: false, commandStubsCreated: false, learnerWorkspaceChangedOutsideAllowlist: [] }
      };
      const gate = scenario.gate(gateInput);
      expect(gate.assertions.find((assertion) => assertion.id === "primer-normal-completion")).toMatchObject({ passed: true });
      expect(gate).toMatchObject({ passed: true });
    } finally {
      await server?.close().catch(() => undefined);
      await workspace.close().catch(() => undefined);
      const index = tempRoots.indexOf(workspace.repositoryRoot);
      if (index >= 0) tempRoots.splice(index, 1);
    }
  }, 15_000);

  it("drives Lessons 003-004 through the actual workbook workflow with deterministic local terminal stubs", async () => {
    const scenario = authoredWorkbookScenarioById("lessons-003-004-evidence-feedback");
    const workspace = await createAuthoredCurriculumSliceWorkspace({
      selection: scenario.selection,
      prerequisiteOverlays: [scenario.prerequisiteOverlay!]
    });
    tempRoots.push(workspace.repositoryRoot);
    let server: { url: string; close(): Promise<void> } | undefined;
    let handle: Awaited<ReturnType<typeof createAuthoredCommandStubs>> | undefined;
    const originalApiKey = process.env.OPENCODE_API_KEY;
    try {
      process.env.OPENCODE_API_KEY = "test-opencode-key";
      let terminalEnv: NodeJS.ProcessEnv | undefined;
      server = await workspace.startServer({
        embeddedTerminal: true,
        terminalPtyFactory: (options) => new HostBashTerminalPty(options, terminalEnv ?? process.env),
        mainTutor: new Lessons003004WorkflowFakeTutor(),
        practiceCoach: new RecordingPracticeCoach()
      });
      const sessionWorkspace = workspace.latestSession().workspaceRoots["refactor-line"]!;
      handle = await createAuthoredCommandStubs({ lessonNumber: scenario.stubLessonNumber!, workspaceRoot: sessionWorkspace, scenarioId: scenario.id });
      const path = `${handle.hostBinDir}:${dirname(process.execPath)}:/usr/bin:/bin`;
      terminalEnv = { ...process.env, ...handle.hostEnv, PATH: path, STUBBED_PATH: path };
      const trace = createEmptyAuthoredWorkbookEvalSessionTrace(scenario.id);
      const driver = new AuthoredWorkbookDriver({
        serverUrl: server.url,
        trace,
        privateTerminalShellPrefix: hostCommandStubActivation(handle),
        terminalTimeoutMs: 5_000,
        terminalReviewTimeoutMs: 60_000,
        editorReviewTimeoutMs: 10_000,
        requestTimeoutMs: 10_000
      });

      const checkpoints = createAuthoredWorkbookScenarioGateCheckpointRecorder(scenario);
      await scenario.drive({ driver, captureGateCheckpoint: (label) => checkpoints.captureGateCheckpoint(label) });

      const rawEvents = await readAuthoredWorkbookTimeline(workspace.latestSession().sessionRoot);
      const publicTrace = projectAuthoredWorkbookEvalTrace({ ...trace, internalEvents: rawEvents });
      const inputs = publicTrace.terminalTranscript.filter((entry) => entry.direction === "input").map((entry) => entry.text.replace(/[\r\n]+$/, ""));
      expect(inputs).toHaveLength(5);
      expect(inputs[1]).not.toContain("sed -n '1,120p' factory/refactor-validate.sh");
      expect(inputs[1]).toContain("./factory/refactor-validate.sh\ncat factory/.tmp/refactor-validate-findings.txt; printf");
      const visibleOutput = publicTrace.terminalTranscript.filter((entry) => entry.direction === "output").map((entry) => entry.text).join("\n");
      const verdictIndex = visibleOutput.indexOf("VERDICT: FAIL");
      const mechanicsIndex = visibleOutput.indexOf("=== VALIDATOR MECHANICS (from factory/refactor-validate.sh) ===");
      expect(verdictIndex).toBeGreaterThanOrEqual(0);
      expect(mechanicsIndex).toBeGreaterThan(verdictIndex);
      for (const marker of ["Mechanic: missing-baseline guard", "if [ ! -f .tmp/refactor-quality-before.txt ]; then", "Mechanic: baseline concatenated into validation", "cat refactor-validate.md .tmp/refactor-quality-before.txt", "Mechanic: exact read-only tools", "--tools read,grep,find,ls,bash -p", "Mechanic: findings captured through tee", "| tee .tmp/refactor-validate-findings.txt"]) expect(visibleOutput).toContain(marker);
      expect(checkpoints.labels).toEqual(["lessons003004:after-multiply-only"]);
      const feedbackMessages = publicTrace.publicStates.flatMap((entry) => entry.state.progress.blocks.flatMap((block) => block.terminal?.phase === "feedback" ? [block.terminal.message] : []));
      expect(feedbackMessages).toEqual(expect.arrayContaining([
        expect.stringMatching(/baseline|tee|findings/i),
        expect.stringMatching(/validator|baseline|doer context/i),
        expect.stringMatching(/divide branch/i)
      ]));
      expect(publicTrace.progressionEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "block_completed", blockId: "lesson--004-feed-the-findings-back" }),
        expect.objectContaining({ type: "attempt_accepted", blockId: "lesson--004-feed-the-findings-back--implementation-order", kind: "terminal" }),
        expect.objectContaining({ type: "block_completed", blockId: "lesson--004-feed-the-findings-back--checks" })
      ]));
      expect(JSON.stringify(publicTrace)).not.toMatch(/AUTHORED_EVAL_COMMAND_STUB_CONFIG|authored-eval-command-stubs\/container-config|\/var\/folders|\/private\/tmp/);
    } finally {
      if (originalApiKey === undefined) delete process.env.OPENCODE_API_KEY;
      else process.env.OPENCODE_API_KEY = originalApiKey;
      await server?.close().catch(() => undefined);
      await handle?.close().catch(() => undefined);
      await workspace.close().catch(() => undefined);
      const index = tempRoots.indexOf(workspace.repositoryRoot);
      if (index >= 0) tempRoots.splice(index, 1);
    }
  }, 90_000);

  it("requires the current conclusion completion while accepting the legacy reflection replay shape", async () => {
    const scenario = authoredWorkbookScenarioById("primer-validation-misconception");
    const live = await passingFixture("primer-validation-misconception");
    expect(live.trace.progressionEvents.at(-1)).toEqual({ type: "block_completed", lessonId: "what-is-a-factory", blockId: "lesson--what-is-a-factory--conclusion" });
    expect(scenario.gate(live).passed).toBe(true);

    const legacy = cloneInput(live);
    legacy.trace.progressionEvents[legacy.trace.progressionEvents.length - 1] = event("reflection_completed", "what-is-a-factory", "lesson--what-is-a-factory--factory-vs-repl");
    expect(scenario.gate(legacy).passed).toBe(true);

    const obsoleteReflectionBlockCompletion = cloneInput(live);
    obsoleteReflectionBlockCompletion.trace.progressionEvents[obsoleteReflectionBlockCompletion.trace.progressionEvents.length - 1] = event("block_completed", "what-is-a-factory", "lesson--what-is-a-factory--factory-vs-repl");
    expect(scenario.gate(obsoleteReflectionBlockCompletion).passed).toBe(false);
  });

  it("mutation-tests primer gate assertions", async () => {
    await expectMutationsFail("primer-validation-misconception", [
      ["remove misconception", (input) => { input.trace.reflections = input.trace.reflections.filter((entry) => !entry.text.includes("trust/faith")); }],
      ["remove tutor feedback", (input) => { input.trace.reflections = input.trace.reflections.filter((entry) => entry.role !== "tutor"); }],
      ["remove validation repair", (input) => { input.trace.reflections.find((entry) => entry.role === "learner" && entry.text.includes("up-front"))!.text = "I now agree."; }],
      ["add unexpected artifact", (input) => { input.artifactSnapshots = [{ path: "factory/.tmp/unexpected.txt", content: "unexpected" }]; }],
      ["mark stubs created", (input) => { input.facts.commandStubsCreated = true; }],
      ["mark source changed", (input) => { input.facts.authoredSourceChanged = true; }],
      ["remove conclusion completion", (input) => { input.trace.progressionEvents = input.trace.progressionEvents.filter((entry) => entry.type !== "block_completed" && entry.type !== "reflection_completed"); }],
      ["wrong conclusion block", (input) => { input.trace.progressionEvents[input.trace.progressionEvents.length - 1] = event("block_completed", "what-is-a-factory", "lesson--what-is-a-factory--importance-of-validation"); }],
      ["inject lesson jump", (input) => { input.facts.lessonJumpStarted = true; }],
      ["inject raw lesson jump", (input) => { input.rawEvents = [{ type: "lesson_jump_started", lessonId: "copied" } as any]; }]
    ]);
  });

  it("normalizes Bash line continuations only for private raw Lesson 001 lifecycle commands", async () => {
    const scenario = authoredWorkbookScenarioById("lesson-001-headless-boundary");
    const collapsed = cloneInput(await passingFixture("lesson-001-headless-boundary"));
    for (const event of collapsed.rawEvents) {
      if ((event as any).type === "terminal-command-submitted") (event as any).command = (event as any).command.replace(/\\\n/g, "");
    }
    expect(collapsed.trace.terminalTranscript.some((entry) => entry.text === lesson001SuppliedCommand)).toBe(true);
    expect(scenario.gate(collapsed).passed).toBe(true);

    const altered = cloneInput(await passingFixture("lesson-001-headless-boundary"));
    (altered.rawEvents.find((event: any) => event.type === "terminal-command-submitted" && event.blockId.endsWith("--run-supplied-command")) as any).command = lesson001SuppliedCommand.replace("read,grep,find,ls", "read,edit,write");
    expect(scenario.gate(altered).passed).toBe(false);
  });

  it("mutation-tests Lesson 001 gate assertions", async () => {
    const workspaceMetadata = await passingFixture("lesson-001-headless-boundary");
    workspaceMetadata.facts.learnerWorkspaceChangedOutsideAllowlist = [".tmp/workbook-normal-metadata.json"];
    expect(authoredWorkbookScenarioById("lesson-001-headless-boundary").gate(workspaceMetadata).passed).toBe(true);

    await expectMutationsFail("lesson-001-headless-boundary", [
      ["add unexpected artifact", (input) => { input.artifactSnapshots = [{ path: "factory/.tmp/unexpected.txt", content: "unexpected" }]; }],
      ["remove simple command", (input) => { input.trace.terminalTranscript = input.trace.terminalTranscript.filter((entry) => !entry.text.includes("capital of France")); }],
      ["change supplied command", (input) => { input.trace.terminalTranscript.find((entry) => entry.text === lesson001SuppliedCommand)!.text = lesson001SuppliedCommand.replace("read,grep,find,ls", "read,edit,write"); }],
      ["swap order", (input) => { const rows = input.trace.terminalTranscript; [rows[0], rows[2]] = [rows[2]!, rows[0]!]; }],
      ["remove reflection boundary", (input) => { input.trace.reflections[0]!.text = "The command ran."; }],
      ["mark stubs created", (input) => { input.facts.commandStubsCreated = true; }],
      ["mark authored source changed", (input) => { input.facts.authoredSourceChanged = true; }],
      ["mark disposable curriculum changed", (input) => { input.facts.disposableCurriculumChanged = true; }],
      ["calculator changed", (input) => { input.facts.lesson001CalculatorAfterSha256 = "different"; }],
      ["remove public output", (input) => { input.trace.terminalTranscript = input.trace.terminalTranscript.filter((entry) => entry.direction !== "output"); }],
      ["inject lesson jump", (input) => { input.facts.lessonJumpStarted = true; }],
      ["failed terminal exit", (input) => { (input.rawEvents.find((event: any) => event.type === "terminal-command-finished") as any).exitStatus = 1; }],
      ["raw lifecycle reordered", (input) => { const rows = input.rawEvents as any[]; [rows[0], rows[1]] = [rows[1]!, rows[0]!]; }],
      ["accepted version 999", (input) => { (input.rawEvents.find((event: any) => event.type === "attempt_accepted") as any).version = 999; }],
      ["public version stale", (input) => { input.trace.publicStates[0]!.state.progress.blocks[0]!.terminalRevision = 999; }],
      ["duplicate stale attempt", (input) => { input.rawEvents = [rawSubmitted("stale", "001-run-an-agent-headlessly", "lesson--001-run-an-agent-headlessly--run-simple-pi-prompt", "echo stale"), ...input.rawEvents]; }],
      ["mixed accepted attempt", (input) => { (input.rawEvents.find((event: any) => event.type === "attempt_accepted") as any).attemptId = "mixed"; }],
      ["inject raw lesson jump", (input) => { input.rawEvents = [{ type: "lesson_jump_started", lessonId: "copied" } as any]; }]
    ]);
  });

  it("treats terminal validation announcements separately from captured findings", async () => {
    const scenario = authoredWorkbookScenarioById("lessons-003-004-evidence-feedback");
    const fixture = await passingFixture("lessons-003-004-evidence-feedback");
    fixture.trace.terminalTranscript.push({ blockId: "lesson--003-build-a-validator--implementation-order", direction: "output", text: "Starting validation...\nVERDICT: PASS\n" });
    expect(scenario.gate(fixture).passed).toBe(true);

    mutateSnapshot(fixture, "factory/.tmp/refactor-validate-findings.txt", (text) => `Starting validation...\n${text}`);
    expect(scenario.gate(fixture).passed).toBe(false);
  });

  it("mutation-tests Lessons 003-004 gate assertions", async () => {
    await expectMutationsFail("lessons-003-004-evidence-feedback", [
      ["lesson order missing", (input) => { input.trace.progressionEvents = input.trace.progressionEvents.filter((event) => !("lessonId" in event && event.lessonId === "004-feed-the-findings-back")); }],
      ["add unexpected artifact", (input) => { input.artifactSnapshots = [...input.artifactSnapshots, { path: "factory/.tmp/extra.txt", content: "extra" }]; }],
      ["remove guard", (input) => { mutateSnapshot(input, "factory/refactor-validate.sh", (text) => text.replace("if [ ! -f .tmp/refactor-quality-before.txt ]; then", "# missing guard")); }],
      ["remove tee", (input) => { mutateSnapshot(input, "factory/refactor-validate.sh", (text) => text.replace("| tee .tmp/refactor-validate-findings.txt", "")); }],
      ["change prompt", (input) => { mutateSnapshot(input, "factory/refactor-validate.md", (text) => text.replace("single refactoring", "large rewrite")); }],
      ["remove visible corrected mechanics", (input) => { input.trace.terminalTranscript = input.trace.terminalTranscript.filter((entry) => entry.direction !== "output" || !entry.text.includes("refactor-quality-before.txt")); }],
      ["show mechanics before validator verdict", (input) => { const output = input.trace.terminalTranscript.find((entry) => entry.direction === "output" && entry.text.includes("=== VALIDATOR MECHANICS")); if (output) output.text = output.text.replace("Starting validation...\nVERDICT: FAIL\n\n", "=== VALIDATOR MECHANICS (from factory/refactor-validate.sh) ===\nMechanic: premature display\nStarting validation...\nVERDICT: FAIL\n\n"); }],
      ["remove broken command", (input) => { input.trace.terminalTranscript = input.trace.terminalTranscript.filter((entry) => !entry.text.includes("cat refactor-validate.md \\\n  |")); }],
      ["remove wrong rerun", (input) => { input.trace.terminalTranscript = input.trace.terminalTranscript.filter((entry) => !entry.text.endsWith(lesson004WrongCommand)); }],
      ["remove multiply command", (input) => { input.trace.terminalTranscript = input.trace.terminalTranscript.filter((entry) => !entry.text.endsWith(lesson004MultiplyCommand)); }],
      ["remove divide feedback command", (input) => { input.trace.terminalTranscript = input.trace.terminalTranscript.filter((entry) => !entry.text.endsWith(lesson004DivideCommand)); }],
      ["change stub pass", (input) => { input.commandInvocations = input.commandInvocations.map((entry) => entry.verdict === "PASS" ? { ...entry, verdict: "FAIL" as const } : entry); }],
      ["remove divide completion", (input) => { mutateSnapshot(input, "calculator/src/index.ts", (text) => text.replace('    if (word === "divide") {\n      const first = readFirstOperand("by");', '    if (word === "divide") {\n      const first = read();')); }],
      ["commented refactor marker", (input) => { mutateCalculatorSourceAndTrustDigest(input, (text) => sourceWithFakeRefactor(text, (fake) => `/*\n${fake}\n*/`)); }],
      ["string literal refactor marker", (input) => { mutateCalculatorSourceAndTrustDigest(input, (text) => sourceWithFakeRefactor(text, (fake) => `${JSON.stringify(fake)};`)); }],
      ["unused nested refactor marker", (input) => { mutateCalculatorSourceAndTrustDigest(input, (text) => sourceWithFakeRefactor(text, (fake) => `function unusedRefactorBypass(): void {\n${fake}\n    }`)); }],
      ["dead if false refactor marker", (input) => { mutateCalculatorSourceAndTrustDigest(input, (text) => sourceWithFakeRefactor(text, (fake) => `if (false) {\n${fake}\n    }`)); }],
      ["calculator syntax error", (input) => { mutateCalculatorSourceAndTrustDigest(input, (text) => `${text}\nconst = ;\n`); }],
      ["remove pass findings", (input) => { mutateSnapshot(input, "factory/.tmp/refactor-validate-findings.txt", (text) => text.replace("VERDICT: PASS", "VERDICT: FAIL")); }],
      ["prefix findings with terminal announcement", (input) => { mutateSnapshot(input, "factory/.tmp/refactor-validate-findings.txt", (text) => `Starting validation...\n${text}`); }],
      ["remove baseline", (input) => { mutateSnapshot(input, "factory/.tmp/refactor-quality-before.txt", () => ""); }],
      ["stale baseline digest", (input) => { input.facts.expectedCanonicalBaselineSha256 = "0".repeat(64); }],
      ["stale behavior projection", (input) => { input.facts.calculatorBehaviorProjection!.sourceSha256 = "0".repeat(64); }],
      ["mark source changed", (input) => { input.facts.authoredSourceChanged = true; }],
      ["mixed previous-run stub records", (input) => { input.commandInvocations[0]!.runId = "00000000-0000-0000-0000-000000000000"; }],
      ["raw lesson jump", (input) => { input.rawEvents = [{ type: "lesson_jump_started", lessonId: "copied" } as any]; }]
    ]);
  });

  it("accepts Lesson 013's exact late-steered partial→FAIL→repair→PASS path", async () => {
    const scenario = authoredWorkbookScenarioById("lesson-013-operator-judgement");
    const input = cloneInput(await passingFixture("lesson-013-operator-judgement"));
    const steerSha256 = sha256Text(sha256Text("Finish multiply and divide independently before validation."));
    input.commandInvocations = [
      stub("doer", { mode: "rpc", mutation: "partial-refactor", rpc: true, rpcOverrides: { commandCount: 2, earlySteerCount: 0, lateSteerCount: 1, steerBytes: Buffer.byteLength("Finish multiply and divide independently before validation.", "utf8"), steerSha256 } }),
      stub("validator", { mode: "json", verdict: "FAIL", mutation: "none" }),
      stub("repair", { mode: "json", mutation: "complete-refactor" }),
      stub("doer", { mode: "rpc", mutation: "already-complete", rpc: true }),
      stub("validator", { mode: "json", verdict: "PASS", mutation: "none" }),
      stub("commit", { mode: "json", mutation: "none" }),
      stub("ask", { mode: "text", tools: "none", mutation: "none" })
    ];
    mutateSnapshot(input, ".tmp/refactor-run.log", (text) => text.replace("Starting validation\nStarting commit", "Starting validation\nStarting repair\n=== Iteration 2 of 5 ===\nStarting doer\nStarting validation\nStarting commit"));
    expect(scenario.gate(input).passed).toBe(true);

    const swappedTiming = cloneInput(input);
    swappedTiming.commandInvocations[0]!.rpc!.earlySteerCount = 1;
    swappedTiming.commandInvocations[0]!.rpc!.lateSteerCount = 0;
    expect(scenario.gate(swappedTiming).passed).toBe(false);
  });

  it("mutation-tests Lesson 013 gate assertions", async () => {
    await expectMutationsFail("lesson-013-operator-judgement", [
      ["remove run command", (input) => { input.trace.terminalTranscript[0]!.text = "./factory/refactor/run.sh"; }],
      ["add unexpected artifact", (input) => { input.artifactSnapshots = [...input.artifactSnapshots, { path: "factory/refactor/.tmp/events/extra.jsonl", content: "{}" }]; }],
      ["remove rpc evidence", (input) => { input.commandInvocations = input.commandInvocations.map((entry) => entry.mode === "rpc" ? { ...entry, rpc: undefined } : entry); }],
      ["remove steer evidence", (input) => { input.commandInvocations = input.commandInvocations.map((entry) => entry.mode === "rpc" && entry.rpc ? { ...entry, rpc: { ...entry.rpc, earlySteerCount: 0, commandCount: 1 } } : entry); }],
      ["swap early steer into late timing", (input) => { input.commandInvocations = input.commandInvocations.map((entry) => entry.mode === "rpc" && entry.rpc ? { ...entry, rpc: { ...entry.rpc, earlySteerCount: 0, lateSteerCount: 1 } } : entry); }],
      ["rpc event classes agent-end only", (input) => { input.commandInvocations = input.commandInvocations.map((entry) => entry.mode === "rpc" && entry.output ? { ...entry, output: { ...entry.output, eventClasses: ["agent_end"] } } : entry); }],
      ["rpc event classes missing class", (input) => { input.commandInvocations = input.commandInvocations.map((entry) => entry.mode === "rpc" && entry.output ? { ...entry, output: { ...entry.output, eventClasses: lesson013RpcEventClasses.filter((eventClass) => eventClass !== "message_update") } } : entry); }],
      ["rpc event classes extra class", (input) => { input.commandInvocations = input.commandInvocations.map((entry) => entry.mode === "rpc" && entry.output ? { ...entry, output: { ...entry.output, eventClasses: [...lesson013RpcEventClasses, "agent_end"] } } : entry); }],
      ["rpc event classes reordered", (input) => { input.commandInvocations = input.commandInvocations.map((entry) => entry.mode === "rpc" && entry.output ? { ...entry, output: { ...entry.output, eventClasses: [...lesson013RpcEventClasses].reverse() } } : entry); }],
      ["steering attached to wrong doer", (input) => { input.commandInvocations = [stub("doer", { mode: "rpc", mutation: "complete-refactor", rpc: true }), stub("repair", { mode: "rpc", mutation: "complete-refactor", rpc: true, rpcOverrides: { commandCount: 2, earlySteerCount: 1, lateSteerCount: 0, steerBytes: Buffer.byteLength("Finish multiply and divide independently before validation.", "utf8"), steerSha256: sha256Text(sha256Text("Finish multiply and divide independently before validation.")) } }), stub("validator", { mode: "json", verdict: "PASS", mutation: "none" }), stub("commit", { mode: "json", mutation: "none" }), stub("ask", { mode: "text", tools: "none", mutation: "none" })]; }],
      ["raw event artifact copied public", (input) => { input.artifactSnapshots = [...input.artifactSnapshots, { path: "factory/refactor/.tmp/events/extra.jsonl", content: "{}" }]; input.trace.artifacts = input.artifactSnapshots.map((snapshot) => ({ ...snapshot })); input.workspaceFileSnapshots = input.artifactSnapshots.map((snapshot) => ({ ...snapshot })); }],
      ["remove commit", (input) => { input.facts.calculatorHeadChanged = false; }],
      ["prefix findings with terminal announcement", (input) => { mutateSnapshot(input, "factory/refactor/.tmp/validate-findings.txt", (text) => `Starting validation...\n${text}`); }],
      ["remove source completion", (input) => { mutateSnapshot(input, "calculator/src/index.ts", (text) => text.replace('const first = readFirstOperand("by");', 'const first = read();')); }],
      ["missing trusted quality summary", (input) => { delete input.facts.calculatorBehaviorProjection!.qualityOutput; }],
      ["stale git top", (input) => { input.facts.calculatorTopCommitTree = "stale-tree"; }],
      ["remove run log", (input) => { mutateSnapshot(input, ".tmp/refactor-run.log", () => "Line finished"); }],
      ["remove visible terminal output", (input) => { input.trace.terminalTranscript = input.trace.terminalTranscript.filter((entry) => entry.direction !== "output"); }],
      ["remove vocabulary", (input) => { input.trace.reflections[0]!.text = "It worked."; }],
      ["remove five jobs", (input) => { input.trace.reflections[0]!.text = "The factory is factory/. The line is refactor/. The orchestrator is run.sh. Prompt/script pairs are stations. ask.sh is no-tools because the record is supplied. I am the operator. Repeated FAIL can mean an unmet criterion or missing/unreachable evidence. Cost, regressions, and whether the result is worth it are still operator judgement."; }],
      ["remove judgement", (input) => { input.trace.reflections[0]!.text = input.trace.reflections[0]!.text.replace(/Cost, regressions, and whether the result is worth it are still operator judgement\./, "It decides everything."); }],
      ["mark workspace outside allowlist", (input) => { input.facts.learnerWorkspaceChangedOutsideAllowlist = ["factory/.tmp/unexpected.log"]; }],
      ["mixed previous-run stub records", (input) => { input.commandInvocations[0]!.runId = "00000000-0000-0000-0000-000000000000"; }],
      ["raw lesson jump", (input) => { input.rawEvents = [{ type: "lesson_jump_started", lessonId: "copied" } as any]; }]
    ]);
  });
});

describe("authored scenario shell commands", () => {
  it("executes every Lessons 003-004 mistake and repair command against a real disposable slice and command-stub handle", async () => {
    const scenario = authoredWorkbookScenarioById("lessons-003-004-evidence-feedback");
    const { workspace, sessionWorkspace, handle, commands } = await liveScenarioHarness(scenario.id);
    try {
      const bodies = commands.map(stripActivation);
      expect(bodies).toHaveLength(5);
      const baselinePath = join(sessionWorkspace, "factory/.tmp/refactor-quality-before.txt");
      const outputs: string[] = [];
      for (const [index, command] of bodies.entries()) {
        outputs.push(await execShell(command, sessionWorkspace, stubbedShellEnv(handle), index === 4 ? 20_000 : 10_000));
        if (index === 1) {
          const baseline = await readFile(baselinePath, "utf8");
          expect(sha256Text(baseline)).toBe(sha256Text(await readFile(baselinePath, "utf8")));
        }
        if (index === 2) {
          const sourceAfterWrongRerun = await readFile(join(sessionWorkspace, "calculator/src/index.ts"), "utf8");
          expect(sourceAfterWrongRerun).toContain('const first = readFirstOperand("and");');
          expect(sourceAfterWrongRerun).toContain('if (pieces[place++] !== "by") fail();');
        }
      }
      const correctedOutput = outputs[1]!;
      expect(correctedOutput).not.toContain("#!/usr/bin/env bash");
      expect(correctedOutput).not.toContain("sed -n '1,120p'");
      for (const marker of ["if [ ! -f .tmp/refactor-quality-before.txt ]; then", "cat refactor-validate.md .tmp/refactor-quality-before.txt", "| tee .tmp/refactor-validate-findings.txt", "--tools read,grep,find,ls,bash -p"]) expect(correctedOutput).toContain(marker);
      const correctedVerdictIndex = correctedOutput.indexOf("VERDICT: FAIL");
      const correctedMechanicsIndex = correctedOutput.indexOf("=== VALIDATOR MECHANICS (from factory/refactor-validate.sh) ===");
      expect(correctedVerdictIndex).toBeGreaterThanOrEqual(0);
      expect(correctedMechanicsIndex).toBeGreaterThan(correctedVerdictIndex);
      expect(correctedOutput).toMatch(/^Starting validation\.\.\.\nVERDICT: FAIL/m);
      expect(correctedOutput).toContain("Current quality still reports: calculator/src/index.ts duplicated operator branch parser.");
      expect(correctedOutput).not.toMatch(/exact labelled TESTS|complete QUALITY\/TESTS\/DIFF|current PASS/i);
      expect(outputs[2]).toMatch(/^Starting validation\.\.\.\nVERDICT: FAIL/m);
      expect(outputs[2]).toContain("Criterion not yet met: the refactor is partial");
      expect(outputs[2]).not.toMatch(/exact labelled TESTS|complete QUALITY\/TESTS\/DIFF|current PASS/i);
      const baseline = await readFile(baselinePath, "utf8");
      const baselineDigest = sha256Text(baseline);
      expect(sha256Text(await readFile(baselinePath, "utf8"))).toBe(baselineDigest);
      expect(await readFile(join(sessionWorkspace, "factory/.tmp/refactor-validate-findings.txt"), "utf8")).toMatch(/^VERDICT: PASS/m);
      const source = await readFile(join(sessionWorkspace, "calculator/src/index.ts"), "utf8");
      expect(source).toContain('const readFirstOperand = (separator: "and" | "from" | "by"): number =>');
      expect(source).toContain('const first = readFirstOperand("by");');
      const evidence = await readAuthoredCommandStubEvidence(handle.hostEvidencePath);
      expect(evidence.filter((entry) => entry.accepted && entry.kind === "pi").map((entry) => [entry.station, entry.verdict ?? entry.mutation])).toEqual([
        ["doer", "partial-refactor"],
        ["validator", "FAIL"],
        ["validator", "FAIL"],
        ["validator", "FAIL"],
        ["validator", "FAIL"],
        ["repair", "complete-refactor"],
        ["validator", "PASS"]
      ]);
    } finally {
      await handle.close().catch(() => undefined);
      await workspace.close().catch(() => undefined);
      tempRoots.splice(tempRoots.indexOf(workspace.repositoryRoot), 1);
    }
  }, 30_000);

  it("sanitizes and bounds native-binding quality output in Lesson 013 validation evidence", async () => {
    const { workspace, sessionWorkspace, handle } = await liveScenarioHarness("lesson-013-operator-judgement");
    const aliasedSessionWorkspace = join(dirname(sessionWorkspace), "regex[workspace].alias");
    try {
      await symlink(sessionWorkspace, aliasedSessionWorkspace, "dir");
      await mkdir(join(sessionWorkspace, "factory/refactor/.tmp"), { recursive: true });
      await writeFile(join(sessionWorkspace, "factory/refactor/.tmp/quality-before.txt"), "Findings reported by: baseline.\n");
      await writeFile(join(sessionWorkspace, "calculator/scripts/quality.mjs"), String.raw`const cwd = process.cwd();
console.error('Error: native binding failed at /workspace/node_modules/native-binding/build/Release/addon.node');
console.error('    at load (/opt/workbook/node_modules/native-loader/index.js:12:3)');
console.error('    at local (' + cwd + '/node_modules/native-loader/index.js:34:5)');
for (let index = 1; index <= 120; index += 1) console.log('native frame ' + index + ' ' + '/workspace/node_modules/'.repeat(8));
console.log('Findings reported by: native binding probe.');
process.exit(1);
`);
      const statusProbe = await execShell(String.raw`cd '${aliasedSessionWorkspace}/factory/refactor'
eval "$(sed -n '/^sanitize_quality_paths()/,/^mkdir -p \.tmp$/p' validate.sh | sed '$d')"
mkdir -p .tmp
set +e
quality_now > .tmp/quality-status-probe.txt
quality_status=$?
set -e
printf 'quality-status=%s\n' "$quality_status"`, aliasedSessionWorkspace, stubbedShellEnv(handle), 10_000);
      expect(statusProbe).toContain("quality-status=1");
      await execShell(`cd '${aliasedSessionWorkspace}' && ./factory/refactor/validate.sh`, sessionWorkspace, stubbedShellEnv(handle), 10_000);
      const evidence = await readFile(join(sessionWorkspace, "factory/refactor/.tmp/evidence.txt"), "utf8");
      const qualityNow = evidenceSection(evidence, "QUALITY NOW");
      expect(Buffer.byteLength(qualityNow, "utf8")).toBeLessThanOrEqual(16 * 1024);
      expect(qualityNow.split(/\r?\n/).length).toBeLessThanOrEqual(62);
      expect(qualityNow).toContain("<workspace>/node_modules/native-binding/build/Release/addon.node");
      expect(qualityNow).toContain("<workbook>/node_modules/native-loader/index.js");
      expect(qualityNow).toContain("<calculator>/node_modules/native-loader/index.js");
      expect(qualityNow).toContain("Findings reported by: native binding probe.");
      expect(qualityNow).not.toMatch(/\/workspace|\/opt\/workbook|\/var\/folders|\/private\/var|native frame 120/);
      expect(await readFile(join(sessionWorkspace, "factory/refactor/.tmp/validate-findings.txt"), "utf8")).toMatch(/^VERDICT: /m);
    } finally {
      await handle.close().catch(() => undefined);
      await workspace.close().catch(() => undefined);
      tempRoots.splice(tempRoots.indexOf(workspace.repositoryRoot), 1);
    }
  }, 30_000);

  it("sanitizes real shell calculator paths while preserving a passing quality summary", async () => {
    const { workspace, sessionWorkspace, handle } = await liveScenarioHarness("lesson-013-operator-judgement");
    try {
      await mkdir(join(sessionWorkspace, "factory/refactor/.tmp"), { recursive: true });
      await writeFile(join(sessionWorkspace, "factory/refactor/.tmp/quality-before.txt"), "Findings reported by: baseline.\n");
      await writeFile(join(sessionWorkspace, "calculator/scripts/quality.mjs"), "console.log('loaded from ' + process.cwd() + '/native/binding.node');\nconsole.log('All quality checks passed.');\n");
      await execShell("./factory/refactor/validate.sh", sessionWorkspace, stubbedShellEnv(handle), 10_000);
      const evidence = await readFile(join(sessionWorkspace, "factory/refactor/.tmp/evidence.txt"), "utf8");
      const qualityNow = evidenceSection(evidence, "QUALITY NOW");
      expect(qualityNow).toContain("<calculator>/native/binding.node");
      expect(qualityNow).toContain("All quality checks passed.");
      expect(qualityNow).not.toContain(sessionWorkspace);
      expect(qualityNow).not.toMatch(/\/var\/folders|\/private\/var/);
    } finally {
      await handle.close().catch(() => undefined);
      await workspace.close().catch(() => undefined);
      tempRoots.splice(tempRoots.indexOf(workspace.repositoryRoot), 1);
    }
  }, 30_000);

  it("executes the Lesson 013 run/watch/ask/steer path with real RPC stubs and a clean exact commit", async () => {
    const { workspace, sessionWorkspace, handle, commands } = await liveScenarioHarness("lesson-013-operator-judgement", { rpcEarlySteerWindowMs: AUTHORED_STUB_RPC_EARLY_STEER_WINDOW_MS, rpcLateSteerWindowMs: 20 });
    try {
      expect(commands).toHaveLength(1);
      const output = await execShell(stripActivation(commands[0]!), sessionWorkspace, stubbedShellEnv(handle), 20_000);
      expectLesson013VisibleOutput(output);
      await expectLesson013StubbedResult(sessionWorkspace, handle.hostEvidencePath);
    } finally {
      await handle.close().catch(() => undefined);
      await workspace.close().catch(() => undefined);
      tempRoots.splice(tempRoots.indexOf(workspace.repositoryRoot), 1);
    }
  }, 30_000);

  it.runIf(process.env.AUTHORED_WORKBOOK_REAL_DOCKER === "1")("runs the Lesson 013 prerequisite path in the canonical Docker image with unpaid stubs", async () => {
    const { workspace, sessionWorkspace, handle, commands } = await liveScenarioHarness("lesson-013-operator-judgement", { rpcEarlySteerWindowMs: AUTHORED_STUB_RPC_EARLY_STEER_WINDOW_MS, rpcLateSteerWindowMs: 20 });
    const volumeName = `authored-workbook-preflight-${randomUUID()}`;
    try {
      expect(commands).toHaveLength(1);
      await execFileAsync("docker", dockerVolumeCreateArguments(volumeName), { timeout: 10_000 });
      await execDockerWithPrivateInput(dockerPopulateVolumeArguments(volumeName, WORKBOOK_TERMINAL_IMAGE), await buildBoundedWorkspaceTar(sessionWorkspace), 20_000);
      const output = await execDockerWithPrivateInput([
        "run", "--rm", "-i", "--user", dockerContainerUser(), "--network", "none", "--mount", dockerWorkspaceVolumeMount(volumeName),
        "--workdir", "/workspace", WORKBOOK_TERMINAL_IMAGE, "bash"
      ], Buffer.from(dockerLesson013SmokeScript(handle.containerShellActivation, stripActivation(commands[0]!)), "utf8"), 30_000);
      expectLesson013VisibleOutput(output);
    } finally {
      await execFileAsync("docker", dockerVolumeRemoveArguments(volumeName), { timeout: 10_000 }).catch(() => undefined);
      await handle.close().catch(() => undefined);
      await workspace.close().catch(() => undefined);
      tempRoots.splice(tempRoots.indexOf(workspace.repositoryRoot), 1);
    }
  }, 60_000);

  it.runIf(process.env.AUTHORED_WORKBOOK_REAL_DOCKER === "1")("runs Lesson 013 in real Docker, then gates the host workspace end-to-end without raw public events", async () => {
    const scenario = authoredWorkbookScenarioById("lesson-013-operator-judgement");
    const { workspace, sessionWorkspace, handle, commands } = await liveScenarioHarness(scenario.id, { rpcEarlySteerWindowMs: AUTHORED_STUB_RPC_EARLY_STEER_WINDOW_MS, rpcLateSteerWindowMs: 20 });
    try {
      expect(commands).toHaveLength(1);
      const command = stripActivation(commands[0]!);
      const trace = lesson013RunTrace(command, "");
      const collector = createAuthoredWorkbookScenarioGateEvidenceCollector({ scenario, workspace, session: workspace.latestSession(), trace, commandStubHandle: { hostEvidencePath: handle.hostEvidencePath, runId: handle.runId } });
      await collector.captureBaseline();
      const output = await execDockerWithPrivateInput([
        "run", "--rm", "-i", "--user", dockerContainerUser(), "--network", "none", "--mount", `type=bind,src=${sessionWorkspace},dst=/workspace`,
        "--workdir", "/workspace", WORKBOOK_TERMINAL_IMAGE, "bash"
      ], Buffer.from(`${handle.containerShellActivation}\nset -euo pipefail\n${command}\n`, "utf8"), 60_000);
      expectLesson013VisibleOutput(output);
      trace.terminalTranscript = lesson013RunTrace(command, output).terminalTranscript;
      const input = await collector.collectGateInput();
      const gate = scenario.gate(input);
      expect(gate.passed).toBe(true);
      expect(input.artifactSnapshots.some((artifact) => artifact.path.includes("/events/") || artifact.path.endsWith("events.jsonl"))).toBe(false);
      expect(input.trace.artifacts.some((artifact) => artifact.path.includes("/events/") || artifact.path.endsWith("events.jsonl"))).toBe(false);
      const publicDescriptor = copyAuthoredWorkbookEvalScenarioPublicDescriptor(scenario);
      const judgePrompt = buildAuthoredWorkbookJudgePrompt(publicDescriptor, input.trace, { passed: gate.passed, assertions: gate.assertions.map((assertion) => ({ name: assertion.id, passed: assertion.passed, detail: assertion.message })) });
      expect(judgePrompt).not.toMatch(/"kind": "artifact"[\s\S]{0,200}"path": "factory\/refactor\/\.tmp\/events\//);
      expect(judgePrompt).not.toContain('{"type":"agent_end"');
      await expectLesson013StubbedResult(sessionWorkspace, handle.hostEvidencePath);
    } finally {
      await handle.close().catch(() => undefined);
      await workspace.close().catch(() => undefined);
      tempRoots.splice(tempRoots.indexOf(workspace.repositoryRoot), 1);
    }
  }, 90_000);
});

describe("authored workbook prerequisite seed overlays", () => {
  it("copies exact allowlisted seeds into the fresh disposable workspace template and leaves the source unchanged", async () => {
    const scenario = authoredWorkbookScenarioById("lessons-003-004-evidence-feedback");
    const before = await readFile(join(realPrerequisitesRoot, "lesson-003-prerequisites/factory/refactor.md"), "utf8");
    const workspace = await createAuthoredCurriculumSliceWorkspace({
      selection: scenario.selection,
      prerequisiteOverlays: [scenario.prerequisiteOverlay!]
    });
    tempRoots.push(workspace.repositoryRoot);

    expect(await readFile(join(workspace.root, "workspaces/refactor-line/factory/refactor.md"), "utf8")).toBe(before);
    expect(await readFile(join(realPrerequisitesRoot, "lesson-003-prerequisites/factory/refactor.md"), "utf8")).toBe(before);
    await expect(stat(join(workspace.root, "workspaces/refactor-line/factory/refactor-do.sh"))).resolves.toMatchObject({ mode: expect.any(Number) });
  });

  it("deep-freezes the seed file allowlists and prevents manifest expansion by mutation", async () => {
    expect(AUTHORED_WORKBOOK_PREREQUISITE_SEED_FILES["lesson-003-prerequisites"]).toEqual(["factory/refactor.md", "factory/refactor-do.sh"]);
    expect(Object.isFrozen(AUTHORED_WORKBOOK_PREREQUISITE_SEED_FILES)).toBe(true);
    for (const files of Object.values(AUTHORED_WORKBOOK_PREREQUISITE_SEED_FILES)) {
      expect(Object.isFrozen(files)).toBe(true);
      expect(() => (files as unknown as string[]).push("factory/expanded.txt")).toThrow(TypeError);
      expect(() => (files as unknown as string[]).splice(0, 1)).toThrow(TypeError);
      expect(files.some((file) => file.includes("..") || file.includes(".tmp") || file.endsWith(".jsonl"))).toBe(false);
    }

    const scenario = authoredWorkbookScenarioById("lessons-003-004-evidence-feedback");
    expect(() => ((scenario.prerequisiteOverlay!.files as unknown as string[])[0] = "factory/expanded.txt")).toThrow(TypeError);
    const workspace = await createAuthoredCurriculumSliceWorkspace({ selection: scenario.selection, prerequisiteOverlays: [scenario.prerequisiteOverlay!] });
    tempRoots.push(workspace.repositoryRoot);
    await expect(stat(join(workspace.root, "workspaces/refactor-line/factory/expanded.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

class RecordingDriver {
  calls: Array<{ method: string; blockId?: string; command?: string; response?: string }> = [];

  async completeIntroduction(label?: string): Promise<any> { this.calls.push({ method: "completeIntroduction", blockId: label }); return state("accepted", label); }
  async continueBlock(blockId: string): Promise<any> { this.calls.push({ method: "continueBlock", blockId }); return state("accepted", blockId); }
  async submitReflection(blockId: string, response: string): Promise<any> {
    this.calls.push({ method: "submitReflection", blockId, response });
    return state(response.includes("trust/faith") ? "feedback" : "accepted", blockId);
  }
  async submitReflectionFollowUp(blockId: string, response: string): Promise<any> { this.calls.push({ method: "submitReflectionFollowUp", blockId, response }); return state("accepted", blockId); }
  async completeReflection(blockId: string): Promise<any> { this.calls.push({ method: "completeReflection", blockId }); return state("accepted", blockId); }
  async submitTerminalCommand(blockId: string, command: string): Promise<any> { this.calls.push({ method: "submitTerminalCommand", blockId, command }); return state("accepted", blockId); }
  async completeTerminalBlock(blockId: string): Promise<any> { this.calls.push({ method: "completeTerminalBlock", blockId }); return state("accepted", blockId); }
}

class Lesson013ReflectionFeedbackDriver extends RecordingDriver {
  #followedUp = false;

  override async submitReflection(blockId: string, response: string): Promise<any> {
    this.calls.push({ method: "submitReflection", blockId, response });
    return blockId === "checks" ? state("feedback", blockId) : state("accepted", blockId);
  }

  override async submitReflectionFollowUp(blockId: string, response: string): Promise<any> {
    this.#followedUp = true;
    this.calls.push({ method: "submitReflectionFollowUp", blockId, response });
    return state("accepted", blockId);
  }

  override async completeReflection(blockId: string): Promise<any> {
    if (blockId === "checks" && !this.#followedUp) throw new Error("409 checkpoint still has feedback");
    this.calls.push({ method: "completeReflection", blockId });
    return state("accepted", blockId);
  }
}

function state(status: "accepted" | "feedback", blockId = "block"): any {
  return { progress: { blocks: [{ id: blockId, checkpoint: { status } }] } };
}

async function passingFixture(id: AuthoredWorkbookScenarioId): Promise<AuthoredWorkbookScenarioGateInput> {
  const base: AuthoredWorkbookScenarioGateInput = {
    trace: { scenarioId: id, publicStates: [], terminalTranscript: [], reflections: [], editors: [], progressionEvents: [], artifacts: [] },
    commandInvocations: [],
    artifactSnapshots: [],
    workspaceFileSnapshots: [],
    facts: {
      authoredSourceChanged: false,
      disposableCurriculumChanged: false,
      lessonJumpStarted: false,
      commandStubsCreated: false,
      learnerWorkspaceChangedOutsideAllowlist: [],
      calculatorGitStatus: "",
      calculatorHeadChanged: false,
      calculatorCommitSubjects: []
    },
    rawEvents: []
  };
  if (id === "primer-validation-misconception") return primerFixture(base);
  if (id === "lesson-001-headless-boundary") return lesson001Fixture(base);
  if (id === "lessons-003-004-evidence-feedback") return lessons003004Fixture(base);
  return lesson013Fixture(base);
}

function primerFixture(input: AuthoredWorkbookScenarioGateInput): AuthoredWorkbookScenarioGateInput {
  input.trace.progressionEvents = [
    event("workbook_introduction_completed"),
    event("reflection_submitted", "what-is-a-factory", "lesson--what-is-a-factory--importance-of-validation"),
    event("reflection_reply_recorded", "what-is-a-factory", "lesson--what-is-a-factory--importance-of-validation"),
    event("reflection_submitted", "what-is-a-factory", "lesson--what-is-a-factory--factory-vs-repl"),
    event("reflection_reply_recorded", "what-is-a-factory", "lesson--what-is-a-factory--factory-vs-repl"),
    event("reflection_follow_up_submitted", "what-is-a-factory", "lesson--what-is-a-factory--factory-vs-repl"),
    event("reflection_reply_recorded", "what-is-a-factory", "lesson--what-is-a-factory--factory-vs-repl"),
    event("block_completed", "what-is-a-factory", "lesson--what-is-a-factory--conclusion")
  ];
  input.trace.reflections = [
    { blockId: "lesson--what-is-a-factory--factory-vs-repl", role: "learner", text: "A factory requires more trust/faith in the LLM." },
    { blockId: "lesson--what-is-a-factory--factory-vs-repl", role: "tutor", text: "That is the point to revisit: the validation loop exists because you do not trust the model unchecked." },
    { blockId: "lesson--what-is-a-factory--factory-vs-repl", role: "learner", text: "We do not trust the model by default. The validation loop and up-front harness investment allow more autonomy while keeping small human-controlled next steps." }
  ];
  return input;
}

function lesson001Fixture(input: AuthoredWorkbookScenarioGateInput): AuthoredWorkbookScenarioGateInput {
  input.trace.terminalTranscript = [
    { blockId: "lesson--001-run-an-agent-headlessly--run-simple-pi-prompt", direction: "input", text: lesson001SimpleCommand },
    { blockId: "lesson--001-run-an-agent-headlessly--run-simple-pi-prompt", direction: "output", text: "Paris\n" },
    { blockId: "lesson--001-run-an-agent-headlessly--run-supplied-command", direction: "input", text: lesson001SuppliedCommand },
    { blockId: "lesson--001-run-an-agent-headlessly--run-supplied-command", direction: "output", text: "Calculator files described\n" },
    { blockId: "lesson--001-run-an-agent-headlessly--change-job", direction: "input", text: lesson001ChangedJobCommand },
    { blockId: "lesson--001-run-an-agent-headlessly--change-job", direction: "output", text: "Files listed\n" }
  ];
  input.trace.reflections = [{ blockId: "lesson--001-run-an-agent-headlessly--reflection", role: "learner", text: "The quoted input is the job. The pipe, subshell, cd, and Pi invocation are the harness. -p and --no-session make it exit with no conversation. read, grep, find, and ls can inspect but cannot edit, write, or mutate the calculator." }];
  input.trace.progressionEvents = [
    event("workbook_introduction_completed"),
    accepted("001-run-an-agent-headlessly", "lesson--001-run-an-agent-headlessly--run-simple-pi-prompt", "terminal"),
    accepted("001-run-an-agent-headlessly", "lesson--001-run-an-agent-headlessly--run-supplied-command", "terminal"),
    accepted("001-run-an-agent-headlessly", "lesson--001-run-an-agent-headlessly--change-job", "terminal"),
    event("reflection_completed", "001-run-an-agent-headlessly", "lesson--001-run-an-agent-headlessly--reflection")
  ];
  input.trace.publicStates = [
    publicStateWithTerminalRevision("lesson--001-run-an-agent-headlessly--run-simple-pi-prompt", 1),
    publicStateWithTerminalRevision("lesson--001-run-an-agent-headlessly--run-supplied-command", 1),
    publicStateWithTerminalRevision("lesson--001-run-an-agent-headlessly--change-job", 1)
  ];
  input.rawEvents = [
    rawSubmitted("a1", "001-run-an-agent-headlessly", "lesson--001-run-an-agent-headlessly--run-simple-pi-prompt", lesson001SimpleCommand),
    rawFinished("a1", 0),
    rawAccepted("a1", "001-run-an-agent-headlessly", "lesson--001-run-an-agent-headlessly--run-simple-pi-prompt", 1),
    rawSubmitted("a2", "001-run-an-agent-headlessly", "lesson--001-run-an-agent-headlessly--run-supplied-command", lesson001SuppliedCommand),
    rawFinished("a2", 0),
    rawAccepted("a2", "001-run-an-agent-headlessly", "lesson--001-run-an-agent-headlessly--run-supplied-command", 1),
    rawSubmitted("a3", "001-run-an-agent-headlessly", "lesson--001-run-an-agent-headlessly--change-job", lesson001ChangedJobCommand),
    rawFinished("a3", 0),
    rawAccepted("a3", "001-run-an-agent-headlessly", "lesson--001-run-an-agent-headlessly--change-job", 1)
  ];
  input.facts.lesson001CalculatorBeforeSha256 = "same";
  input.facts.lesson001CalculatorAfterSha256 = "same";
  return input;
}

async function lessons003004Fixture(input: AuthoredWorkbookScenarioGateInput): Promise<AuthoredWorkbookScenarioGateInput> {
  const validatorPrompt = await readFile(resolve(realPrerequisitesRoot, "lesson-004-prerequisites/factory/refactor-validate.md"), "utf8");
  const validatorScript = await readFile(resolve(realPrerequisitesRoot, "lesson-004-prerequisites/factory/refactor-validate.sh"), "utf8");
  const baseline = "Findings reported by: eslint.\n- calculator/src/index.ts duplicated operator branch parser\n";
  input.facts.expectedCommandStubRunId = "123e4567-e89b-42d3-a456-426614174000";
  input.facts.expectedCanonicalBaselineContent = baseline;
  input.facts.expectedCanonicalBaselineSha256 = sha256Text(baseline);
  input.facts.calculatorBehaviorTimeline = [{
    label: "after-multiply-only",
    sourceSha256: "intermediate-sha",
    testStatus: "passed",
    cases: [{ input: "multiply 6 by 7", output: 42 }]
  }];
  input.facts.calculatorBehaviorProjection = {
    label: "final",
    sourceSha256: sha256Text(completedSource),
    testStatus: "passed",
    cases: [{ input: "multiply 6 by 7", output: 42 }, { input: "divide 84 by 2", output: 42 }]
  };
  input.trace.progressionEvents = [
    event("workbook_introduction_completed"),
    accepted("003-build-a-validator", "lesson--003-build-a-validator--implementation-order", "terminal"),
    event("reflection_completed", "003-build-a-validator", "lesson--003-build-a-validator--checks"),
    event("lesson_transitioned", "004-feed-the-findings-back", "lesson--004-feed-the-findings-back--key-concept"),
    accepted("004-feed-the-findings-back", "lesson--004-feed-the-findings-back--implementation-order", "terminal"),
    event("reflection_completed", "004-feed-the-findings-back", "lesson--004-feed-the-findings-back--checks")
  ];
  input.trace.terminalTranscript = [
    { blockId: "lesson--003-build-a-validator--implementation-order", direction: "input", text: "export PATH=/stubs:$PATH\ncat refactor-validate.md \\\n  | (cd ../calculator && pi --no-session --tools read,grep,find,ls,bash -p)" },
    { blockId: "lesson--003-build-a-validator--implementation-order", direction: "observer", text: "Feedback: carry the baseline with a guard and tee findings." },
    { blockId: "lesson--003-build-a-validator--implementation-order", direction: "input", text: "export PATH=/stubs:$PATH\ncat refactor-validate.md .tmp/refactor-quality-before.txt \\\n  | (cd ../calculator && pi --no-session --tools read,grep,find,ls,bash -p)" },
    { blockId: "lesson--003-build-a-validator--implementation-order", direction: "output", text: "Starting validation...\nVERDICT: FAIL\n\n=== VALIDATOR MECHANICS (from factory/refactor-validate.sh) ===\nMechanic: missing-baseline guard\n6:if [ ! -f .tmp/refactor-quality-before.txt ]; then\nMechanic: baseline concatenated into validation\n11:cat refactor-validate.md .tmp/refactor-quality-before.txt \\\nMechanic: exact read-only tools\n--tools read,grep,find,ls,bash -p\nMechanic: findings captured through tee\n13:  | tee .tmp/refactor-validate-findings.txt\n" },
    { blockId: "lesson--004-feed-the-findings-back--implementation-order", direction: "input", text: "export PATH=/stubs:$PATH\n" + lesson004WrongCommand },
    { blockId: "lesson--004-feed-the-findings-back--implementation-order", direction: "observer", text: "Feedback: rerunning the validator only preserves the baseline but does not append findings to the doer context." },
    { blockId: "lesson--004-feed-the-findings-back--implementation-order", direction: "input", text: "export PATH=/stubs:$PATH\n" + lesson004MultiplyCommand },
    { blockId: "lesson--004-feed-the-findings-back--implementation-order", direction: "observer", text: "Feedback: multiply is fixed but divide still has duplicated branch parser findings." },
    { blockId: "lesson--004-feed-the-findings-back--implementation-order", direction: "input", text: "export PATH=/stubs:$PATH\n" + lesson004DivideCommand }
  ];
  input.trace.reflections = [
    { blockId: "lesson--003-build-a-validator--checks", role: "learner", text: "The validator announces, uses read-only tools plus bash, never edit/write, starts with VERDICT, quotes evidence, tees findings, and refuses without a baseline." },
    { blockId: "lesson--004-feed-the-findings-back--checks", role: "learner", text: "I chose when to rerun, carried findings into context, preserved the baseline, and decided when to stop." }
  ];
  input.commandInvocations = [
    stub("doer", { mutation: "partial-refactor" }),
    stub("validator", { verdict: "FAIL", mutation: "none", tools: "read,grep,find,ls,bash" }),
    stub("validator", { verdict: "FAIL", mutation: "none", tools: "read,grep,find,ls,bash" }),
    stub("validator", { verdict: "FAIL", mutation: "none", tools: "read,grep,find,ls,bash" }),
    stub("validator", { verdict: "FAIL", mutation: "none", tools: "read,grep,find,ls,bash" }),
    stub("repair", { mutation: "complete-refactor" }),
    stub("validator", { verdict: "PASS", mutation: "none", tools: "read,grep,find,ls,bash" })
  ];
  setSnapshots(input, {
    "factory/refactor-validate.md": validatorPrompt,
    "factory/refactor-validate.sh": validatorScript,
    "factory/.tmp/refactor-quality-before.txt": baseline,
    "factory/.tmp/refactor-validate-findings.txt": "VERDICT: PASS\n\nEVIDENCE:\n- quality passed\n",
    "calculator/src/index.ts": completedSource
  });
  return input;
}

function evidenceSection(evidence: string, headerName: string): string {
  const header = `=== ${headerName} ===`;
  const start = evidence.indexOf(header);
  if (start < 0) throw new Error(`missing evidence section ${headerName}`);
  const bodyStart = start + header.length;
  const next = evidence.slice(bodyStart).search(/\n=== [^\n]+ ===/);
  return evidence.slice(bodyStart, next < 0 ? undefined : bodyStart + next).trim();
}

function helperOnlyCompleteEvidence(testOutput: string): string {
  return `=== QUALITY BEFORE (recorded before the doer ran) ===
Findings reported by: eslint.
- calculator/src/index.ts duplicated operator branch parser

=== QUALITY NOW ===
Findings reported by: eslint, knip.

=== TESTS ===
${testOutput}
=== WORKING DIFF ===
+    const readFirstOperand = (separator: "and" | "from" | "by"): number => {
+      const first = readFirstOperand("and");
+      const first = readFirstOperand("from");
+      const first = readFirstOperand("by");
+      const first = readFirstOperand("by");
-      const first = read();
-      const first = read();
-      const first = read();
-      const first = read();
-      if (pieces[place++] !== "and") fail();
-      if (pieces[place++] !== "from") fail();
-      if (pieces[place++] !== "by") fail();
-      if (pieces[place++] !== "by") fail();
`;
}

function lesson013Fixture(input: AuthoredWorkbookScenarioGateInput): AuthoredWorkbookScenarioGateInput {
  input.facts.expectedCommandStubRunId = "123e4567-e89b-42d3-a456-426614174000";
  input.facts.calculatorHeadChanged = true;
  input.facts.calculatorGitStatus = "";
  input.facts.calculatorTopCommit = "commit-lesson013-current";
  input.facts.calculatorExpectedTopCommit = "commit-lesson013-current";
  input.facts.calculatorTopCommitTree = "tree-lesson013-current";
  input.facts.calculatorExpectedTopCommitTree = "tree-lesson013-current";
  input.facts.calculatorCommitSubjects = ["Refactor calculator operand parsing"];
  input.facts.calculatorBehaviorProjection = {
    label: "final",
    sourceSha256: sha256Text(completedSource),
    gitTree: "tree-lesson013-current",
    testStatus: "passed",
    qualityStatus: "failed",
    qualityOutput: "Findings reported by: eslint, knip.",
    cases: [{ input: "multiply 6 by 7", output: 42 }, { input: "divide 84 by 2", output: 42 }]
  };
  input.trace.progressionEvents = [
    event("workbook_introduction_completed"),
    accepted("013-oversee-the-orchestrator", "lesson--013-oversee-the-orchestrator--implementation-order", "terminal"),
    event("reflection_completed", "013-oversee-the-orchestrator", "lesson--013-oversee-the-orchestrator--checks")
  ];
  input.trace.terminalTranscript = [
    { blockId: "lesson--013-oversee-the-orchestrator--implementation-order", direction: "input", text: "export PATH=/stubs:$PATH\n./factory/refactor/run.sh > .tmp/refactor-run.log 2>&1 &\n./factory/steer.sh refactor \"Finish multiply and divide independently before validation.\"\n./factory/watch.sh refactor > .tmp/refactor-watch.log 2>&1 &\necho \"=== RUN LOG (tail) ===\"\ntail -n 80 .tmp/refactor-run.log\nprintf '\\n'\necho \"=== WATCH LOG (tail) ===\"\ntail -n 80 .tmp/refactor-watch.log\nprintf '\\n'\necho \"=== ASK SUMMARY ===\"\n./factory/ask.sh refactor \"What happened in this run?\"" },
    { blockId: "lesson--013-oversee-the-orchestrator--implementation-order", direction: "output", text: "=== RUN LOG (tail) ===\nStarting doer\nStarting validation\nStarting commit\nLine finished after 1 iterations.\n=== WATCH LOG (tail) ===\n→ read\nauthored-eval accepted early steer\n→ edit\n=== ASK SUMMARY ===\nThe supplied record contains deterministic authored-eval structural events with zero recorded cost.\n\nFrom the supplied record: factory/ is the factory root, refactor/ is the assembly line, and factory/refactor/run.sh is the orchestrator. The line uses prompt/script station pairs for doer, validator, repair, and commit work, while ask.sh is a no-tools station that answers from the event record. run.sh handles routing between stations, carries TESTS/QUALITY/DIFF evidence into validation, branches on VERDICT to repair or commit, and stopped after PASS or its failure/iteration bounds. The operator starts the line, watches the bounded record, asks what happened, and keeps judgement over cost, regressions, and whether the result is worth it.\n" }
  ];
  input.trace.reflections = [{ blockId: "lesson--013-oversee-the-orchestrator--checks", role: "learner", text: "The factory is factory/. The line is refactor/. The orchestrator is run.sh: it starts the line, hands inputs to stations, branches on VERDICT, handles failures with repair, and stops by counters. Prompt/script pairs are stations. ask.sh is no-tools because the record is supplied. I am the operator. Repeated FAIL can mean an unmet criterion or missing/unreachable evidence. Cost, regressions, and whether the result is worth it are still operator judgement." }];
  input.commandInvocations = [
    stub("doer", { mode: "rpc", mutation: "complete-refactor", rpc: true, rpcOverrides: { commandCount: 2, earlySteerCount: 1, steerBytes: Buffer.byteLength("Finish multiply and divide independently before validation.", "utf8"), steerSha256: sha256Text(sha256Text("Finish multiply and divide independently before validation.")) } }),
    stub("validator", { mode: "json", verdict: "PASS", mutation: "none" }),
    stub("commit", { mode: "json", mutation: "none" }),
    stub("ask", { mode: "text", tools: "none", mutation: "none" })
  ];
  setSnapshots(input, {
    ".tmp/refactor-run.log": "Starting doer\nStarting validation\nStarting commit\nLine finished after 1 iterations.\n",
    ".tmp/refactor-watch.log": "→ read\nauthored-eval accepted early steer\n→ edit\n",
    "factory/refactor/.tmp/quality-before.txt": "Findings reported by: eslint.\n",
    "factory/refactor/.tmp/evidence.txt": helperOnlyCompleteEvidence("Tests: PASS\nauthored-eval npm test stub: calculator tests passed without network.\n"),
    "factory/refactor/.tmp/validate-findings.txt": "VERDICT: PASS\n\nFINDINGS:\n- [PASS] tests passed, quality evidence was present, and the diff demonstrated the fewest-elements refactor.\n",
    "factory/refactor/.tmp/commit-message.txt": "Refactor calculator operand parsing\n\nUse a shared operand reader across prefix operator branches.",
    "calculator/src/index.ts": completedSource
  });
  return input;
}

function event(type: AuthoredWorkbookEvalTrace["progressionEvents"][number]["type"], lessonId?: string, blockId?: string): AuthoredWorkbookEvalTrace["progressionEvents"][number] {
  if (type === "workbook_introduction_completed") return { type };
  return { type, lessonId: lessonId ?? "lesson", blockId: blockId ?? "block" } as AuthoredWorkbookEvalTrace["progressionEvents"][number];
}

function accepted(lessonId: string, blockId: string, kind: "terminal" | "reflection" | "editor"): AuthoredWorkbookEvalTrace["progressionEvents"][number] {
  return { type: "attempt_accepted", lessonId, blockId, kind };
}

function snapshots(values: Record<string, string>): AuthoredWorkbookEvalArtifactSnapshot[] {
  return Object.entries(values).map(([path, content]) => ({ path, content }));
}

function setSnapshots(input: AuthoredWorkbookScenarioGateInput, values: Record<string, string>): void {
  const value = snapshots(values);
  input.artifactSnapshots = structuredClone(value);
  input.workspaceFileSnapshots = structuredClone(value);
  input.trace.artifacts = structuredClone(value);
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function publicStateWithTerminalRevision(blockId: string, terminalRevision: number): AuthoredWorkbookEvalTrace["publicStates"][number] {
  return {
    label: `${blockId}:${terminalRevision}`,
    state: {
      workbook: { title: "Synthetic public workbook" },
      introduction: "Intro",
      introductionComplete: true,
      chapters: [],
      progress: {
        activeLessonId: "001-run-an-agent-headlessly",
        activeBlockId: blockId,
        completedLessons: [],
        blocks: [{ id: blockId, ready: true, active: false, completed: true, verified: true, emerged: true, terminalRevision, checkpoint: { status: "accepted", evidence: { kind: "terminal", text: "ok" } }, terminal: { phase: "complete", message: "ok" } }],
        reflections: {},
        reflectionConversations: {}
      },
      adapter: {},
      timeline: []
    }
  } as AuthoredWorkbookEvalTrace["publicStates"][number];
}

function rawSubmitted(attemptId: string, lessonId: string, blockId: string, command: string): any {
  return { type: "terminal-command-submitted", attemptId, lessonId, blockId, command, terminalSessionId: `${attemptId}-terminal` };
}

function rawFinished(attemptId: string, exitStatus: number): any {
  return { type: "terminal-command-finished", attemptId, exitStatus, evidenceRef: `${attemptId}-evidence` };
}

function rawAccepted(attemptId: string, lessonId: string, blockId: string, version: number): any {
  return { type: "attempt_accepted", attemptId, lessonId, blockId, version, kind: "terminal", summary: "accepted" };
}

async function tempCapableWorkspace(prefix = "authored-prereq-repository-"): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(repository);
  const workspace = join(repository, "sessions/session-1/workspaces/refactor-line");
  await mkdir(workspace, { recursive: true });
  await mkdir(join(repository, "tutorial"), { recursive: true });
  return workspace;
}

function capabilityFor(workspace: string): AuthoredCurriculumSliceSessionCapability {
  const repositoryRoot = workspace.slice(0, workspace.indexOf("/sessions/session-1/workspaces/refactor-line"));
  return Object.freeze({
    kind: "authored-curriculum-slice-session-capability",
    repositoryRoot,
    contentRoot: join(repositoryRoot, "tutorial"),
    sourceTutorialRoot: resolve(import.meta.dirname, "../../../tutorial"),
    learnerWorkspaceRoots: Object.freeze([workspace])
  });
}

function stub(station: AuthoredCommandInvocationEvidence["station"], options: { mode?: "text" | "json" | "rpc"; tools?: AuthoredCommandInvocationEvidence["tools"]; verdict?: "PASS" | "FAIL"; mutation?: AuthoredCommandInvocationEvidence["mutation"]; rpc?: boolean; rpcOverrides?: Partial<NonNullable<AuthoredCommandInvocationEvidence["rpc"]>> } = {}): AuthoredCommandInvocationEvidence {
  const mode = options.mode ?? "text";
  return {
    namespace: AUTHORED_COMMAND_STUB_NAMESPACE,
    owner: AUTHORED_COMMAND_STUB_OWNER,
    schemaVersion: AUTHORED_COMMAND_STUB_SCHEMA_VERSION,
    runId: "123e4567-e89b-42d3-a456-426614174000",
    kind: "pi",
    accepted: true,
    cwd: station === "ask" ? "factory" : "calculator",
    mode,
    tools: options.tools ?? (station === "validator" ? "read,grep,find,ls" : "read,edit,write,grep,find,ls"),
    station,
    ...(options.verdict === undefined ? {} : { verdict: options.verdict }),
    mutation: options.mutation ?? "none",
    ...(mode === "rpc" || options.rpc ? { rpc: { commandCount: 1, promptBytes: 10, promptSha256: "a".repeat(64), earlySteerCount: 0, lateSteerCount: 0, steerBytes: 0, steerSha256: "b".repeat(64), ...(options.rpcOverrides ?? {}) } } : { prompt: { bytes: 10, sha256: "a".repeat(64), signals: [] } }),
    output: { bytes: 10, sha256: "c".repeat(64), eventClasses: mode === "rpc" ? [...lesson013RpcEventClasses] : mode === "json" ? ["message_end", "agent_end"] : ["text"] }
  };
}

async function expectMutationsFail(id: AuthoredWorkbookScenarioId, mutations: Array<[string, (input: AuthoredWorkbookScenarioGateInput) => void]>): Promise<void> {
  const scenario = authoredWorkbookScenarioById(id);
  expect(scenario.gate(await passingFixture(id)).passed).toBe(true);
  for (const [name, mutate] of mutations) {
    const fixture = cloneInput(await passingFixture(id));
    mutate(fixture);
    expect(scenario.gate(fixture).passed, name).toBe(false);
  }
}

function cloneInput(input: AuthoredWorkbookScenarioGateInput): AuthoredWorkbookScenarioGateInput {
  return structuredClone(input) as AuthoredWorkbookScenarioGateInput;
}

async function liveScenarioHarness(id: AuthoredWorkbookScenarioId, stubOptions: Partial<Parameters<typeof createAuthoredCommandStubs>[0]> = {}): Promise<{ workspace: Awaited<ReturnType<typeof createAuthoredCurriculumSliceWorkspace>>; sessionWorkspace: string; handle: Awaited<ReturnType<typeof createAuthoredCommandStubs>>; commands: string[] }> {
  const scenario = authoredWorkbookScenarioById(id);
  const workspace = await createAuthoredCurriculumSliceWorkspace({
    selection: scenario.selection,
    prerequisiteOverlays: scenario.prerequisiteOverlay ? [scenario.prerequisiteOverlay] : [],
    dependencies: { startWorkbookServer: async () => ({ url: "http://127.0.0.1:1", port: 1, host: "127.0.0.1", close: async () => {} }) }
  });
  tempRoots.push(workspace.repositoryRoot);
  const server = await workspace.startServer({ embeddedTerminal: false });
  await server.close();
  const sessionWorkspace = workspace.latestSession().workspaceRoots["refactor-line"]!;
  const handle = await createAuthoredCommandStubs({ lessonNumber: scenario.stubLessonNumber!, workspaceRoot: sessionWorkspace, scenarioId: id, ...stubOptions });
  const recorder = new RecordingDriver();
  await scenario.drive({ driver: recorder });
  return { workspace, sessionWorkspace, handle, commands: recorder.calls.filter((call) => call.method === "submitTerminalCommand").map((call) => call.command!) };
}

function stripActivation(command: string): string {
  return command.replace(/^export AUTHORED_EVAL_COMMAND_STUB_CONFIG=.*\n/, "").replace(/^export PATH=.*\n/, "");
}

function hostCommandStubActivation(handle: Awaited<ReturnType<typeof createAuthoredCommandStubs>>): string {
  return `export AUTHORED_EVAL_COMMAND_STUB_CONFIG=${shellQuote(handle.hostConfigPath)}; export AUTHORED_EVAL_NO_NETWORK=1; export npm_config_offline=true; export npm_config_ignore_scripts=true; export npm_config_audit=false; export npm_config_fund=false; export npm_config_update_notifier=false; export npm_config_yes=false; export PATH=${shellQuote(handle.hostBinDir)}:"$PATH"`;
}

function stubbedShellEnv(handle: Awaited<ReturnType<typeof createAuthoredCommandStubs>>): NodeJS.ProcessEnv {
  const path = `${handle.hostBinDir}:${dirname(process.execPath)}:/usr/bin:/bin`;
  return { ...handle.hostEnv, PATH: path, STUBBED_PATH: path };
}

async function execShell(command: string, cwd: string, env: NodeJS.ProcessEnv, timeout: number): Promise<string> {
  const shellCommand = `export PATH=${shellQuote(env.STUBBED_PATH ?? env.PATH ?? "")}; ${command}`;
  const { stdout, stderr } = await execFileAsync("/bin/bash", ["-lc", shellCommand], { cwd, env, timeout, encoding: "utf8", maxBuffer: 1024 * 1024 });
  const output = `${stdout}\n${stderr}`;
  expect(output).not.toMatch(/authored-eval command stub rejected|Doer did not start/);
  return output;
}

function lesson013RunTrace(command: string, output: string): AuthoredWorkbookEvalSessionTrace {
  const trace = createEmptyAuthoredWorkbookEvalSessionTrace("lesson-013-operator-judgement");
  trace.terminalTranscript = [
    { blockId: "lesson--013-oversee-the-orchestrator--implementation-order", direction: "input", text: command },
    { blockId: "lesson--013-oversee-the-orchestrator--implementation-order", direction: "output", text: output }
  ];
  trace.reflections = [{ blockId: "lesson--013-oversee-the-orchestrator--checks", role: "learner", text: "The factory is factory/. The line is refactor/. The orchestrator is run.sh: it starts the line, hands inputs to stations, branches on VERDICT, handles failures with repair, and stops by counters. Prompt/script pairs are stations. ask.sh is no-tools because the record is supplied. I am the operator. Repeated FAIL can mean an unmet criterion or missing/unreachable evidence. Cost, regressions, and whether the result is worth it are still operator judgement." }];
  return trace;
}

function expectLesson013VisibleOutput(output: string): void {
  expect(output).toContain("=== RUN LOG (tail) ===");
  expect(output).toContain("Starting doer");
  expect(output).toContain("=== WATCH LOG (tail) ===");
  expect(output).toContain("→ read");
  expect(output).toContain("authored-eval");
  expect(output).toContain("→ edit");
  expect(output).toContain("=== ASK SUMMARY ===");
  expect(output).toContain("deterministic authored-eval structural events");
  for (const term of ["factory/", "refactor/", "factory/refactor/run.sh", "orchestrator", "prompt/script station pairs", "operator", "routing", "evidence", "stopped after PASS"]) {
    expect(output).toContain(term);
  }
  expect(output).not.toMatch(/AUTHORED_EVAL_COMMAND_STUB_CONFIG|authored-eval-command-stubs\/container-config|\/var\/folders|\/private\/tmp|Finish multiply and divide independently/);
}

async function expectLesson013StubbedResult(sessionWorkspace: string, evidencePath: string): Promise<void> {
  const evidence = await readAuthoredCommandStubEvidence(evidencePath);
  expect(evidence.filter((entry) => entry.accepted && entry.kind === "pi").map((entry) => [entry.station, entry.mode, entry.verdict ?? entry.mutation])).toEqual([
    ["doer", "rpc", "complete-refactor"],
    ["validator", "json", "PASS"],
    ["commit", "json", "none"],
    ["ask", "text", "none"]
  ]);
  const doer = evidence.find((entry) => entry.station === "doer" && entry.mode === "rpc");
  expect(doer?.rpc).toMatchObject({ commandCount: 2, earlySteerCount: 1, lateSteerCount: 0 });
  expect(doer?.output?.eventClasses).toEqual(lesson013RpcEventClasses);
  expect(await readFile(join(sessionWorkspace, "factory/refactor/.tmp/validate-findings.txt"), "utf8")).toMatch(/^VERDICT: PASS/m);
  expect(await readFile(join(sessionWorkspace, "factory/refactor/.tmp/evidence.txt"), "utf8")).toMatch(/=== QUALITY NOW ===[\s\S]*(Findings reported by:|is not installed\. Run npm install\.|could not run:|All quality checks passed\.)/m);
  const status = (await execFileAsync("git", ["-C", join(sessionWorkspace, "calculator"), "status", "--porcelain"], { encoding: "utf8" })).stdout;
  const subject = (await execFileAsync("git", ["-C", join(sessionWorkspace, "calculator"), "log", "-1", "--pretty=%s"], { encoding: "utf8" })).stdout.trim();
  expect(status).toBe("");
  expect(subject).toBe("Refactor calculator operand parsing");
}

async function execDockerWithPrivateInput(args: string[], input: Buffer, timeout = 20_000): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("docker command timed out"));
    }, timeout);
    const appendBounded = (target: Buffer[], chunk: Buffer) => {
      if (Buffer.concat(target).length < 16_384) target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => appendBounded(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => appendBounded(stderr, chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const output = `${Buffer.concat(stdout).toString("utf8")}\n${Buffer.concat(stderr).toString("utf8")}`;
      code === 0 ? resolvePromise(output) : reject(new Error(`docker ${args.slice(0, 4).join(" ")} exited ${code}: ${output.slice(0, 512)}`));
    });
    child.stdin.end(input);
  });
}

function dockerLesson013SmokeScript(activation: string, command: string): string {
  return `${activation}\nset -euo pipefail\necho smoke:check-tools >&2\ncommand -v jq >/dev/null\ntest "$(command -v pi)" = /workspace/factory/.tmp/authored-eval-command-stubs/bin/pi\ntest "$(command -v npm)" = /workspace/factory/.tmp/authored-eval-command-stubs/bin/npm\nif ! git -C calculator rev-parse --show-toplevel >/dev/null 2>&1; then\n  rm -rf .git calculator/.git\n  git -C calculator init -q -b main\n  git -C calculator config user.name 'Tutorial Factory Worker'\n  git -C calculator config user.email 'factory-worker@example.invalid'\n  git -C calculator add -A\n  git -C calculator commit -qm 'Materialize tutorial workspace refactor-line'\nfi\necho smoke:run-command >&2\nset +e\nbash <<'AUTHORED_COMMAND'\n${command}\nAUTHORED_COMMAND\ncommand_status=$?\nset -e\necho smoke:wait:$command_status >&2\nfor _ in $(seq 1 20); do\n  [ -s /workspace/factory/refactor/.tmp/commit-message.txt ] && break\n  sleep 1\ndone\nif [ ! -s /workspace/factory/refactor/.tmp/commit-message.txt ]; then\n  echo smoke:run-log >&2\n  cat /workspace/.tmp/refactor-run.log >&2 2>/dev/null || true\nfi\njobs -pr | xargs -r kill 2>/dev/null || true\necho smoke:assert >&2\nnode --input-type=module <<'NODE'\n${dockerLesson013SmokeAssertions()}\nNODE\n`;
}

function dockerLesson013SmokeAssertions(): string {
  return String.raw`import { readFileSync } from 'node:fs';
function fail(message) { console.error(message); process.exit(1); }
const lines = readFileSync('/workspace/factory/.tmp/authored-eval-command-stubs/invocations.jsonl', 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
const pi = lines.filter((entry) => entry.kind === 'pi' && entry.accepted);
const sequence = pi.map((entry) => [entry.station, entry.mode, entry.verdict ?? entry.mutation]);
const expected = [['doer', 'rpc', 'complete-refactor'], ['validator', 'json', 'PASS'], ['commit', 'json', 'none'], ['ask', 'text', 'none']];
if (JSON.stringify(sequence) !== JSON.stringify(expected)) fail('bad sequence ' + JSON.stringify(sequence));
const doer = pi.find((entry) => entry.station === 'doer' && entry.mode === 'rpc');
if (!doer?.rpc || doer.rpc.commandCount !== 2 || doer.rpc.earlySteerCount !== 1 || doer.rpc.lateSteerCount !== 0) fail('bad rpc ' + JSON.stringify(doer?.rpc));
const rpcClasses = ['response', 'queue_update', 'tool_execution_start', 'message_update', 'message_end', 'agent_end'];
if (JSON.stringify(doer.output?.eventClasses) !== JSON.stringify(rpcClasses)) fail('bad rpc classes ' + JSON.stringify(doer.output?.eventClasses));
const npm = lines.filter((entry) => entry.kind === 'npm' && entry.accepted);
if (npm.length !== 1 || !readFileSync('/workspace/factory/refactor/.tmp/evidence.txt', 'utf8').includes('authored-eval npm test stub')) fail('bad npm ' + npm.length);
if (!readFileSync('/workspace/factory/refactor/.tmp/validate-findings.txt', 'utf8').startsWith('VERDICT: PASS\n')) fail('bad findings');
if (!readFileSync('/workspace/factory/refactor/.tmp/commit-message.txt', 'utf8').startsWith('Refactor calculator operand parsing\n')) fail('bad commit message');
`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function mutateSnapshot(input: AuthoredWorkbookScenarioGateInput, path: string, mutate: (text: string) => string): void {
  const snapshots = [...input.artifactSnapshots, ...input.workspaceFileSnapshots, ...input.trace.artifacts].filter((entry) => entry.path === path);
  if (snapshots.length === 0) throw new Error(`missing snapshot ${path}`);
  for (const snapshot of snapshots) snapshot.content = mutate(snapshot.content);
}

function mutateCalculatorSourceAndTrustDigest(input: AuthoredWorkbookScenarioGateInput, mutate: (text: string) => string): void {
  mutateSnapshot(input, "calculator/src/index.ts", (text) => {
    const next = mutate(text);
    input.facts.calculatorBehaviorProjection!.sourceSha256 = sha256Text(next);
    return next;
  });
}

function sourceWithFakeRefactor(source: string, wrap: (fake: string) => string): string {
  const helper = readFirstOperandHelperSource();
  const starter = source
    .replace(helper, "")
    .replace('      const first = readFirstOperand("and");', '      const first = read();\n      if (pieces[place++] !== "and") fail();')
    .replace('      const first = readFirstOperand("from");', '      const first = read();\n      if (pieces[place++] !== "from") fail();')
    .replaceAll('      const first = readFirstOperand("by");', '      const first = read();\n      if (pieces[place++] !== "by") fail();');
  const fake = `${helper}
    if (word === "multiply") {
      const first = readFirstOperand("by");
      const second = read();
      return first * second;
    }

    if (word === "divide") {
      const first = readFirstOperand("by");
      const second = read();
      if (second === 0) fail();
      return first / second;
    }`;
  return `${starter}\n${wrap(fake)}\n`;
}

function readFirstOperandHelperSource(): string {
  return `    const readFirstOperand = (separator: "and" | "from" | "by"): number => {
      const first = read();
      if (pieces[place++] !== separator) fail();
      return first;
    };
`;
}

async function copyPrerequisitesRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "authored-prereq-root-"));
  tempRoots.push(root);
  await cp(realPrerequisitesRoot, root, { recursive: true });
  return root;
}
