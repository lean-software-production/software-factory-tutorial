import { execFile } from "node:child_process";
import { cp, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTHORED_COMMAND_STUB_NAMESPACE,
  AUTHORED_COMMAND_STUB_OWNER,
  AUTHORED_COMMAND_STUB_SCHEMA_VERSION,
  AUTHORED_STUB_RPC_EARLY_STEER_WINDOW_MS,
  createAuthoredCommandStubs,
  readAuthoredCommandStubEvidence,
  type AuthoredCommandInvocationEvidence
} from "../command-stubs.js";
import type { AuthoredWorkbookEvalArtifactSnapshot, AuthoredWorkbookEvalTrace } from "../types.js";
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
import { buildAuthoredWorkbookJudgePrompt, copyAuthoredWorkbookEvalScenarioPublicDescriptor } from "../judge.js";
import { createAuthoredCurriculumSliceWorkspace } from "../workspace.js";
import type { AuthoredCurriculumSliceSessionCapability } from "../workspace.js";
const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];
const realPrerequisitesRoot = resolve(import.meta.dirname, "../prerequisites");

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
${lesson004CurrentEvidenceAndValidationCommand}`;
const lesson004DivideCommand = String.raw`(cd factory \
  && cat refactor.md .tmp/refactor-validate-findings.txt \
  | (cd ../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p))
