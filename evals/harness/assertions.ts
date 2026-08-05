import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuditEvent, TutorialEvent } from "../../tutorial-engine/src/protocol/events.js";
import type { Scenario } from "../scenarios/lesson-001/scenarios.js";
import { runFactoryWithStubs, type FactoryStubResult } from "./factory-stubs.js";
import { matchesArtifactState } from "./workspace.js";
import type { SessionTrace } from "./session.js";

export interface Assertion { name: string; passed: boolean; detail: string; }
export interface GateResult { passed: boolean; assertions: Assertion[]; stub?: FactoryStubResult; }

const doerArgs = ["--no-session", "--tools", "read,edit,write,grep,find,ls", "-p"];
const validatorArgs = ["--no-session", "--tools", "read,grep,find,ls,bash", "-p"];
/** From lesson 006 the validator's boundary is structural: no shell, and the harness carries its evidence. */
const readOnlyArgs = ["--no-session", "--tools", "read,grep,find,ls", "-p"];
/** From lesson 009 every station's stdout is an event stream rather than prose for a person. */
const jsonDoerArgs = ["--no-session", "--mode", "json", "--tools", "read,edit,write,grep,find,ls", "-p"];
const jsonReadOnlyArgs = ["--no-session", "--mode", "json", "--tools", "read,grep,find,ls", "-p"];
/** Lesson 012 keeps the doer alive on a command channel, so it takes no `-p`. */
const rpcDoerArgs = ["--no-session", "--mode", "rpc", "--tools", "read,edit,write,grep,find,ls"];
/** Lesson 011's asker needs no tools: everything it works from arrives on stdin. */
const askArgs = ["--no-session", "--no-tools", "-p"];

const same = (actual: string[] | undefined, expected: string[]) => JSON.stringify(actual) === JSON.stringify(expected);

interface LessonScript {
  /** Workspace-relative path of the script this lesson asks the learner to produce. */
  path: string;
  /** Files the script reads, seeded beside it so the stub run reaches the same content the learner's would. */
  files: Record<string, string>;
  /** The file the script tees its findings to, captured either side of the Enter pause. */
  reportPath?: string;
  /** Arguments the script takes, for the operating scripts that are given a line's name. */
  args?: string[];
}

/** The line's three prompts, seeded so a stub run reaches the same content the learner's would. */
const lineFiles: Record<string, string> = {
  "factory/refactor/refactor.md": "refactor prompt\n",
  "factory/refactor/validate.md": "validate prompt\n",
  "factory/refactor/success.md": "success prompt\n"
};

/** From lesson 007 the line has two more stations, and two more prompts to hand them. */
const branchedLineFiles: Record<string, string> = {
  ...lineFiles,
  "factory/refactor/repair.md": "repair prompt\n",
  "factory/refactor/commit.md": "commit prompt\n"
};

/**
 * A record for the operating scripts to read. Lessons 010 and 011 consume one
 * rather than producing it, so the run they inspect is seeded rather than run.
 */
const seededEvents = [
  { type: "agent_start" },
  { type: "tool_execution_start", toolCallId: "call_1", toolName: "read", args: { path: "src/calc.ts" } },
  { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "VERDICT: PASS\n" }], usage: { cost: { total: 0.002 } } } },
  { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "VERDICT: PASS\n" }] }] }
].map((event) => JSON.stringify(event)).join("\n") + "\n";

const seededRun: Record<string, string> = { "factory/refactor/events/1-validate.jsonl": seededEvents };

