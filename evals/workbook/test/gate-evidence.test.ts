import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { AUTHORED_COMMAND_STUB_NAMESPACE, AUTHORED_COMMAND_STUB_OWNER, AUTHORED_COMMAND_STUB_SCHEMA_VERSION, type AuthoredCommandInvocationEvidence } from "../command-stubs.js";
import {
  AUTHORED_GATE_EVIDENCE_ABORTED_PUBLIC_ERROR,
  AUTHORED_GATE_EVIDENCE_CLEANUP_PUBLIC_ERROR,
  AUTHORED_GATE_EVIDENCE_DOCKER_IMAGE,
  AUTHORED_GATE_EVIDENCE_PUBLIC_ERROR,
  AuthoredGateEvidenceError,
  DockerAuthoredGateEvidenceProbe,
  createAuthoredWorkbookScenarioGateEvidenceCollector,
  dockerProbeCreateArguments,
  type AuthoredGateEvidenceCommandResult,
  type AuthoredGateEvidenceDockerRunner,
  type AuthoredGateEvidenceProbe
} from "../gate-evidence.js";
import { authoredWorkbookScenarioById, type AuthoredWorkbookScenarioDescriptor } from "../scenarios.js";
import type { AuthoredWorkbookEvalSessionTrace } from "../types.js";
import { createEmptyAuthoredWorkbookEvalSessionTrace } from "../public-trace.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];
const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const sourceRoot = resolve(import.meta.dirname, "../../../tutorial/workspaces/refactor-line");
const prerequisitesRoot = resolve(import.meta.dirname, "../prerequisites");

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

