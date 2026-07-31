import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuditEvent, TutorialEvent } from "../../tutorial-engine/src/protocol/events.js";
import type { Scenario } from "../scenarios/lesson-001/scenarios.js";
import { runFactoryWithStubs, type FactoryStubResult } from "./factory-stubs.js";
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
  if (scenario.mode !== "delegate") {
    const tutorMutated = audits.some((event) => event.mutation && event.outcome === "ok");
    assertions.push({ name: "hands-on ownership", passed: !tutorMutated, detail: tutorMutated ? "Tutor changed the workspace during a hands-on step." : "Workspace changes came from canonical learner patches." });
  }

  if (scenario.mode === "mistake") {
    const defect = trace.snapshots.defect ?? {};
    const repair = trace.snapshots.repair ?? {};
    const defectPresent = scenario.patches[0]?.expectedState.every((pattern) => Object.values(defect).some((content) => pattern.test(content))) ?? false;
    const repaired = scenario.patches[1]?.expectedState.every((pattern) => Object.values(repair).some((content) => pattern.test(content))) ?? false;
    assertions.push({ name: "defect snapshot", passed: defectPresent, detail: defectPresent ? "Canonical defective state was captured." : "Defect was not present in its snapshot." });
    assertions.push({ name: "repair snapshot", passed: repaired, detail: repaired ? "Canonical repaired state was captured." : "Repair was not present in its snapshot." });
    const feedbackAt = events.findIndex((event) => event.type === "user-message" && event.markdown.includes("feedback"));
    const inspected = audits.some((event, index) => index > feedbackAt && !event.mutation && event.outcome === "ok");
    assertions.push({ name: "feedback inspection", passed: inspected, detail: inspected ? "Tutor audited a read after feedback." : "No relevant audited read followed feedback." });
  }

  let stub: FactoryStubResult | undefined;
  try {
    const factory = await readFile(join(workspace, "factory/factory.sh"), "utf8");
    stub = await runFactoryWithStubs(factory, scenario.lesson === "002" ? ["fail", "pass"] : ["pass"]);
    const pi = stub.invocations.find((entry) => entry.command === "pi");
    const expectedArgs = ["--no-session", "--tools", "read,edit,write,grep,find,ls", "-p"];
    assertions.push({ name: "factory syntax and pause", passed: stub.syntaxPassed && stub.paused, detail: stub.syntaxPassed && stub.paused ? "Bash parses and observes Enter pause." : "Factory did not parse or pause." });
    if (scenario.lesson === "001") {
      const announced = stub.output.includes("Starting refactoring iteration...");
      assertions.push({ name: "turn announcement", passed: announced, detail: announced ? "Factory announces the refactoring turn." : "Factory did not announce the refactoring turn." });
    }
    assertions.push({ name: "Pi invocation", passed: Boolean(pi) && JSON.stringify(pi!.args) === JSON.stringify(expectedArgs) && pi!.cwd.endsWith("/calculator"), detail: pi ? `${pi.cwd}: ${pi.args.join(" ")}` : "Pi stub was not invoked." });
    if (scenario.lesson === "002") {
      const piTurns = stub.invocations.filter((entry) => entry.command === "pi");
      assertions.push({ name: "recovery evidence routing", passed: piTurns.length >= 2 && piTurns[1]?.stdin.includes("intentional failure") === true && Boolean(stub.failureLogBeforeEnter), detail: piTurns[1]?.stdin ?? "Recovery worker was not invoked." });
    }
    if (scenario.mode === "delegate") {
      const files = (await readdir(join(workspace, "factory"))).filter((file) => file !== ".gitkeep").sort();
      const allowed = ["factory.sh", "refactor.md"];
      assertions.push({ name: "delegated file scope", passed: JSON.stringify(files) === JSON.stringify(allowed), detail: files.join(", ") || "No factory files created." });
    }
  } catch (error) { assertions.push({ name: "factory artifact", passed: false, detail: error instanceof Error ? error.message : "Factory is missing." }); }
  return { passed: assertions.every((assertion) => assertion.passed), assertions, stub };
}