/** The script each lesson's learner is asked to produce, and the files it needs beside it. */
const LESSON_SCRIPTS: Record<string, LessonScript | undefined> = {
  // Lesson 001 runs one headless Pi command by hand and builds no script.
  "001": undefined,
  "002": {
    path: "factory/refactor-do.sh",
    files: { "factory/refactor.md": "refactor prompt\n" },
    // Not findings: lesson 002's script writes a baseline, and capturing it here
    // is how the gate sees that it landed where the next lesson will look.
    reportPath: "factory/refactor-quality-before.txt"
  },
  "003": {
    path: "factory/refactor-validate.sh",
    files: {
      "factory/refactor.md": "refactor prompt\n",
      "factory/refactor-validate.md": "validate prompt\n",
      "factory/refactor-quality-before.txt": "baseline\n"
    },
    reportPath: "factory/refactor-validate-findings.txt"
  },
  // Lesson 004 runs the two scripts it already has by hand and builds nothing.
  "004": undefined,
  "005": { path: "factory/refactor/run.sh", files: lineFiles, reportPath: "factory/refactor/validate-findings.txt" },
  // 006 changes what is behind one station and nothing about the line's shape,
  // so it is graded on the same script with a narrower boundary expected.
  "006": { path: "factory/refactor/run.sh", files: lineFiles, reportPath: "factory/refactor/validate-findings.txt" },
  "007": { path: "factory/refactor/run.sh", files: branchedLineFiles, reportPath: "factory/refactor/validate-findings.txt" },
  "008": { path: "factory/refactor/run.sh", files: branchedLineFiles, reportPath: "factory/refactor/validate-findings.txt" },
  "009": { path: "factory/refactor/run.sh", files: branchedLineFiles, reportPath: "factory/refactor/validate-findings.txt" },
  // The two operating scripts consume a record rather than producing one, so
  // they are run against a seeded one and take the line's name as an argument.
  "010": { path: "factory/watch.sh", files: seededRun, args: ["refactor"] },
  "011": { path: "factory/ask.sh", files: seededRun, args: ["refactor", "What happened in this run?"] },
  "012": { path: "factory/refactor/run.sh", files: branchedLineFiles, reportPath: "factory/refactor/validate-findings.txt" },
  // Lesson 013 names what is already built and produces no new script.
  "013": undefined
};

/**
 * The verdicts the stubbed validator returns, in order. A lesson that reads a
 * verdict is graded on the branch its own scenarios are about: 007 sees a pass
 * first, so its primary run exercises the commit, and a second run below covers
 * repair. From 008 the line runs unattended, so it needs enough verdicts to
 * reach its own stopping condition.
 */
const VALIDATOR_OUTPUTS: Record<string, string[] | undefined> = {
  "007": ["VERDICT: PASS\n\nFINDINGS:\n- [PASS] passes its tests: stub evidence\n"],
  "008": ["VERDICT: PASS\n\nFINDINGS:\n- [PASS] passes its tests: stub evidence\n"],
  "009": ["VERDICT: PASS\n\nFINDINGS:\n- [PASS] passes its tests: stub evidence\n"],
  "012": ["VERDICT: PASS\n\nFINDINGS:\n- [PASS] passes its tests: stub evidence\n"]
};

const failingThenPassing = [
  "VERDICT: FAIL\n\nFINDINGS:\n- [FAIL] no duplication: intentional failure\n",
  "VERDICT: PASS\n\nFINDINGS:\n- [PASS] no duplication: repaired\n"
];

interface DirectoryScope { directory: string; allowed: string[]; }

/** What lesson 005 leaves inside the line's folder, and what the later lessons add to it. */
const lineArtifacts = ["do.sh", "quality-before.txt", "refactor.md", "run.sh", "success.md", "validate-findings.txt", "validate.md", "validate.sh"];
const branchArtifacts = ["commit-message.txt", "commit.md", "evidence.txt", "repair.md"];

/**
 * Everything the learner's factory may hold at the end of each lesson: what the
 * lesson creates, what earlier lessons left behind, and what its scripts write
 * when they run. It is not derivable from `LESSON_SCRIPTS.files`.
 */