describe("authored workbook gate evidence", () => {
  it("assembles frozen gate inputs for all four scenarios without calling a Judge", async () => {
    for (const id of ["primer-validation-misconception", "lesson-001-headless-boundary", "lessons-003-004-evidence-feedback", "lesson-013-operator-judgement"] as const) {
      const scenario = authoredWorkbookScenarioById(id);
      const fixture = await gateFixture(scenario);
      const result = scenario.gate(fixture.input);
      expect(result.passed, id).toBe(true);
      expect(Object.isFrozen(fixture.input)).toBe(true);
      expect(Object.isFrozen(fixture.input.trace)).toBe(true);
      expect(JSON.stringify(fixture.input.trace)).not.toContain("rawEvents");
      expect(JSON.stringify(fixture.input.trace)).not.toContain("authored-eval-command-stubs/invocations.jsonl");
    }
  }, 30_000);

  it("captures the multiply-only checkpoint immutably and rejects stale probe facts through the gate", async () => {
    const scenario = authoredWorkbookScenarioById("lessons-003-004-evidence-feedback");
    const fixture = await gateFixture(scenario);
    const checkpoint = fixture.input.facts.calculatorBehaviorTimeline?.find((entry: { label: string }) => entry.label === "after-multiply-only");
    expect(checkpoint?.cases).toEqual([{ input: "multiply 6 by 7", output: 42 }]);
    const mutated = structuredClone(fixture.input);
    mutated.facts.calculatorBehaviorTimeline![0]!.sourceSha256 = mutated.facts.calculatorBehaviorProjection!.sourceSha256;
    expect(scenario.gate(mutated).passed).toBe(false);
  }, 20_000);

  it("derives Lesson 013 Git expectations instead of accepting actual top commit as expected", async () => {
    const scenario = authoredWorkbookScenarioById("lesson-013-operator-judgement");
    const fixture = await gateFixture(scenario);
    expect(fixture.input.facts.calculatorTopCommit).toBe(fixture.input.facts.calculatorExpectedTopCommit);
    expect(fixture.input.facts.calculatorTopCommitTree).toBe(fixture.input.facts.calculatorExpectedTopCommitTree);

    const dirty = await gateFixture(scenario, { dirtyAfterCommit: true });
    expect(dirty.input.facts.calculatorTopCommit).not.toBe(dirty.input.facts.calculatorExpectedTopCommit);
    expect(scenario.gate(dirty.input).passed).toBe(false);

    const wrongIdentity = await gateFixture(scenario, { wrongCommitIdentity: true });
    expect(wrongIdentity.input.facts.calculatorTopCommit).not.toBe(wrongIdentity.input.facts.calculatorExpectedTopCommit);
    expect(scenario.gate(wrongIdentity.input).passed).toBe(false);

    const committedPrivateFile = await gateFixture(scenario, { extraCommittedIgnoredFile: true });
    expect(committedPrivateFile.input.facts.calculatorTopCommitTree).not.toBe(committedPrivateFile.input.facts.calculatorExpectedTopCommitTree);
    expect(scenario.gate(committedPrivateFile.input).passed).toBe(false);

    const alternateSource = await gateFixture(scenario, { alternateCommittedSource: true });
    expect(alternateSource.input.facts.calculatorTopCommitTree).not.toBe(alternateSource.input.facts.calculatorExpectedTopCommitTree);
    expect(scenario.gate(alternateSource.input).passed).toBe(false);

    const committerMismatch = await gateFixture(scenario, { committerMismatch: true });
    expect(committerMismatch.input.facts.calculatorTopCommit).not.toBe(committerMismatch.input.facts.calculatorExpectedTopCommit);
    expect(scenario.gate(committerMismatch.input).passed).toBe(false);
  }, 30_000);

  it("does not execute hostile learner Git filters, diffs, hooks, or fsmonitor while reading gate evidence", async () => {
    const scenario = authoredWorkbookScenarioById("lesson-013-operator-judgement");
    const workspace = await tempWorkspace();
    await writeLesson013Final(workspace.root, {});
    await writeFile(workspace.evidencePath, lesson013Evidence().map((entry) => JSON.stringify(entry)).join("\n") + "\n");

    const sentinel = join(workspace.root, "sentinel-executed");
    const executable = join(workspace.root, "factory/.tmp/evil-git-hook.sh");
    await writeFile(executable, `#!/bin/sh\necho executed >> ${JSON.stringify(sentinel)}\nexit 0\n`);
    await chmod(executable, 0o755);
    await mkdir(join(workspace.root, "factory/.tmp/githooks"), { recursive: true });
    await writeFile(join(workspace.root, "factory/.tmp/githooks/pre-commit"), `#!/bin/sh\necho hook >> ${JSON.stringify(sentinel)}\nexit 0\n`);
    await chmod(join(workspace.root, "factory/.tmp/githooks/pre-commit"), 0o755);
    await writeFile(join(workspace.root, ".git/info/attributes"), "* diff=evil filter=evil\n");
    await writeFile(join(workspace.root, "factory/.tmp/malicious-include.gitconfig"), `[core]\n\tfsmonitor = ${executable}\n[diff]\n\texternal = ${executable}\n[filter \"evil\"]\n\tclean = ${executable}\n\tsmudge = ${executable}\n\tprocess = ${executable}\n\trequired = true\n`);
    await git(workspace.root, "config", "--local", "include.path", join(workspace.root, "factory/.tmp/malicious-include.gitconfig"));
    await git(workspace.root, "config", "--local", "core.fsmonitor", executable);
    await git(workspace.root, "config", "--local", "core.hooksPath", join(workspace.root, "factory/.tmp/githooks"));
    await git(workspace.root, "config", "--local", "diff.external", executable);
    await git(workspace.root, "config", "--local", "diff.evil.command", executable);
    await git(workspace.root, "config", "--local", "filter.evil.clean", executable);
    await git(workspace.root, "config", "--local", "filter.evil.smudge", executable);
    await git(workspace.root, "config", "--local", "filter.evil.process", executable);
    await git(workspace.root, "config", "--local", "filter.evil.required", "true");

    const trace = lesson013Trace();
    const session = sessionFor(workspace.root);
    await writeSessionEvents(session.sessionRoot, trace.internalEvents);
    const collector = createAuthoredWorkbookScenarioGateEvidenceCollector({ scenario, workspace: fakeGuardedWorkspace(), session, trace, commandStubHandle: { hostEvidencePath: workspace.evidencePath, runId: RUN_ID }, probe: fakeProbe() });
    await collector.captureBaseline();
    await collector.collectGateInput();
    await expect(readFile(sentinel, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  it("cross-copies public and private artifact evidence from the same strict immutable read", async () => {
    const scenario = authoredWorkbookScenarioById("lessons-003-004-evidence-feedback");
    const fixture = await gateFixture(scenario);
    expect(fixture.input.trace.artifacts).toEqual(fixture.input.artifactSnapshots);
    expect(fixture.input.artifactSnapshots).toEqual(fixture.input.workspaceFileSnapshots);
    expect(fixture.input.trace.artifacts).not.toBe(fixture.input.artifactSnapshots);
    expect(() => { fixture.input.artifactSnapshots[0].content = "secret injected after read"; }).toThrow();
    expect(JSON.stringify(fixture.input.trace.artifacts)).not.toContain("secret injected after read");
  }, 20_000);

  it("returns serializable deeply frozen baseline entries instead of mutable Map state", async () => {
    const scenario = authoredWorkbookScenarioById("lesson-013-operator-judgement");
    const workspace = await tempWorkspace();
    const collector = createAuthoredWorkbookScenarioGateEvidenceCollector({ scenario, workspace: fakeGuardedWorkspace(), session: sessionFor(workspace.root), trace: lesson013Trace(), commandStubHandle: { hostEvidencePath: workspace.evidencePath, runId: RUN_ID }, probe: fakeProbe() });
    const baseline = await collector.captureBaseline();
    expect(baseline.workspaceManifest).toBeDefined();
    expect(baseline.workspaceManifest instanceof Map).toBe(false);
    expect(Array.isArray(baseline.workspaceManifest)).toBe(true);
    const original = JSON.stringify(baseline.workspaceManifest);
    expect(() => (baseline.workspaceManifest as any).push({ path: "x", fingerprint: "y" })).toThrow();
    expect(() => { (baseline.workspaceManifest as any)[0].fingerprint = "changed"; }).toThrow();
    expect(JSON.stringify(baseline.workspaceManifest)).toBe(original);
  }, 20_000);

  it("fails closed when Docker probe cleanup fails or follows an aborted primary probe", async () => {
    const workspace = await tempWorkspace();
    const source = await readFile(join(workspace.root, "calculator/src/index.ts"), "utf8");
    const validOutput = JSON.stringify({ marker: "authored-gate-calculator-probe-v1", sourceSha256: sha256Text(source), testStatus: "passed", testMarker: true, qualityStatus: "passed", qualityOutput: "All quality checks passed.", cases: [] });
    const calls: string[][] = [];
    const runner: AuthoredGateEvidenceDockerRunner = async (request) => {
      calls.push([...request.args]);
      if (request.args[0] === "rm") return { status: 99, stdout: "", stderr: "rm failed with a secret" };
      if (request.args[0] === "start") return { status: 0, stdout: validOutput, stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const probe = new DockerAuthoredGateEvidenceProbe({ dockerRunner: runner, repositoryRoot: resolve(import.meta.dirname, "../../..") });
    await expect(probe.probeCalculator({ workspaceRoot: workspace.root, label: "final" })).rejects.toMatchObject({ message: AUTHORED_GATE_EVIDENCE_CLEANUP_PUBLIC_ERROR });
    expect(calls.at(-1)).toEqual(expect.arrayContaining(["rm", "-f"]));

    const aborted = new AbortController();
    const abortCalls: string[][] = [];
    const abortRunner: AuthoredGateEvidenceDockerRunner = async (request) => {
      abortCalls.push([...request.args]);
      if (request.args[0] === "create") { aborted.abort(); throw new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_ABORTED_PUBLIC_ERROR); }
      return { status: 0, stdout: "", stderr: "" };
    };
    const abortProbe = new DockerAuthoredGateEvidenceProbe({ dockerRunner: abortRunner, repositoryRoot: resolve(import.meta.dirname, "../../..") });
    await expect(abortProbe.probeCalculator({ workspaceRoot: workspace.root, label: "final", signal: aborted.signal })).rejects.toMatchObject({ message: AUTHORED_GATE_EVIDENCE_ABORTED_PUBLIC_ERROR });
    expect(abortCalls.some((call) => call[0] === "rm" && call[1] === "-f")).toBe(true);
  }, 20_000);

  it("bounds Docker probe timeout and supplies a fresh independent cleanup signal", async () => {
    const workspace = await tempWorkspace();
    let cleanupSignal: AbortSignal | undefined;
    const controller = new AbortController();
    const runner: AuthoredGateEvidenceDockerRunner = async (request) => {
      if (request.args[0] === "rm") {
        cleanupSignal = request.signal;
        expect(request.signal).not.toBe(controller.signal);
        expect(request.timeoutMs).toBe(10_000);
        throw new Error("simulated rm hang/fail");
      }
      throw new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_PUBLIC_ERROR, "primary timeout");
    };
    const probe = new DockerAuthoredGateEvidenceProbe({ dockerRunner: runner, repositoryRoot: resolve(import.meta.dirname, "../../.."), timeoutMs: 1 });
    await expect(probe.probeCalculator({ workspaceRoot: workspace.root, label: "final", signal: controller.signal })).rejects.toMatchObject({ message: AUTHORED_GATE_EVIDENCE_CLEANUP_PUBLIC_ERROR });
    expect(cleanupSignal).toBeDefined();
  }, 20_000);

  it("cross-checks command-stub evidence against the current handle runId and enforces Lesson001 no stubs", async () => {
    const lesson001 = authoredWorkbookScenarioById("lesson-001-headless-boundary");
    const base = await tempWorkspace();
    const collector = createAuthoredWorkbookScenarioGateEvidenceCollector({
      scenario: lesson001,
      workspace: fakeGuardedWorkspace(),
      session: sessionFor(base.root),
      trace: lesson001Trace(),
      commandStubHandle: { hostEvidencePath: join(base.root, "factory/.tmp/authored-eval-command-stubs/invocations.jsonl"), runId: RUN_ID },
      probe: fakeProbe()
    });
    await collector.captureBaseline();
    await expect(collector.collectGateInput()).rejects.toThrow(/must not create authored command stubs/);

    const scenario = authoredWorkbookScenarioById("lessons-003-004-evidence-feedback");
    const fixture = await tempWorkspace();
    await mkdir(join(fixture.root, "factory/.tmp/authored-eval-command-stubs"), { recursive: true });
    const evidencePath = join(fixture.root, "factory/.tmp/authored-eval-command-stubs/invocations.jsonl");
    await writeFile(evidencePath, JSON.stringify(stub("doer", { runId: "123e4567-e89b-42d3-a456-426614174001", mutation: "partial-refactor" })) + "\n");
    const staleTrace = lessons003004Trace();
    const staleSession = sessionFor(fixture.root);
    await writeSessionEvents(staleSession.sessionRoot, staleTrace.internalEvents);
    const stale = createAuthoredWorkbookScenarioGateEvidenceCollector({ scenario, workspace: fakeGuardedWorkspace(), session: staleSession, trace: staleTrace, commandStubHandle: { hostEvidencePath: evidencePath, runId: RUN_ID }, probe: fakeProbe() });
    await stale.captureBaseline();
    await writeLessons003004Final(fixture.root, {});
    await expect(stale.collectGateInput()).rejects.toThrow(/current run/);
  }, 20_000);

  it("uses hardened Docker probe argv and keeps public Docker errors sanitized", async () => {
    const args = dockerProbeCreateArguments({ name: "probe-test", probeWorkspace: "/tmp/disposable-secret-workspace", nodeModules: "/tmp/root-node_modules" });
    expect(args).toContain("--network=none");
    expect(args).toContain("--read-only");
    expect(args).toContain(AUTHORED_GATE_EVIDENCE_DOCKER_IMAGE);
    expect(args).not.toContain("OPENCODE_API_KEY");
    expect(args.join(" ")).toContain("/workspace/calculator/node_modules,readonly");

    const workspace = await tempWorkspace();
    const calls: string[][] = [];
    const runner: AuthoredGateEvidenceDockerRunner = async (request) => {
      calls.push([...request.args]);
      if (request.args[0] === "create") return { status: 1, stdout: "", stderr: "absolute /tmp/disposable-secret-workspace leaked locally" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const probe = new DockerAuthoredGateEvidenceProbe({ dockerRunner: runner, repositoryRoot: resolve(import.meta.dirname, "../../..") });
    await expect(probe.probeCalculator({ workspaceRoot: workspace.root, label: "final" })).rejects.toMatchObject({ message: AUTHORED_GATE_EVIDENCE_PUBLIC_ERROR });
    await expect(probe.probeCalculator({ workspaceRoot: workspace.root, label: "final" })).rejects.not.toThrow(/disposable-secret|OPENCODE|\/tmp\/authored/);
    expect(calls.some((call) => call[0] === "rm" && call[1] === "-f")).toBe(true);
  }, 20_000);

  it("rejects oversized, alias, raw-event, dirty, jump, and source/disposable mutations before Judge", async () => {
    const scenario = authoredWorkbookScenarioById("lessons-003-004-evidence-feedback");
    const fixture = await gateFixture(scenario, { extraArtifact: true });
    expect(scenario.gate(fixture.input).passed).toBe(false);

    const jump = await gateFixture(scenario, { rawJump: true });
    expect(scenario.gate(jump.input).passed).toBe(false);

    const changedSource = createAuthoredWorkbookScenarioGateEvidenceCollector({ scenario, workspace: fakeGuardedWorkspace({ failGuard: true }), session: sessionFor((await tempWorkspace()).root), trace: lessons003004Trace(), probe: fakeProbe() });
    await expect(changedSource.captureBaseline()).rejects.toThrow(/guard changed/);

    const rawPublic = authoredWorkbookScenarioById("lesson-013-operator-judgement");
    const root = await tempWorkspace();
    await writeFile(join(root.root, "factory/refactor/.tmp/events/extra.jsonl"), "{}\n");
    await expect(async () => dockerProbeCreateArguments({ name: "x", probeWorkspace: root.root, nodeModules: root.root })).not.toThrow();

    const aliasRoot = await tempWorkspace();
    await rm(join(aliasRoot.root, "calculator/src/index.ts"));
    await symlink(resolve(sourceRoot, "calculator/src/index.ts"), join(aliasRoot.root, "calculator/src/index.ts"));
    const aliasCollector = createAuthoredWorkbookScenarioGateEvidenceCollector({ scenario: rawPublic, workspace: fakeGuardedWorkspace(), session: sessionFor(aliasRoot.root), trace: lesson013Trace(), probe: fakeProbe() });
    await expect(aliasCollector.captureBaseline()).rejects.toThrow(/ordinary file|alias|symlink/);
  }, 20_000);

  it("supports AbortSignal with a fixed sanitized error", async () => {
    const workspace = await tempWorkspace();
    const controller = new AbortController();
    controller.abort();
    const collector = createAuthoredWorkbookScenarioGateEvidenceCollector({ scenario: authoredWorkbookScenarioById("lesson-001-headless-boundary"), workspace: fakeGuardedWorkspace(), session: sessionFor(workspace.root), trace: lesson001Trace(), signal: controller.signal, probe: fakeProbe() });
    await expect(collector.captureBaseline()).rejects.toThrow("Authored workbook gate evidence collection was cancelled.");
  });
});

async function gateFixture(scenario: AuthoredWorkbookScenarioDescriptor, options: { dirtyAfterCommit?: boolean; wrongCommitIdentity?: boolean; committerMismatch?: boolean; extraCommittedIgnoredFile?: boolean; alternateCommittedSource?: boolean; extraArtifact?: boolean; rawJump?: boolean } = {}): Promise<{ input: any; root?: string }> {
  if (scenario.id === "primer-validation-misconception") {
    const trace = primerTrace();
    const sessionRoot = await tempSessionRoot(trace.internalEvents);
    const collector = createAuthoredWorkbookScenarioGateEvidenceCollector({ scenario, workspace: fakeGuardedWorkspace(), session: { contentRoot: "/tmp/content", sessionId: "s", sessionRoot, workspacesRoot: "/tmp/ws", workspaceRoots: {} }, trace, probe: fakeProbe() });
    await collector.captureBaseline();
    return { input: await collector.collectGateInput() };
  }

  const workspace = await tempWorkspace();
  const trace = traceForScenario(scenario.id, options);
  const session = sessionFor(workspace.root);
  await writeSessionEvents(session.sessionRoot, trace.internalEvents);
  const collector = createAuthoredWorkbookScenarioGateEvidenceCollector({ scenario, workspace: fakeGuardedWorkspace(), session, trace, commandStubHandle: scenario.stubLessonNumber === undefined ? undefined : { hostEvidencePath: workspace.evidencePath, runId: RUN_ID }, probe: fakeProbe() });
  await collector.captureBaseline();
  if (scenario.id === "lessons-003-004-evidence-feedback") {
    await writeFile(join(workspace.root, "calculator/src/index.ts"), multiplyOnlySource(await readFile(join(workspace.root, "calculator/src/index.ts"), "utf8")));
    await collector.captureGateCheckpoint("lessons003004:after-multiply-only");
    await writeLessons003004Final(workspace.root, options);
    await writeFile(workspace.evidencePath, lessons003004Evidence().map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  } else if (scenario.id === "lesson-013-operator-judgement") {
    await writeLesson013Final(workspace.root, options);
    await writeFile(workspace.evidencePath, lesson013Evidence().map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  }
  const input = await collector.collectGateInput();
  return { input, root: workspace.root };
}

async function tempWorkspace(): Promise<{ root: string; evidencePath: string }> {
  const sessionRoot = await mkdtemp(join(tmpdir(), "authored-gate-test-session-"));
  tempRoots.push(sessionRoot);
  const rootPath = join(sessionRoot, "workspaces/refactor-line");
  await mkdir(rootPath, { recursive: true });
  const root = await realpath(rootPath);
  await mkdir(join(root, "factory/.tmp/authored-eval-command-stubs"), { recursive: true });
  await mkdir(join(root, "factory/refactor/.tmp/events"), { recursive: true });
  await mkdir(join(root, ".tmp"), { recursive: true });
  await cp(resolve(sourceRoot, "calculator"), join(root, "calculator"), { recursive: true });
  await writeFile(join(root, ".gitignore"), "factory/**/.tmp/\n.tmp/\n");
  const evidencePath = join(root, "factory/.tmp/authored-eval-command-stubs/invocations.jsonl");
  await writeFile(evidencePath, "");
  await git(root, "init", "-q", "-b", "main");
  await git(root, "config", "--local", "user.name", "Tutorial Factory Worker");
  await git(root, "config", "--local", "user.email", "factory-worker@example.invalid");
  await git(root, "config", "--local", "user.useConfigOnly", "true");
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", "Materialize tutorial workspace refactor-line");
  return { root, evidencePath };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", GIT_CONFIG_NOSYSTEM: "1" } })).stdout.trim();
}

function sessionFor(root: string) {
  const sessionRoot = dirname(dirname(root));
  return { contentRoot: join(sessionRoot, "content"), sessionId: "session-test", sessionRoot, workspacesRoot: join(sessionRoot, "workspaces"), workspaceRoots: { "refactor-line": root } };
}

async function writeSessionEvents(sessionRoot: string, events: readonly unknown[]): Promise<void> {
  await mkdir(join(sessionRoot, "workbook"), { recursive: true });
  await writeFile(join(sessionRoot, "workbook/events.jsonl"), events.map((event, index) => JSON.stringify(timelineRecord(event, index + 1))).join("\n") + (events.length ? "\n" : ""));
}

async function tempSessionRoot(events: unknown[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "authored-gate-test-session-"));
  tempRoots.push(root);
  await mkdir(join(root, "workbook"), { recursive: true });
  if (events.length) await writeFile(join(root, "workbook/events.jsonl"), events.map((event, index) => JSON.stringify(timelineRecord(event, index + 1))).join("\n") + "\n");
  return root;
}

function timelineRecord(event: unknown, sequence: number): unknown {
  if (!event || typeof event !== "object" || Array.isArray(event)) return event;
  const record = event as Record<string, unknown>;
  return {
    ...record,
    id: typeof record.id === "string" && record.id ? record.id : `test-event-${sequence}-${randomUUID()}`,
    sequence: Number.isInteger(record.sequence) && (record.sequence as number) > 0 ? record.sequence : sequence,
    at: typeof record.at === "string" && record.at ? record.at : new Date(Date.UTC(2026, 7, 30, 0, 0, sequence)).toISOString()
  };
}

function fakeGuardedWorkspace(options: { failGuard?: boolean } = {}) {
  return { sourceTutorialRoot: "/source", root: "/disposable", assertGuardedStateUnchanged: async () => { if (options.failGuard) throw new Error("guard changed"); } };
}

function fakeProbe(): AuthoredGateEvidenceProbe {
  return { async probeCalculator({ workspaceRoot, label }) {
    const source = await readFile(join(workspaceRoot, "calculator/src/index.ts"), "utf8");
    const cases = [] as Array<{ input: string; output: number }>;
    if (source.includes('if (word === "multiply") {\n      const first = readFirstOperand("by");')) cases.push({ input: "multiply 6 by 7", output: 42 });
    if (source.includes('if (word === "divide") {\n      const first = readFirstOperand("by");')) cases.push({ input: "divide 84 by 2", output: 42 });
    return { label, sourceSha256: sha256Text(source), testStatus: "passed", qualityStatus: cases.length === 2 ? "passed" : "failed", ...(cases.length === 2 ? { qualityOutput: "All quality checks passed." } : {}), cases };
  } };
}

function traceForScenario(id: string, options: { rawJump?: boolean }): AuthoredWorkbookEvalSessionTrace {
  if (id === "lesson-001-headless-boundary") return lesson001Trace();
  if (id === "lessons-003-004-evidence-feedback") return lessons003004Trace(options);
  if (id === "lesson-013-operator-judgement") return lesson013Trace(options);
  return primerTrace();
}

function primerTrace(): AuthoredWorkbookEvalSessionTrace {
  const trace = createEmptyAuthoredWorkbookEvalSessionTrace("primer-validation-misconception");
  trace.internalEvents = [raw("workbook_introduction_completed"), raw("attempt_accepted", "what-is-a-factory", "lesson--what-is-a-factory--factory-vs-repl", "reflection"), raw("block_completed", "what-is-a-factory", "lesson--what-is-a-factory--factory-vs-repl")];
  trace.reflections = [
    { blockId: "lesson--what-is-a-factory--factory-vs-repl", role: "learner", text: "A factory requires more trust/faith in the LLM." },
    { blockId: "lesson--what-is-a-factory--factory-vs-repl", role: "tutor", text: "The validation loop exists because you do not trust the model unchecked." },
    { blockId: "lesson--what-is-a-factory--factory-vs-repl", role: "learner", text: "We do not trust the model by default. The validation loop and up-front investment allow more autonomy with human next steps." }
  ];
  return trace;
}

function lesson001Trace(): AuthoredWorkbookEvalSessionTrace {
  const trace = createEmptyAuthoredWorkbookEvalSessionTrace("lesson-001-headless-boundary");
  const commands: Array<[string, string]> = [
    ["run-simple-pi-prompt", 'pi -p "What is the capital of France?"'],
    ["run-supplied-command", 'echo "Describe what this calculator does, in three sentences." \\\n  | (cd calculator && pi --no-session --tools read,grep,find,ls -p)'],
    ["change-job", 'echo "What files make up this calculator, and what does each one appear to do?" \\\n  | (cd calculator && pi --no-session --tools read,grep,find,ls -p)']
  ];
  trace.internalEvents = [raw("workbook_introduction_completed")];
  trace.publicStates = [];
  for (const [index, [suffix, command]] of commands.entries()) {
    const blockId = `lesson--001-run-an-agent-headlessly--${suffix}`;
    const attemptId = `a${index + 1}`;
    trace.terminalTranscript.push({ blockId, direction: "input", text: command }, { blockId, direction: "output", text: "ok\n" });
    trace.internalEvents.push({ type: "terminal-command-submitted", attemptId, lessonId: "001-run-an-agent-headlessly", blockId, command, terminalSessionId: `${attemptId}-terminal` } as any, { type: "terminal-command-finished", attemptId, exitStatus: 0, evidenceRef: `${attemptId}-evidence` } as any, { type: "attempt_accepted", attemptId, lessonId: "001-run-an-agent-headlessly", blockId, version: 1, kind: "terminal", summary: "accepted" } as any);
    trace.publicStates.push(publicState(blockId, 1));
  }
  trace.internalEvents.push(raw("attempt_accepted", "001-run-an-agent-headlessly", "lesson--001-run-an-agent-headlessly--reflection", "reflection"), raw("block_completed", "001-run-an-agent-headlessly", "lesson--001-run-an-agent-headlessly--reflection"));
  trace.reflections = [{ blockId: "lesson--001-run-an-agent-headlessly--reflection", role: "learner", text: "The quoted text is the job. The pipe, subshell, cd, and Pi invocation are the harness. -p and --no-session make it exit with no conversation. read, grep, find, and ls can inspect but cannot edit, write, or mutate the calculator." }];
  return trace;
}

function lessons003004Trace(options: { rawJump?: boolean } = {}): AuthoredWorkbookEvalSessionTrace {
  const trace = createEmptyAuthoredWorkbookEvalSessionTrace("lessons-003-004-evidence-feedback");
  trace.internalEvents = [raw("workbook_introduction_completed"), raw("attempt_accepted", "003-build-a-validator", "lesson--003-build-a-validator--implementation-order", "terminal"), raw("attempt_accepted", "003-build-a-validator", "lesson--003-build-a-validator--checks", "reflection"), raw("block_completed", "003-build-a-validator", "lesson--003-build-a-validator--checks"), raw("block_completed", "004-feed-the-findings-back", "lesson--004-feed-the-findings-back--key-concept"), raw("attempt_accepted", "004-feed-the-findings-back", "lesson--004-feed-the-findings-back--implementation-order", "terminal"), raw("attempt_accepted", "004-feed-the-findings-back", "lesson--004-feed-the-findings-back--checks", "reflection"), raw("block_completed", "004-feed-the-findings-back", "lesson--004-feed-the-findings-back--checks")];
  if (options.rawJump) trace.internalEvents.push({ type: "lesson_jump_started", lessonId: "copied" } as any);
  trace.terminalTranscript = [
    { blockId: "lesson--003-build-a-validator--implementation-order", direction: "input", text: "export PATH=/stubs:$PATH\ncat refactor-validate.md \\\n  | (cd ../calculator && pi --no-session --tools read,grep,find,ls,bash -p)" },
    { blockId: "lesson--003-build-a-validator--implementation-order", direction: "observer", text: "Feedback: carry the baseline with a guard and tee findings." },
    { blockId: "lesson--004-feed-the-findings-back--implementation-order", direction: "input", text: "export PATH=/stubs:$PATH\n./factory/refactor-validate.sh" },
    { blockId: "lesson--004-feed-the-findings-back--implementation-order", direction: "observer", text: "Feedback: rerunning the validator only does not append findings to the doer context." },
    { blockId: "lesson--004-feed-the-findings-back--implementation-order", direction: "input", text: "export PATH=/stubs:$PATH\n" + lesson004MultiplyCommand() },
    { blockId: "lesson--004-feed-the-findings-back--implementation-order", direction: "observer", text: "Feedback: multiply is fixed but divide still has findings." },
    { blockId: "lesson--004-feed-the-findings-back--implementation-order", direction: "input", text: "export PATH=/stubs:$PATH\n" + lesson004DivideCommand() }
  ];
  trace.reflections = [{ blockId: "lesson--003-build-a-validator--checks", role: "learner", text: "The validator announces validation, uses read/grep/find/ls/bash not edit/write, starts VERDICT, quotes evidence, tees findings, and refuses without baseline." }, { blockId: "lesson--004-feed-the-findings-back--checks", role: "learner", text: "I reran, carried findings into context, preserved baseline, and decided when to stop." }];
  return trace;
}

function lesson013Trace(options: { rawJump?: boolean } = {}): AuthoredWorkbookEvalSessionTrace {
  const trace = createEmptyAuthoredWorkbookEvalSessionTrace("lesson-013-operator-judgement");
  trace.internalEvents = [raw("workbook_introduction_completed"), raw("attempt_accepted", "013-oversee-the-orchestrator", "lesson--013-oversee-the-orchestrator--implementation-order", "terminal"), raw("attempt_accepted", "013-oversee-the-orchestrator", "lesson--013-oversee-the-orchestrator--checks", "reflection"), raw("block_completed", "013-oversee-the-orchestrator", "lesson--013-oversee-the-orchestrator--checks")];
  if (options.rawJump) trace.internalEvents.push({ type: "lesson_jump_started", lessonId: "copied" } as any);
  trace.terminalTranscript = [{ blockId: "lesson--013-oversee-the-orchestrator--implementation-order", direction: "input", text: 'export PATH=/stubs:$PATH\n./factory/refactor/run.sh > .tmp/refactor-run.log 2>&1 &\n./factory/steer.sh refactor "Finish multiply and divide independently before validation."\n./factory/watch.sh refactor > .tmp/refactor-watch.log 2>&1 &\n./factory/ask.sh refactor "What happened in this run?"' }];
  trace.reflections = [{ blockId: "lesson--013-oversee-the-orchestrator--checks", role: "learner", text: "The factory is factory/. The line is refactor/. The orchestrator is run.sh: it starts the line, hands inputs to stations, branches on VERDICT, handles failures with repair, and stops by counters. Prompt/script pairs are stations. ask.sh is no-tools because the record is supplied. I am the operator. Repeated FAIL can mean an unmet criterion or missing/unreachable evidence. Cost, regressions, and whether the result is worth it are still operator judgement." }];
  return trace;
}

function raw(type: string, lessonId?: string, blockId?: string, kind?: string): any {
  if (type === "attempt_accepted") return { type, attemptId: randomUUID(), lessonId, blockId, version: 1, kind, summary: "accepted" };
  return lessonId ? { type, lessonId, blockId } : { type };
}

function publicState(blockId: string, terminalRevision: number): any {
  return { label: `${blockId}:rev`, state: { workbook: { title: "Synthetic" }, introduction: "Intro", introductionComplete: true, chapters: [], progress: { activeLessonId: "001-run-an-agent-headlessly", activeBlockId: blockId, completedLessons: [], blocks: [{ id: blockId, ready: true, active: false, completed: true, verified: true, emerged: true, terminalRevision, checkpoint: { status: "accepted", evidence: { kind: "terminal", text: "ok" } }, terminal: { phase: "complete", message: "ok" } }], reflections: {}, reflectionConversations: {} }, adapter: {}, timeline: [] } };
}

async function writeLessons003004Final(root: string, options: { extraArtifact?: boolean }) {
  const prompt = await readFile(join(prerequisitesRoot, "lesson-004-prerequisites/factory/refactor-validate.md"), "utf8");
  const script = await readFile(join(prerequisitesRoot, "lesson-004-prerequisites/factory/refactor-validate.sh"), "utf8");
  await writeFile(join(root, "factory/refactor-validate.md"), prompt);
  await writeFile(join(root, "factory/refactor-validate.sh"), script);
  await mkdir(join(root, "factory/.tmp"), { recursive: true });
  await writeFile(join(root, "factory/.tmp/refactor-quality-before.txt"), "Findings reported by: eslint.\n- calculator/src/index.ts duplicated operator branch parser\n");
  await writeFile(join(root, "factory/.tmp/refactor-validate-findings.txt"), "VERDICT: PASS\n\nEVIDENCE:\n- quality passed\n");
  await writeFile(join(root, "calculator/src/index.ts"), completeSource(await readFile(join(root, "calculator/src/index.ts"), "utf8")));
  if (options.extraArtifact) await writeFile(join(root, "factory/.tmp/unexpected.txt"), "extra");
}

async function writeLesson013Final(root: string, options: { dirtyAfterCommit?: boolean; wrongCommitIdentity?: boolean; committerMismatch?: boolean; extraCommittedIgnoredFile?: boolean; alternateCommittedSource?: boolean }) {
  await writeFile(join(root, ".tmp/refactor-run.log"), "Starting doer\nStarting validation\nStarting commit\nLine finished\n");
  await writeFile(join(root, ".tmp/refactor-watch.log"), "queue_update\n→ read\nauthored-eval accepted early steer\n→ edit\n");
  await mkdir(join(root, "factory/refactor/.tmp"), { recursive: true });
  await writeFile(join(root, "factory/refactor/.tmp/quality-before.txt"), "Findings reported by: eslint.\n");
  await writeFile(join(root, "factory/refactor/.tmp/evidence.txt"), "=== QUALITY BEFORE (recorded before the doer ran) ===\nFindings reported by: eslint.\n\n=== QUALITY NOW ===\nAll quality checks passed.\n\n=== TESTS ===\nTests: PASS\n\n=== WORKING DIFF ===\n+    const readFirstOperand = (separator: \"and\" | \"from\" | \"by\"): number => {\n+      const first = readFirstOperand(\"by\");\n");
  await writeFile(join(root, "factory/refactor/.tmp/validate-findings.txt"), "VERDICT: PASS\n");
  await writeFile(join(root, "factory/refactor/.tmp/commit-message.txt"), "Refactor calculator operand parsing\n\nUse a shared operand reader across prefix operator branches.");
  await writeFile(join(root, "calculator/src/index.ts"), completeSource(await readFile(join(root, "calculator/src/index.ts"), "utf8")));
  if (options.alternateCommittedSource) await writeFile(join(root, "calculator/src/alternate.ts"), "export const alternate = true;\n");
  if (options.extraCommittedIgnoredFile) await writeFile(join(root, ".tmp/private-ignored-evidence.txt"), "must not be committed\n");
  if (options.wrongCommitIdentity || options.committerMismatch) {
    await git(root, "config", "--local", "user.name", "Wrong Worker");
    await git(root, "config", "--local", "user.email", "wrong@example.invalid");
  }
  await git(root, "add", "calculator/src/index.ts");
  if (options.alternateCommittedSource) await git(root, "add", "calculator/src/alternate.ts");
  if (options.extraCommittedIgnoredFile) await git(root, "add", "-f", ".tmp/private-ignored-evidence.txt");
  await git(root, "commit", "-q", ...(options.committerMismatch ? ["--author", "Tutorial Factory Worker <factory-worker@example.invalid>"] : []), "-F", join(root, "factory/refactor/.tmp/commit-message.txt"));
  if (options.dirtyAfterCommit) await writeFile(join(root, "calculator/src/index.ts"), (await readFile(join(root, "calculator/src/index.ts"), "utf8")) + "\n// dirty\n");
}

function lessons003004Evidence(): AuthoredCommandInvocationEvidence[] {
  return [stub("doer", { mutation: "partial-refactor" }), stub("validator", { verdict: "FAIL", mutation: "none", tools: "read,grep,find,ls,bash" }), stub("validator", { verdict: "FAIL", mutation: "none", tools: "read,grep,find,ls,bash" }), stub("validator", { verdict: "FAIL", mutation: "none", tools: "read,grep,find,ls,bash" }), stub("validator", { verdict: "FAIL", mutation: "none", tools: "read,grep,find,ls,bash" }), stub("repair", { mutation: "complete-refactor" }), stub("validator", { verdict: "PASS", mutation: "none", tools: "read,grep,find,ls,bash" })];
}

function lesson013Evidence(): AuthoredCommandInvocationEvidence[] {
  return [stub("doer", { mode: "rpc", mutation: "complete-refactor", rpc: { commandCount: 2, earlySteerCount: 1, lateSteerCount: 0, steerSha256: sha256Text(sha256Text("Finish multiply and divide independently before validation.")) } }), stub("validator", { mode: "json", verdict: "PASS", mutation: "none" }), stub("commit", { mode: "json", mutation: "none" }), stub("ask", { mode: "text", tools: "none", mutation: "none" })];
}

function stub(station: AuthoredCommandInvocationEvidence["station"], options: { runId?: string; mode?: "text" | "json" | "rpc"; tools?: AuthoredCommandInvocationEvidence["tools"]; verdict?: "PASS" | "FAIL"; mutation?: AuthoredCommandInvocationEvidence["mutation"]; rpc?: Partial<NonNullable<AuthoredCommandInvocationEvidence["rpc"]>> } = {}): AuthoredCommandInvocationEvidence {
  const mode = options.mode ?? "text";
  return { namespace: AUTHORED_COMMAND_STUB_NAMESPACE, owner: AUTHORED_COMMAND_STUB_OWNER, schemaVersion: AUTHORED_COMMAND_STUB_SCHEMA_VERSION, runId: options.runId ?? RUN_ID, kind: "pi", accepted: true, cwd: station === "ask" ? "factory" : "calculator", mode, tools: options.tools ?? (station === "validator" ? "read,grep,find,ls" : station === "ask" ? "none" : "read,edit,write,grep,find,ls"), station, ...(options.verdict ? { verdict: options.verdict } : {}), mutation: options.mutation ?? "none", ...(mode === "rpc" ? { rpc: { commandCount: 1, promptBytes: 10, promptSha256: "a".repeat(64), earlySteerCount: 0, lateSteerCount: 0, steerBytes: 0, steerSha256: "b".repeat(64), ...(options.rpc ?? {}) } } : { prompt: { bytes: 10, sha256: "a".repeat(64), signals: [] } }), output: { bytes: 10, sha256: "c".repeat(64), eventClasses: mode === "rpc" ? ["response", "agent_end"] : mode === "json" ? ["message_end", "agent_end"] : ["text"] } };
}

function lesson004CurrentEvidenceAndValidationCommand(): string { return String.raw`{
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
rm factory/.tmp/refactor-current-evidence.txt`; }
function lesson004MultiplyCommand(): string { return String.raw`node <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const path = 'calculator/src/index.ts';
let source = readFileSync(path, 'utf8');
source = source.replace(
  '    if (word === "multiply") {\n      const first = read();\n      if (pieces[place++] !== "by") fail();\n      const second = read();\n      return first * second;\n    }',
  '    if (word === "multiply") {\n      const first = readFirstOperand("by");\n      const second = read();\n      return first * second;\n    }'
);
writeFileSync(path, source);
NODE
${lesson004CurrentEvidenceAndValidationCommand()}`; }
function lesson004DivideCommand(): string { return String.raw`(cd factory \
  && cat refactor.md .tmp/refactor-validate-findings.txt \
  | (cd ../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p))
${lesson004CurrentEvidenceAndValidationCommand()}`; }

function multiplyOnlySource(source: string): string {
  return refactorSource(source, false);
}

function completeSource(source: string): string {
  return refactorSource(source, true);
}

function refactorSource(source: string, includeDivide: boolean): string {
  const helper = "\n    const readFirstOperand = (separator: \"and\" | \"from\" | \"by\"): number => {\n      const first = read();\n      if (pieces[place++] !== separator) fail();\n      return first;\n    };\n";
  let next = source.includes("const readFirstOperand = ") ? source : source.replace("\n    // Operators are prefix forms. Each branch repeats the same parser work on\n", helper + "\n    // Operators are prefix forms. Each branch repeats the same parser work on\n");
  next = next
    .replace('    if (word === "add") {\n      const first = read();\n      if (pieces[place++] !== "and") fail();\n      const second = read();\n      return first + second;\n    }', '    if (word === "add") {\n      const first = readFirstOperand("and");\n      const second = read();\n      return first + second;\n    }')
    .replace('    if (word === "subtract") {\n      const first = read();\n      if (pieces[place++] !== "from") fail();\n      const second = read();\n      return second - first;\n    }', '    if (word === "subtract") {\n      const first = readFirstOperand("from");\n      const second = read();\n      return second - first;\n    }')
    .replace('    if (word === "multiply") {\n      const first = read();\n      if (pieces[place++] !== "by") fail();\n      const second = read();\n      return first * second;\n    }', '    if (word === "multiply") {\n      const first = readFirstOperand("by");\n      const second = read();\n      return first * second;\n    }');
  if (includeDivide) next = next.replace('    if (word === "divide") {\n      const first = read();\n      if (pieces[place++] !== "by") fail();\n      const second = read();\n      if (second === 0) fail();\n      return first / second;\n    }', '    if (word === "divide") {\n      const first = readFirstOperand("by");\n      const second = read();\n      if (second === 0) fail();\n      return first / second;\n    }');
  return next;
}

function sha256Text(text: string): string { return createHash("sha256").update(text).digest("hex"); }