${lesson004CurrentEvidenceAndValidationCommand}`;

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
    expect(commands.some((command) => command.endsWith(lesson004WrongCommand))).toBe(true);
    expect(commands.some((command) => command.endsWith(lesson004MultiplyCommand))).toBe(true);
    expect(commands.some((command) => command.endsWith(lesson004DivideCommand))).toBe(true);
    expect(commands.every((command) => !command.startsWith("export PATH=") && !command.includes("AUTHORED_EVAL_COMMAND_STUB_CONFIG"))).toBe(true);

    const capstone = new RecordingDriver();
    await authoredWorkbookScenarioById("lesson-013-operator-judgement").drive({ driver: capstone });
    const capstoneCommand = capstone.calls.find((call) => call.method === "submitTerminalCommand")?.command ?? "";
    expect(capstoneCommand).toContain("./factory/refactor/run.sh > .tmp/refactor-run.log 2>&1 &");
    expect(capstoneCommand).toContain("./factory/watch.sh refactor > .tmp/refactor-watch.log 2>&1 &");
    expect(capstoneCommand).toContain("./factory/ask.sh refactor \"What happened in this run?\"");
    expect(capstoneCommand).toContain("./factory/steer.sh refactor \"Finish multiply and divide independently before validation.\"");
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

  it("mutation-tests primer gate assertions", async () => {
    await expectMutationsFail("primer-validation-misconception", [
      ["remove misconception", (input) => { input.trace.reflections = input.trace.reflections.filter((entry) => !entry.text.includes("trust/faith")); }],
      ["remove tutor feedback", (input) => { input.trace.reflections = input.trace.reflections.filter((entry) => entry.role !== "tutor"); }],
      ["remove validation repair", (input) => { input.trace.reflections.find((entry) => entry.role === "learner" && entry.text.includes("up-front"))!.text = "I now agree."; }],
      ["add unexpected artifact", (input) => { input.artifactSnapshots = [{ path: "factory/.tmp/unexpected.txt", content: "unexpected" }]; }],
      ["mark stubs created", (input) => { input.facts.commandStubsCreated = true; }],
      ["mark source changed", (input) => { input.facts.authoredSourceChanged = true; }],
      ["inject lesson jump", (input) => { input.facts.lessonJumpStarted = true; }],
      ["inject raw lesson jump", (input) => { input.rawEvents = [{ type: "lesson_jump_started", lessonId: "copied" } as any]; }]
    ]);
  });

  it("mutation-tests Lesson 001 gate assertions", async () => {
    await expectMutationsFail("lesson-001-headless-boundary", [
      ["add unexpected artifact", (input) => { input.artifactSnapshots = [{ path: "factory/.tmp/unexpected.txt", content: "unexpected" }]; }],
      ["remove simple command", (input) => { input.trace.terminalTranscript = input.trace.terminalTranscript.filter((entry) => !entry.text.includes("capital of France")); }],
      ["change supplied command", (input) => { input.trace.terminalTranscript.find((entry) => entry.text === lesson001SuppliedCommand)!.text = lesson001SuppliedCommand.replace("read,grep,find,ls", "read,edit,write"); }],
      ["swap order", (input) => { const rows = input.trace.terminalTranscript; [rows[0], rows[2]] = [rows[2]!, rows[0]!]; }],
      ["remove reflection boundary", (input) => { input.trace.reflections[0]!.text = "The command ran."; }],
      ["mark stubs created", (input) => { input.facts.commandStubsCreated = true; }],
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

  it("mutation-tests Lessons 003-004 gate assertions", async () => {
    await expectMutationsFail("lessons-003-004-evidence-feedback", [
      ["lesson order missing", (input) => { input.trace.progressionEvents = input.trace.progressionEvents.filter((event) => !("lessonId" in event && event.lessonId === "004-feed-the-findings-back")); }],
      ["add unexpected artifact", (input) => { input.artifactSnapshots = [...input.artifactSnapshots, { path: "factory/.tmp/extra.txt", content: "extra" }]; }],
      ["remove guard", (input) => { mutateSnapshot(input, "factory/refactor-validate.sh", (text) => text.replace("if [ ! -f .tmp/refactor-quality-before.txt ]; then", "# missing guard")); }],
      ["remove tee", (input) => { mutateSnapshot(input, "factory/refactor-validate.sh", (text) => text.replace("| tee .tmp/refactor-validate-findings.txt", "")); }],
      ["change prompt", (input) => { mutateSnapshot(input, "factory/refactor-validate.md", (text) => text.replace("single refactoring", "large rewrite")); }],
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
      ["remove baseline", (input) => { mutateSnapshot(input, "factory/.tmp/refactor-quality-before.txt", () => ""); }],
      ["stale baseline digest", (input) => { input.facts.expectedCanonicalBaselineSha256 = "0".repeat(64); }],
      ["stale behavior projection", (input) => { input.facts.calculatorBehaviorProjection!.sourceSha256 = "0".repeat(64); }],
      ["mark source changed", (input) => { input.facts.authoredSourceChanged = true; }],
      ["mixed previous-run stub records", (input) => { input.commandInvocations[0]!.runId = "00000000-0000-0000-0000-000000000000"; }],
      ["raw lesson jump", (input) => { input.rawEvents = [{ type: "lesson_jump_started", lessonId: "copied" } as any]; }]
    ]);
  });

  it("mutation-tests Lesson 013 gate assertions", async () => {
    await expectMutationsFail("lesson-013-operator-judgement", [
      ["remove run command", (input) => { input.trace.terminalTranscript[0]!.text = "./factory/refactor/run.sh"; }],
      ["add unexpected artifact", (input) => { input.artifactSnapshots = [...input.artifactSnapshots, { path: "factory/refactor/.tmp/events/extra.jsonl", content: "{}" }]; }],
      ["remove rpc evidence", (input) => { input.commandInvocations = input.commandInvocations.map((entry) => entry.mode === "rpc" ? { ...entry, rpc: undefined } : entry); }],
      ["remove steer evidence", (input) => { input.commandInvocations = input.commandInvocations.map((entry) => entry.mode === "rpc" && entry.rpc ? { ...entry, rpc: { ...entry.rpc, earlySteerCount: 0, commandCount: 1 } } : entry); }],
      ["raw event artifact copied public", (input) => { input.artifactSnapshots = [...input.artifactSnapshots, { path: "factory/refactor/.tmp/events/extra.jsonl", content: "{}" }]; input.trace.artifacts = input.artifactSnapshots.map((snapshot) => ({ ...snapshot })); input.workspaceFileSnapshots = input.artifactSnapshots.map((snapshot) => ({ ...snapshot })); }],
      ["remove commit", (input) => { input.facts.calculatorHeadChanged = false; }],
      ["remove source completion", (input) => { mutateSnapshot(input, "calculator/src/index.ts", (text) => text.replace('const first = readFirstOperand("by");', 'const first = read();')); }],
      ["failed quality status", (input) => { input.facts.calculatorBehaviorProjection!.qualityStatus = "failed"; }],
      ["stale git top", (input) => { input.facts.calculatorTopCommitTree = "stale-tree"; }],
      ["remove run log", (input) => { mutateSnapshot(input, ".tmp/refactor-run.log", () => "Line finished"); }],
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
      for (const [index, command] of bodies.entries()) {
        await execShell(command, sessionWorkspace, stubbedShellEnv(handle), index === 4 ? 20_000 : 10_000);
        if (index === 1) {
          const baseline = await readFile(baselinePath, "utf8");
          expect(sha256Text(baseline)).toBe(sha256Text(await readFile(baselinePath, "utf8")));
        }
      }
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

  it("executes the Lesson 013 run/watch/ask/steer path with real RPC stubs and a clean exact commit", async () => {
    const { workspace, sessionWorkspace, handle, commands } = await liveScenarioHarness("lesson-013-operator-judgement", { rpcEarlySteerWindowMs: AUTHORED_STUB_RPC_EARLY_STEER_WINDOW_MS, rpcLateSteerWindowMs: 20 });
    try {
      expect(commands).toHaveLength(1);
      await execShell(stripActivation(commands[0]!), sessionWorkspace, stubbedShellEnv(handle), 20_000);
      const evidence = await readAuthoredCommandStubEvidence(handle.hostEvidencePath);
      expect(evidence.filter((entry) => entry.accepted && entry.kind === "pi").map((entry) => [entry.station, entry.mode, entry.verdict ?? entry.mutation])).toEqual([
        ["doer", "rpc", "complete-refactor"],
        ["validator", "json", "PASS"],
        ["commit", "json", "none"],
        ["ask", "text", "none"]
      ]);
      const doer = evidence.find((entry) => entry.station === "doer" && entry.mode === "rpc");
      expect(doer?.rpc).toMatchObject({ commandCount: 2, earlySteerCount: 1, lateSteerCount: 0 });
      expect(await readFile(join(sessionWorkspace, "factory/refactor/.tmp/validate-findings.txt"), "utf8")).toMatch(/^VERDICT: PASS/m);
      expect(await readFile(join(sessionWorkspace, "factory/refactor/.tmp/evidence.txt"), "utf8")).toMatch(/=== QUALITY NOW ===[\s\S]*All quality checks passed\./m);
      const status = (await execFileAsync("git", ["-C", join(sessionWorkspace, "calculator"), "status", "--porcelain"], { encoding: "utf8" })).stdout;
      const subject = (await execFileAsync("git", ["-C", join(sessionWorkspace, "calculator"), "log", "-1", "--pretty=%s"], { encoding: "utf8" })).stdout.trim();
      expect(status).toBe("");
      expect(subject).toBe("Refactor calculator operand parsing");
    } finally {
      await handle.close().catch(() => undefined);
      await workspace.close().catch(() => undefined);
      tempRoots.splice(tempRoots.indexOf(workspace.repositoryRoot), 1);
    }
  }, 30_000);
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
    event("reflection_completed", "what-is-a-factory", "lesson--what-is-a-factory--factory-vs-repl")
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
    qualityStatus: "passed",
    qualityOutput: "All quality checks passed.",
    cases: [{ input: "multiply 6 by 7", output: 42 }, { input: "divide 84 by 2", output: 42 }]
  };
  input.trace.progressionEvents = [
    event("workbook_introduction_completed"),
    accepted("013-oversee-the-orchestrator", "lesson--013-oversee-the-orchestrator--implementation-order", "terminal"),
    event("reflection_completed", "013-oversee-the-orchestrator", "lesson--013-oversee-the-orchestrator--checks")
  ];
  input.trace.terminalTranscript = [{ blockId: "lesson--013-oversee-the-orchestrator--implementation-order", direction: "input", text: "export PATH=/stubs:$PATH\n./factory/refactor/run.sh > .tmp/refactor-run.log 2>&1 &\n./factory/steer.sh refactor \"Finish multiply and divide independently before validation.\"\n./factory/watch.sh refactor > .tmp/refactor-watch.log 2>&1 &\n./factory/ask.sh refactor \"What happened in this run?\"" }];
  input.trace.reflections = [{ blockId: "lesson--013-oversee-the-orchestrator--checks", role: "learner", text: "The factory is factory/. The line is refactor/. The orchestrator is run.sh: it starts the line, hands inputs to stations, branches on VERDICT, handles failures with repair, and stops by counters. Prompt/script pairs are stations. ask.sh is no-tools because the record is supplied. I am the operator. Repeated FAIL can mean an unmet criterion or missing/unreachable evidence. Cost, regressions, and whether the result is worth it are still operator judgement." }];
  input.commandInvocations = [
    stub("doer", { mode: "rpc", mutation: "complete-refactor", rpc: true, rpcOverrides: { commandCount: 2, earlySteerCount: 1, steerBytes: Buffer.byteLength("Finish multiply and divide independently before validation.", "utf8"), steerSha256: sha256Text(sha256Text("Finish multiply and divide independently before validation.")) } }),
    stub("validator", { mode: "json", verdict: "PASS", mutation: "none" }),
    stub("commit", { mode: "json", mutation: "none" }),
    stub("ask", { mode: "text", tools: "none", mutation: "none" })
  ];
  setSnapshots(input, {
    ".tmp/refactor-run.log": "Starting doer\nStarting validation\nStarting commit\nLine finished after 1 iterations.\n",
    ".tmp/refactor-watch.log": "queue_update\n→ read\nauthored-eval accepted early steer\n→ edit\n",
    "factory/refactor/.tmp/quality-before.txt": "Findings reported by: eslint.\n",
    "factory/refactor/.tmp/evidence.txt": "=== QUALITY BEFORE (recorded before the doer ran) ===\nFindings reported by: eslint.\n\n=== QUALITY NOW ===\nAll quality checks passed.\n\n=== TESTS ===\nTests: PASS\nauthored-eval npm test stub: calculator tests passed without network.\n\n=== WORKING DIFF ===\n+    const readFirstOperand = (separator: \"and\" | \"from\" | \"by\"): number => {\n+      const first = readFirstOperand(\"by\");\n+      const first = readFirstOperand(\"by\");\n-      const first = read();\n-      if (pieces[place++] !== \"by\") fail();\n",
    "factory/refactor/.tmp/validate-findings.txt": "VERDICT: PASS\n\nFINDINGS:\n- [PASS] tests and quality passed before this verdict.\n",
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
    output: { bytes: 10, sha256: "c".repeat(64), eventClasses: mode === "rpc" ? ["response", "agent_end"] : mode === "json" ? ["message_end", "agent_end"] : ["text"] }
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

function stubbedShellEnv(handle: Awaited<ReturnType<typeof createAuthoredCommandStubs>>): NodeJS.ProcessEnv {
  const path = `${handle.hostBinDir}:${dirname(process.execPath)}:/usr/bin:/bin`;
  return { ...handle.hostEnv, PATH: path, STUBBED_PATH: path };
}

async function execShell(command: string, cwd: string, env: NodeJS.ProcessEnv, timeout: number): Promise<void> {
  const shellCommand = `export PATH=${shellQuote(env.STUBBED_PATH ?? env.PATH ?? "")}; ${command}`;
  const { stdout, stderr } = await execFileAsync("/bin/bash", ["-lc", shellCommand], { cwd, env, timeout, encoding: "utf8", maxBuffer: 1024 * 1024 });
  expect(`${stdout}\n${stderr}`).not.toMatch(/authored-eval command stub rejected|Doer did not start/);
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