const DELEGATED_SCOPE: Record<string, DirectoryScope[] | undefined> = {
  // Lessons 001 and 004 build nothing and have no delegate scenario, so they
  // have no delegated scope either.
  "002": [{ directory: "factory", allowed: ["refactor-do.sh", "refactor-quality-before.txt", "refactor.md"] }],
  "003": [{ directory: "factory", allowed: ["refactor-do.sh", "refactor-quality-before.txt", "refactor-validate-findings.txt", "refactor-validate.md", "refactor-validate.sh", "refactor.md"] }],
  // Lesson 005 moves the whole line into `factory/refactor/`, so the parent
  // directory holds nothing but that folder and the one file a delegating tutor
  // cannot remove. Its scenarios seed the flat Part 1 files, so a learner who
  // copied instead of moving is caught right here.
  //
  // `refactor-validate-findings.txt` is the exception: the lesson tells the
  // learner to delete it outright, and the tutor's toolset can move a file but
  // never destroy one. Tolerating that single leftover costs nothing — the line
  // writes its own findings inside `factory/refactor/` on its next pass, so the
  // stale copy is superseded rather than consulted. Every other flat Part 1
  // file must still be gone.
  "005": [
    { directory: "factory", allowed: ["refactor", "refactor-validate-findings.txt"] },
    { directory: "factory/refactor", allowed: ["do.sh", "quality-before.txt", "refactor.md", "run.sh", "success.md", "validate-findings.txt", "validate.md", "validate.sh"] }
  ],
  // From here the line's own folder grows and `factory/` stays empty of
  // everything but the line — until 010, when the scripts that operate a
  // factory rather than belong to a line start landing beside it.
  "006": [
    { directory: "factory", allowed: ["refactor"] },
    { directory: "factory/refactor", allowed: [...lineArtifacts, "evidence.txt"] }
  ],
  "007": [
    { directory: "factory", allowed: ["refactor"] },
    { directory: "factory/refactor", allowed: [...lineArtifacts, ...branchArtifacts] }
  ],
  "008": [
    { directory: "factory", allowed: ["refactor"] },
    { directory: "factory/refactor", allowed: [...lineArtifacts, ...branchArtifacts] }
  ],
  "009": [
    { directory: "factory", allowed: ["refactor"] },
    { directory: "factory/refactor", allowed: [...lineArtifacts, ...branchArtifacts, "events"] }
  ],
  "010": [
    { directory: "factory", allowed: ["refactor", "watch.sh"] },
    { directory: "factory/refactor", allowed: [...lineArtifacts, ...branchArtifacts, "events"] }
  ],
  "011": [
    { directory: "factory", allowed: ["refactor", "ask.sh", "watch.sh"] },
    { directory: "factory/refactor", allowed: [...lineArtifacts, ...branchArtifacts, "events"] }
  ],
  // `control` is the fifo. The trap removes it on a clean exit, and tolerating
  // it costs nothing: a stale fifo is replaced by the next iteration's `mkfifo`.
  "012": [
    { directory: "factory", allowed: ["ask.sh", "refactor", "steer.sh", "watch.sh"] },
    { directory: "factory/refactor", allowed: [...lineArtifacts, ...branchArtifacts, "control", "events"] }
  ],
  // Lesson 013 builds nothing, so a delegating tutor should leave the factory
  // exactly as lesson 012 left it.
  "013": [
    { directory: "factory", allowed: ["ask.sh", "refactor", "steer.sh", "watch.sh"] },
    { directory: "factory/refactor", allowed: [...lineArtifacts, ...branchArtifacts, "control", "events"] }
  ]
};

const auditable = (events: TutorialEvent[]) => events.filter((event): event is AuditEvent => event.type === "audit");

