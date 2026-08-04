import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuditEvent, TutorialEvent } from "../../tutorial-engine/src/protocol/events.js";
import type { Scenario } from "../scenarios/lesson-001/scenarios.js";
import { runFactoryWithStubs, type FactoryStubResult } from "./factory-stubs.js";
import { matchesArtifactState } from "./workspace.js";
import type { SessionTrace } from "./session.js";

export interface Assertion { name: string; passed: boolean; detail: string; }
export interface GateResult { passed: boolean; assertions: Assertion[]; stub?: FactoryStubResult; }

const auditable = (events: TutorialEvent[]) => events.filter((event): event is AuditEvent => event.type === "audit");

export async function deterministicGate(scenario: Scenario, workspace: string, trace: SessionTrace): Promise<GateResult> {
  const assertions: Assertion[] = [];
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
    if (scenario.lesson === "001") {
      const success = files["factory/success.md"] ?? "";
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

  let stub: FactoryStubResult | undefined;
  try {
    const factory = await readFile(join(workspace, "factory/run.sh"), "utf8");
    // Task 8 replaces this call site with the per-lesson script paths and
    // prompt names. Until then it seeds what the previous fixed harness seeded.
    stub = await runFactoryWithStubs({
      scriptPath: "factory/run.sh",
      script: factory,
      files: {
        "factory/refactor.md": "refactor prompt\n",
        "factory/success.md": "success prompt\n",
        "factory/review.md": "review prompt\n",
        "factory/repair.md": "repair prompt\n"
      },
      validatorOutputs: scenario.lesson === "004" ? ["VERDICT: FAIL\n\nFINDINGS:\n- [FAIL] passes tests: intentional failure\n", "VERDICT: PASS\n\nFINDINGS:\n- [PASS] passes tests: repaired\n"] : undefined,
      reportPath: "factory/review-report.md"
    });
    const piTurns = stub.invocations.filter((entry) => entry.command === "pi");
    const doerArgs = ["--no-session", "--tools", "read,edit,write,grep,find,ls", "-p"];
    const reviewerArgs = ["--no-session", "--tools", "read,grep,find,ls,bash", "-p"];
    assertions.push({ name: "factory syntax", passed: stub.syntaxPassed, detail: stub.syntaxPassed ? "Bash parses run.sh." : "run.sh did not parse." });
    if (scenario.lesson === "001") {
      const doer = piTurns[0];
      const oneShot = piTurns.length === 1 && stub.exitCode === 0;
      assertions.push({ name: "one-shot doer invocation", passed: oneShot, detail: `${piTurns.length} Pi turn(s), exit=${stub.exitCode}` });
      assertions.push({ name: "doer announcement", passed: stub.output.includes("Starting doer..."), detail: stub.output });
      assertions.push({ name: "doer tool boundary", passed: Boolean(doer) && JSON.stringify(doer!.args) === JSON.stringify(doerArgs) && doer!.cwd.endsWith("/calculator") && doer!.stdin.includes("refactor prompt"), detail: doer ? `${doer.cwd}: ${doer.args.join(" ")}` : "Doer Pi stub was not invoked." });
    } else if (scenario.lesson === "002") {
      const [doer, reviewer] = piTurns;
      assertions.push({ name: "doer then reviewer", passed: piTurns.length === 2 && stub.output.includes("Starting doer...") && stub.output.includes("Starting review..."), detail: `${piTurns.length} Pi turn(s)` });
      assertions.push({ name: "doer tool boundary", passed: Boolean(doer) && JSON.stringify(doer!.args) === JSON.stringify(doerArgs) && doer!.cwd.endsWith("/calculator"), detail: doer ? doer.args.join(" ") : "Doer missing." });
      assertions.push({ name: "reviewer evidence boundary", passed: Boolean(reviewer) && JSON.stringify(reviewer!.args) === JSON.stringify(reviewerArgs) && reviewer!.cwd.endsWith("/calculator") && reviewer!.stdin.includes("review prompt") && reviewer!.stdin.includes("success prompt"), detail: reviewer ? reviewer.args.join(" ") : "Reviewer missing." });
    } else if (scenario.lesson === "003") {
      const [doer, reviewer] = piTurns;
      assertions.push({ name: "loop pause", passed: stub.paused, detail: stub.paused ? "No second loop began before Enter." : "The loop did not wait for Enter after review." });
      assertions.push({ name: "loop roles", passed: Boolean(doer) && Boolean(reviewer) && JSON.stringify(doer!.args) === JSON.stringify(doerArgs) && JSON.stringify(reviewer!.args) === JSON.stringify(reviewerArgs) && stub.output.includes("Starting doer iteration...") && stub.output.includes("Starting review..."), detail: `${piTurns.length} Pi turn(s)` });
    } else if (scenario.lesson === "004") {
      const repairTurn = piTurns.find((entry) => entry.stdin.includes("repair prompt"));
      assertions.push({ name: "review report saved", passed: stub.reportBeforeEnter?.includes("VERDICT: FAIL") === true, detail: stub.reportBeforeEnter ?? "No report before Enter." });
      assertions.push({ name: "failed verdict routes to repair", passed: Boolean(repairTurn) && stub.output.includes("Starting repair iteration..."), detail: repairTurn?.stdin ?? "Repair worker was not invoked after the failed report." });
      assertions.push({ name: "reviewer tee boundary", passed: piTurns.some((entry) => JSON.stringify(entry.args) === JSON.stringify(reviewerArgs) && entry.stdin.includes("success prompt")), detail: `${piTurns.length} Pi turn(s)` });
    }
    if (scenario.mode === "delegate") {
      const files = (await readdir(join(workspace, "factory"))).filter((file) => file !== ".gitkeep").sort();
      const allowed = ["refactor.md", "run.sh", "success.md"];
      assertions.push({ name: "delegated file scope", passed: JSON.stringify(files) === JSON.stringify(allowed), detail: files.join(", ") || "No factory files created." });
    }
  } catch (error) { assertions.push({ name: "factory artifact", passed: false, detail: error instanceof Error ? error.message : "Factory is missing." }); }
  return { passed: assertions.every((assertion) => assertion.passed), assertions, stub };
}
