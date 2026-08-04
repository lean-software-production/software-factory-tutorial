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

interface LessonScript {
  /** Workspace-relative path of the script this lesson asks the learner to produce. */
  path: string;
  /** Files the script reads, seeded beside it so the stub run reaches the same content the learner's would. */
  files: Record<string, string>;
  /** The file the script tees its findings to, captured either side of the Enter pause. */
  reportPath?: string;
}

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
  "005": {
    path: "factory/refactor/run.sh",
    files: {
      "factory/refactor/refactor.md": "refactor prompt\n",
      "factory/refactor/validate.md": "validate prompt\n",
      "factory/refactor/success.md": "success prompt\n"
    },
    reportPath: "factory/refactor/validate-findings.txt"
  },
  "006": {
    path: "factory/refactor/run.sh",
    files: {
      "factory/refactor/refactor.md": "refactor prompt\n",
      "factory/refactor/validate.md": "validate prompt\n",
      "factory/refactor/success.md": "success prompt\n",
      "factory/refactor/repair.md": "repair prompt\n"
    },
    reportPath: "factory/refactor/validate-findings.txt"
  }
};

interface DirectoryScope { directory: string; allowed: string[]; }

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
  "006": [
    { directory: "factory", allowed: ["refactor"] },
    { directory: "factory/refactor", allowed: ["do.sh", "quality-before.txt", "refactor.md", "repair.md", "run.sh", "success.md", "validate-findings.txt", "validate.md", "validate.sh"] }
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
        // Lesson 006 is the first lesson to read a verdict, so it is graded on a
        // failing one; the pass that follows shows a repaired iteration carrying on.
        validatorOutputs: lesson === "006"
          ? ["VERDICT: FAIL\n\nFINDINGS:\n- [FAIL] passes tests: intentional failure\n", "VERDICT: PASS\n\nFINDINGS:\n- [PASS] passes tests: repaired\n"]
          : undefined
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
      } else if (lesson === "005" || lesson === "006") {
        const [doer, validator] = iterationTurns;
        const expectedTurns = lesson === "006" ? 3 : 2;
        assertions.push({ name: "loop pause", passed: stub.paused, detail: stub.paused ? "No second iteration began before Enter." : "The loop did not wait for Enter after validation." });
        assertions.push({ name: "iteration turns", passed: iterationTurns.length === expectedTurns, detail: `${iterationTurns.length} Pi turn(s) before the pause, expected ${expectedTurns}` });
        assertions.push({ name: "line roles", passed: Boolean(doer) && Boolean(validator) && JSON.stringify(doer!.args) === JSON.stringify(doerArgs) && JSON.stringify(validator!.args) === JSON.stringify(validatorArgs) && stub.output.includes("Recording quality baseline...") && stub.output.includes("Starting doer...") && stub.output.includes("Starting validation..."), detail: stub.output });
        assertions.push({ name: "shared success criteria", passed: iterationTurns.length > 0 && iterationTurns.every((entry) => entry.stdin.includes("success prompt")), detail: `${iterationTurns.filter((entry) => entry.stdin.includes("success prompt")).length}/${iterationTurns.length} Pi turn(s) received the criteria` });
        assertions.push({ name: "findings saved", passed: stub.reportBeforeEnter?.includes("VERDICT:") === true, detail: stub.reportBeforeEnter ?? "No findings before Enter." });
        if (lesson === "006") {
          const repairTurn = iterationTurns.find((entry) => entry.stdin.includes("repair prompt"));
          assertions.push({ name: "anchored verdict parse", passed: /grep[^\n]*\^VERDICT:/.test(script), detail: /grep[^\n]*\^VERDICT:/.test(script) ? "The verdict is read from the start of a line." : "The verdict pattern is not anchored to the start of a line." });
          assertions.push({ name: "failed verdict routes to repair", passed: Boolean(repairTurn) && stub.output.includes("Starting repair..."), detail: repairTurn ? repairTurn.args.join(" ") : "The repair machine was not invoked after the failed verdict." });
          assertions.push({ name: "repair carries the findings", passed: repairTurn?.stdin.includes("VERDICT: FAIL") === true, detail: repairTurn?.stdin ?? "The repair prompt carried no findings." });
          assertions.push({ name: "repair tool boundary", passed: Boolean(repairTurn) && JSON.stringify(repairTurn!.args) === JSON.stringify(doerArgs) && repairTurn!.cwd.endsWith("/calculator"), detail: repairTurn ? `${repairTurn.cwd}: ${repairTurn.args.join(" ")}` : "The repair machine was not invoked after the failed verdict." });
        }
      }
    } catch (error) {
      assertions.push({ name: "factory artifact", passed: false, detail: `${lessonScript.path}: ${error instanceof Error ? error.message : "missing"}` });
    }
  }

  const scopes = scenario.mode === "delegate" ? DELEGATED_SCOPE[lesson] : undefined;
  if (scopes) {
    for (const scope of scopes) {
      try {
        const found = (await readdir(join(workspace, scope.directory))).filter((file) => file !== ".gitkeep").sort();
        const unexpected = found.filter((file) => !scope.allowed.includes(file));
        assertions.push({ name: "delegated file scope", passed: unexpected.length === 0, detail: unexpected.length ? `${scope.directory}: unexpected ${unexpected.join(", ")}` : `${scope.directory}: ${found.join(", ") || "no files created"}` });
      } catch (error) {
        assertions.push({ name: "delegated file scope", passed: false, detail: `${scope.directory}: ${error instanceof Error ? error.message : "unreadable"}` });
      }
    }
  }
  return { passed: assertions.every((assertion) => assertion.passed), assertions, stub };
}