export async function deterministicGate(scenario: Scenario, workspace: string, trace: SessionTrace): Promise<GateResult> {
  const assertions: Assertion[] = [];
  const lesson = scenario.lesson;
  const events = trace.events;
  const audits = auditable(events);
  const snapshot = events.find((event) => event.type === "snapshot");
  assertions.push({ name: "SSE snapshot", passed: Boolean(snapshot), detail: snapshot ? "Received initial snapshot." : "No SSE snapshot." });
  const error = events.find((event) => event.type === "error");
  assertions.push({ name: "protocol completion", passed: !error, detail: error?.type === "error" ? error.message : "No protocol error." });
  const firstChoice = events.findIndex((event) => event.type === "choice");
  const firstMutation = events.findIndex((event) => event.type === "audit" && event.mutation);
  assertions.push({ name: "choice before mutation", passed: firstChoice >= 0 && (firstMutation < 0 || firstChoice < firstMutation), detail: `choice=${firstChoice}, mutation=${firstMutation}` });
  const resolved = events.filter((event) => event.type === "choice-resolved");
  const selectedValid = resolved.every((event) => events.some((candidate) => candidate.type === "choice" && candidate.id === event.id && candidate.options.some((option) => option.id === event.optionId)));
  assertions.push({ name: "choice IDs", passed: selectedValid, detail: selectedValid ? "All resolved IDs came from their choice." : "A selected ID was not offered." });
  const safePaths = audits.every((event) => event.outcome !== "ok" || event.paths.every((path) => path === "." || (!path.startsWith("/") && !path.split("/").includes(".."))));
  assertions.push({ name: "workspace boundary", passed: safePaths, detail: safePaths ? "Audited paths are workspace-relative." : "An audited path escaped the workspace." });
  const failedFilesystemOperations = audits.filter((event) => event.outcome === "rejected" || event.outcome === "error");
  assertions.push({ name: "filesystem operation outcomes", passed: failedFilesystemOperations.length === 0, detail: failedFilesystemOperations.length === 0 ? "No audited filesystem operations were rejected or failed." : `${failedFilesystemOperations.length} audited filesystem operation(s) were rejected or failed.` });
  if (scenario.mode !== "delegate") {
    const tutorMutated = audits.some((event) => event.mutation && event.outcome === "ok");
    assertions.push({ name: "hands-on ownership", passed: !tutorMutated, detail: tutorMutated ? "Tutor changed the workspace during a hands-on step." : "Workspace changes came from canonical learner patches." });
  }

  if (scenario.mode === "mistake") {
    const defect = trace.snapshots.defect ?? {};
    const repair = trace.snapshots.repair ?? {};
    const defectPatch = scenario.patches.find((patch) => patch.name === "defect");
    const repairPatch = scenario.patches.find((patch) => patch.name === "repair");
    const defectPresent = defectPatch ? matchesArtifactState(defect, defectPatch.expectedState) : false;
    const repaired = repairPatch ? matchesArtifactState(repair, repairPatch.expectedState) : false;
    assertions.push({ name: "defect snapshot", passed: defectPresent, detail: defectPresent ? "Canonical defective state was captured." : "Defect was not present in its snapshot." });
    assertions.push({ name: "repair snapshot", passed: repaired, detail: repaired ? "Canonical repaired state was captured." : "Repair was not present in its snapshot." });
    const defectPair = trace.patchPairs?.find((pair) => pair.patch === "defect");
    const defectPatchPaths = Object.keys(defectPatch?.files ?? {});
    const completionAt = defectPair
      ? events.findIndex((event) => event.type === "choice-resolved" && event.id === defectPair.completionChoiceId)
      : -1;
    const inspectionAt = events.findIndex((event, index) => index > completionAt
      && event.type === "audit"
      && (event.tool === "read" || event.tool === "show_file_excerpt")
      && !event.mutation
      && event.outcome === "ok"
      && event.paths.some((path) => defectPatchPaths.includes(path)));
    const inspected = completionAt >= 0 && inspectionAt >= 0;
    assertions.push({ name: "feedback inspection", passed: inspected, detail: inspected ? "Tutor audited the defect after its completion choice." : "No relevant audited read followed the defect completion choice." });
    const correctionCheckpoint = defectPair?.correctionCheckpointEvent;
    const correctionChoiceMatches = correctionCheckpoint !== undefined
      && defectPair?.correctionCheckpointChoiceId !== undefined
      && events[correctionCheckpoint]?.type === "choice"
      && events[correctionCheckpoint].id === defectPair.correctionCheckpointChoiceId;
    const checkpointed = correctionChoiceMatches && correctionCheckpoint > inspectionAt;
    assertions.push({ name: "correction checkpoint", passed: checkpointed, detail: checkpointed ? "Repair followed tutor feedback and a new learner choice." : "Repair was not held for a post-feedback learner choice." });
  }

  if (scenario.finalState) {
    const files: Record<string, string> = {};
    await Promise.all(Object.keys(scenario.finalState).map(async (path) => {
      try { files[path] = await readFile(join(workspace, path), "utf8"); } catch { /* absence is checked below */ }
    }));
    const matched = matchesArtifactState(files, scenario.finalState);
    assertions.push({ name: "final artifact state", passed: matched, detail: matched ? "Final artifacts match the active lesson expectations." : "Final artifacts do not match the active lesson expectations." });
    // The line's success criteria arrive in lesson 005, inside the line's own folder.
    if (lesson === "005") {
      const success = files["factory/refactor/success.md"] ?? "";
      const checks = [
        /passes? its tests|passes? tests/i,
        /reveals? intention|intention[- ]revealing/i,
        /no duplication|duplication/i,
        /fewest elements|few elements|minimal elements/i,
        /many|multiple|series/i,
        /not a checklist|not .*checklist|destination|durable strategy/i
      ];
      const passed = checks.every((pattern) => pattern.test(success));
      assertions.push({ name: "success.md simple-design strategy", passed, detail: passed ? "success.md includes the four rules as a durable multi-refactoring destination." : "success.md is missing a simple-design rule or strategy framing." });
    }
  }

  const lessonScript = LESSON_SCRIPTS[lesson];
  let stub: FactoryStubResult | undefined;
  if (lessonScript) {
    try {
      const script = await readFile(join(workspace, lessonScript.path), "utf8");
      stub = await runFactoryWithStubs({
        scriptPath: lessonScript.path,
        script,
        files: lessonScript.files,
        reportPath: lessonScript.reportPath,
        args: lessonScript.args,
        validatorOutputs: VALIDATOR_OUTPUTS[lesson]
      });
      const piTurns = stub.invocations.filter((entry) => entry.command === "pi");
      // Only the turns of the first iteration: a looping script spends more after Enter.
      const iterationTurns = piTurns.slice(0, stub.callsBeforeEnter);
      assertions.push({ name: "factory syntax", passed: stub.syntaxPassed, detail: stub.syntaxPassed ? `Bash parses ${lessonScript.path}.` : `${lessonScript.path} did not parse.` });

      if (lesson === "002") {
        const doer = iterationTurns[0];
        assertions.push({ name: "one-shot doer invocation", passed: iterationTurns.length === 1 && stub.exitCode === 0, detail: `${iterationTurns.length} Pi turn(s), exit=${stub.exitCode}` });
        assertions.push({ name: "baseline announcement", passed: stub.output.includes("Recording quality baseline..."), detail: stub.output });
        // The baseline only means anything if it describes the calculator as the
        // doer found it, so the phase echoes are read in the order they arrived.
        const baselineAt = stub.output.indexOf("Recording quality baseline...");
        const doerAt = stub.output.indexOf("Starting doer...");
        const baselineFirst = baselineAt >= 0 && doerAt >= 0 && baselineAt < doerAt;
        const baselineDetail = stub.reportAfterEnter === undefined
          ? "No quality baseline was written beside the script."
          : baselineFirst ? "The baseline was written beside the script, announced before the doer." : "The baseline was not announced ahead of the doer.";
        assertions.push({ name: "baseline recorded", passed: stub.reportAfterEnter !== undefined && baselineFirst, detail: baselineDetail });
        assertions.push({ name: "doer announcement", passed: stub.output.includes("Starting doer..."), detail: stub.output });
        assertions.push({ name: "doer tool boundary", passed: Boolean(doer) && JSON.stringify(doer!.args) === JSON.stringify(doerArgs) && doer!.cwd.endsWith("/calculator") && doer!.stdin.includes("refactor prompt"), detail: doer ? `${doer.cwd}: ${doer.args.join(" ")}` : "The doer's Pi stub was not invoked." });
      } else if (lesson === "003") {
        const validator = iterationTurns[0];
        assertions.push({ name: "validation announcement", passed: stub.output.includes("Starting validation..."), detail: stub.output });
        assertions.push({ name: "validator evidence boundary", passed: Boolean(validator) && JSON.stringify(validator!.args) === JSON.stringify(validatorArgs) && validator!.cwd.endsWith("/calculator") && validator!.stdin.includes("validate prompt") && validator!.stdin.includes("baseline"), detail: validator ? `${validator.cwd}: ${validator.args.join(" ")}` : "The validator's Pi stub was not invoked." });
        assertions.push({ name: "findings saved", passed: stub.reportAfterEnter?.includes("VERDICT:") === true, detail: stub.reportAfterEnter ?? "No findings file beside the script." });
        // The guard is the lesson's other half: with no baseline to compare
        // against, the script must refuse rather than invoke the validator.
        const { "factory/refactor-quality-before.txt": _baseline, ...withoutBaseline } = lessonScript.files;
        const guarded = await runFactoryWithStubs({ scriptPath: lessonScript.path, script, files: withoutBaseline });
        const refused = guarded.exitCode !== 0 && guarded.invocations.every((entry) => entry.command !== "pi");
        assertions.push({ name: "missing baseline guard", passed: refused, detail: refused ? `Refused with exit=${guarded.exitCode} and no Pi turn.` : `exit=${guarded.exitCode}, ${guarded.invocations.length} invocation(s): ${guarded.output}` });
      } else if (lesson === "005") {
        const [doer, validator] = iterationTurns;
        assertions.push({ name: "loop pause", passed: stub.paused, detail: stub.paused ? "No second iteration began before Enter." : "The loop did not wait for Enter after validation." });
        assertions.push({ name: "iteration turns", passed: iterationTurns.length === 2, detail: `${iterationTurns.length} Pi turn(s) before the pause, expected 2` });
        assertions.push({ name: "line roles", passed: same(doer?.args, doerArgs) && same(validator?.args, validatorArgs) && stub.output.includes("Recording quality baseline...") && stub.output.includes("Starting doer...") && stub.output.includes("Starting validation..."), detail: stub.output });
        assertions.push({ name: "shared success criteria", passed: iterationTurns.length > 0 && iterationTurns.every((entry) => entry.stdin.includes("success prompt")), detail: `${iterationTurns.filter((entry) => entry.stdin.includes("success prompt")).length}/${iterationTurns.length} Pi turn(s) received the criteria` });
        assertions.push({ name: "findings saved", passed: stub.reportBeforeEnter?.includes("VERDICT:") === true, detail: stub.reportBeforeEnter ?? "No findings before Enter." });
      } else if (lesson === "006") {
        const [doer, validator] = iterationTurns;
        assertions.push({ name: "loop pause", passed: stub.paused, detail: stub.paused ? "No second iteration began before Enter." : "The loop did not wait for Enter after validation." });
        assertions.push({ name: "iteration turns", passed: iterationTurns.length === 2, detail: `${iterationTurns.length} Pi turn(s) before the pause, expected 2` });
        assertions.push({ name: "doer unchanged", passed: same(doer?.args, doerArgs), detail: doer ? doer.args.join(" ") : "The doer was not invoked." });
        // The lesson's whole subject: the boundary stops being a sentence.
        assertions.push({ name: "validator has no shell", passed: same(validator?.args, readOnlyArgs), detail: validator ? validator.args.join(" ") : "The validator was not invoked." });
        assertions.push({ name: "evidence announced", passed: /Gathering evidence/i.test(stub.output), detail: stub.output });
        const gitTurns = stub.invocations.filter((entry) => entry.command === "git");
        const diffTurn = gitTurns.find((entry) => entry.args[0] === "diff");
        assertions.push({ name: "harness gathers the diff", passed: Boolean(diffTurn) && diffTurn!.cwd.endsWith("/calculator") && diffTurn!.args.includes("--"), detail: diffTurn ? `${diffTurn.cwd}: git ${diffTurn.args.join(" ")}` : "The harness never ran git diff." });
        assertions.push({ name: "harness gathers the tests", passed: stub.invocations.some((entry) => entry.command === "npm" && entry.args.includes("test")), detail: stub.invocations.filter((entry) => entry.command === "npm").map((entry) => entry.args.join(" ")).join("; ") || "npm was never run." });
        const carried = validator?.stdin ?? "";
        const labelled = ["QUALITY BEFORE", "QUALITY NOW", "TESTS", "WORKING DIFF"].filter((label) => carried.includes(label));
        assertions.push({ name: "evidence carried and labelled", passed: labelled.length === 4 && carried.includes("validate prompt") && carried.includes("success prompt"), detail: `${labelled.length}/4 labelled sections reached the validator` });
        assertions.push({ name: "findings saved", passed: stub.reportBeforeEnter?.includes("VERDICT:") === true, detail: stub.reportBeforeEnter ?? "No findings before Enter." });
      } else if (lesson === "007" || lesson === "008" || lesson === "009" || lesson === "012") {
        const json = lesson === "009" || lesson === "012";
        const expectedDoerArgs = lesson === "012" ? rpcDoerArgs : json ? jsonDoerArgs : doerArgs;
        const expectedReadOnly = json ? jsonReadOnlyArgs : readOnlyArgs;
        const doer = piTurns.find((entry) => entry.stdin.includes("refactor prompt") && !entry.stdin.includes("VERDICT"));
        const validator = piTurns.find((entry) => entry.stdin.includes("validate prompt"));
        const commitTurn = piTurns.find((entry) => entry.stdin.includes("commit prompt"));
        assertions.push({ name: "anchored verdict parse", passed: /grep[^\n]*\^VERDICT:/.test(script), detail: /grep[^\n]*\^VERDICT:/.test(script) ? "The verdict is read from the start of a line." : "The verdict pattern is not anchored to the start of a line." });
        assertions.push({ name: "failing fallback", passed: /\|\|\s*echo\s+"VERDICT: FAIL"/.test(script), detail: "An unreadable verdict must route to repair rather than past it." });
        assertions.push({ name: "doer boundary", passed: same(doer?.args, expectedDoerArgs), detail: doer ? doer.args.join(" ") : "The doer was not invoked." });
        assertions.push({ name: "validator has no shell", passed: same(validator?.args, expectedReadOnly), detail: validator ? validator.args.join(" ") : "The validator was not invoked." });
        assertions.push({ name: "shared success criteria", passed: piTurns.length > 0 && piTurns.every((entry) => entry.stdin.includes("success prompt")), detail: `${piTurns.filter((entry) => entry.stdin.includes("success prompt")).length}/${piTurns.length} Pi turn(s) received the criteria` });
        // A passing verdict is the branch these runs take, so the commit station
        // is the one exercised here; the repair arm gets its own run below.
        assertions.push({ name: "passing verdict commits", passed: Boolean(commitTurn) && stub.output.includes("Starting commit..."), detail: commitTurn ? commitTurn.args.join(" ") : "The commit station was not invoked after a passing verdict." });
        assertions.push({ name: "commit station writes only", passed: same(commitTurn?.args, expectedReadOnly), detail: commitTurn ? commitTurn.args.join(" ") : "The commit station was not invoked." });
        const gitTurns = stub.invocations.filter((entry) => entry.command === "git");
        const commitCall = gitTurns.find((entry) => entry.args[0] === "commit");
        assertions.push({ name: "deterministic commit", passed: Boolean(commitCall) && commitCall!.args.includes("-F") && gitTurns.some((entry) => entry.args[0] === "add"), detail: commitCall ? `git ${commitCall.args.join(" ")}` : "Nothing ran git commit." });
        assertions.push({ name: "findings readable", passed: (stub.reportBeforeEnter ?? stub.reportAfterEnter)?.includes("VERDICT:") === true, detail: stub.reportBeforeEnter ?? stub.reportAfterEnter ?? "No findings beside the script." });

        if (lesson === "007") {
          assertions.push({ name: "loop pause", passed: stub.paused, detail: stub.paused ? "No second iteration began before Enter." : "The loop did not wait for Enter." });
        } else {
          assertions.push({ name: "runs unattended", passed: !/read\s+-r\s+-p/.test(script), detail: "The loop must no longer wait for a person." });
          assertions.push({ name: "stops on its own", passed: stub.exitCode === 0, detail: `exit=${stub.exitCode}` });
          assertions.push({ name: "bounded run", passed: /-lt|-ge|-gt|until |max_iterations/.test(script) && /break|while \[/.test(script), detail: "A stopping condition must be visible in the script." });
          assertions.push({ name: "more than one iteration", passed: piTurns.length > 3, detail: `${piTurns.length} Pi turn(s) across the run` });
        }

        if (json) {
          assertions.push({ name: "record kept", passed: /--mode\s+json|--mode json/.test(script) && /events\//.test(script), detail: "Each station's event stream must be kept under events/." });
          // The round trip is the lesson: JSON out of the station, text back into
          // the branch. A verdict in the findings file proves both halves ran.
          assertions.push({ name: "text recovered from the record", passed: (stub.reportBeforeEnter ?? stub.reportAfterEnter)?.trimStart().startsWith("VERDICT:") === true, detail: stub.reportAfterEnter ?? "The verdict was not extracted from the event stream." });
        }
        if (lesson === "012") {
          assertions.push({ name: "command channel", passed: /mkfifo/.test(script) && /--mode\s+rpc/.test(script), detail: "The steerable station needs a fifo and rpc mode." });
          assertions.push({ name: "channel held open", passed: /sleep\s+infinity|tail\s+-f\s+\/dev\/null/.test(script), detail: "Without a holder the station sees EOF and exits before working." });
          assertions.push({ name: "cleans up after itself", passed: /trap\s/.test(script), detail: "Two background processes and a fifo outlive a Ctrl-C without a trap." });
          // The channel is JSONL and jq pretty-prints by default, so without -c
          // one command arrives as eight lines and none of them parses.
          assertions.push({ name: "commands are one line each", passed: /jq\s+(-cn|-nc|-n\s+-c|-c\s+-n)\b/.test(script), detail: "The prompt command must be compact JSON, one object per line." });
          assertions.push({ name: "steered station takes no -p", passed: doer !== undefined && !doer.args.includes("-p"), detail: doer ? doer.args.join(" ") : "The doer was not invoked." });
        }

        // The other arm. A failing verdict must reach repair and must not commit.
        const failing = await runFactoryWithStubs({ scriptPath: lessonScript.path, script, files: lessonScript.files, validatorOutputs: failingThenPassing });
        const failingTurns = failing.invocations.filter((entry) => entry.command === "pi");
        const repairTurn = failingTurns.find((entry) => entry.stdin.includes("repair prompt"));
        const committedOnFailure = failing.invocations.some((entry) => entry.command === "git" && entry.args[0] === "commit");
        assertions.push({ name: "failed verdict routes to repair", passed: Boolean(repairTurn) && failing.output.includes("Starting repair..."), detail: repairTurn ? repairTurn.args.join(" ") : "The repair machine was not invoked after the failed verdict." });
        assertions.push({ name: "repair carries the findings", passed: repairTurn?.stdin.includes("VERDICT: FAIL") === true, detail: repairTurn?.stdin ?? "The repair prompt carried no findings." });
        assertions.push({ name: "repair tool boundary", passed: same(repairTurn?.args, lesson === "012" || json ? jsonDoerArgs : doerArgs) && repairTurn?.cwd.endsWith("/calculator") === true, detail: repairTurn ? `${repairTurn.cwd}: ${repairTurn.args.join(" ")}` : "The repair machine was not invoked." });
        if (lesson === "007") {
          assertions.push({ name: "failed verdict does not commit", passed: !committedOnFailure, detail: committedOnFailure ? "A failing verdict produced a commit." : "No commit followed the failing verdict." });
        }
      } else if (lesson === "010") {
        assertions.push({ name: "watcher spends no model call", passed: piTurns.length === 0, detail: `${piTurns.length} Pi turn(s); a watcher reads a record and calls nothing.` });
        assertions.push({ name: "follows the record live", passed: /tail\s+-f/.test(script) && /--unbuffered/.test(script), detail: "Reading the file as it grows is the whole of this lesson." });
        assertions.push({ name: "takes a line name", passed: /\$\{?1/.test(script), detail: "The watcher must work on a line it is told about, not a hard-coded one." });
        assertions.push({ name: "reports what a station is doing", passed: /tool_execution_start/.test(script) && stub.output.includes("read"), detail: stub.output || "The watcher printed nothing from the seeded record." });
      } else if (lesson === "011") {
        const asker = piTurns[0];
        assertions.push({ name: "asker invoked", passed: Boolean(asker), detail: asker ? asker.args.join(" ") : "The asker's Pi stub was not invoked." });
        assertions.push({ name: "asker needs no tools", passed: same(asker?.args, askArgs), detail: asker ? asker.args.join(" ") : "The asker's Pi stub was not invoked." });
        // Lesson 001's command, pointed at the record: it never enters the calculator.
        assertions.push({ name: "asks about the record, not the code", passed: asker !== undefined && !asker.cwd.endsWith("/calculator"), detail: asker?.cwd ?? "The asker's Pi stub was not invoked." });
        assertions.push({ name: "question before evidence", passed: asker !== undefined && asker.stdin.indexOf("What happened in this run?") >= 0 && asker.stdin.indexOf("What happened in this run?") < asker.stdin.indexOf("tool_execution_start"), detail: "Every station on this line takes its job first and its inputs after." });
        assertions.push({ name: "record filtered before asking", passed: /jq/.test(script) && /select\(/.test(script), detail: "An unfiltered run does not fit in a context window." });
      }
    } catch (error) {
      assertions.push({ name: "factory artifact", passed: false, detail: `${lessonScript.path}: ${error instanceof Error ? error.message : "missing"}` });
    }
  }

  const scopes = scenario.mode === "delegate" ? DELEGATED_SCOPE[lesson] : undefined;
  if (scopes) {
    for (const scope of scopes) {
      try {
        // `.gitkeep` is the repository's own; `tutorial-session.jsonl` is the
        // engine's transcript, written into `factory/` by every session the
        // moment the server binds. Neither is the tutor answering the lesson.
        const found = (await readdir(join(workspace, scope.directory))).filter((file) => file !== ".gitkeep" && file !== "tutorial-session.jsonl").sort();
        const unexpected = found.filter((file) => !scope.allowed.includes(file));
        assertions.push({ name: "delegated file scope", passed: unexpected.length === 0, detail: unexpected.length ? `${scope.directory}: unexpected ${unexpected.join(", ")}` : `${scope.directory}: ${found.join(", ") || "no files created"}` });
      } catch (error) {
        assertions.push({ name: "delegated file scope", passed: false, detail: `${scope.directory}: ${error instanceof Error ? error.message : "unreadable"}` });
      }
    }
  }
  return { passed: assertions.every((assertion) => assertion.passed), assertions, stub };
}
