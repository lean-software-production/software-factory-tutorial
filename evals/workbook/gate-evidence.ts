import { execFile, spawn, type ExecFileException } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { chmod, cp, lstat, mkdtemp, open, realpath, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { authoredCalculatorCanonicalRefactorSource, readAuthoredCommandStubEvidence, type AuthoredCommandInvocationEvidence, type AuthoredCommandStubHandle } from "./command-stubs.js";
import { buildBoundedWorkspaceTar } from "./preflight.js";
import { readAuthoredWorkbookTimeline } from "./internal-timeline.js";
import { projectAuthoredWorkbookEvalTrace } from "./public-trace.js";
import type { AuthoredWorkbookEvalArtifactSnapshot, AuthoredWorkbookEvalSessionTrace } from "./types.js";
import {
  authoredWorkbookScenarioPublicArtifactPolicyById,
  createAuthoredWorkbookScenarioGateCheckpointRecorder,
  type AuthoredCalculatorBehaviorProjection,
  type AuthoredWorkbookGateCheckpointLabel,
  type AuthoredWorkbookScenarioDescriptor,
  type AuthoredWorkbookScenarioGateFacts,
  type AuthoredWorkbookScenarioGateInput
} from "./scenarios.js";
import type { AuthoredCurriculumSliceWorkspace } from "./workspace.js";
import type { TutorialSessionPaths } from "../../tutorial-engine/src/session-workspace.js";
import { dockerClientEnvironment, dockerContainerUser, WORKBOOK_TERMINAL_IMAGE } from "../../tutorial-engine/src/workbook/terminal.js";

export const AUTHORED_GATE_EVIDENCE_PUBLIC_ERROR = "Authored workbook gate evidence could not be collected.";
export const AUTHORED_GATE_EVIDENCE_ABORTED_PUBLIC_ERROR = "Authored workbook gate evidence collection was cancelled.";
export const AUTHORED_GATE_EVIDENCE_CLEANUP_PUBLIC_ERROR = "Authored workbook gate evidence cleanup could not be confirmed.";
export const AUTHORED_GATE_EVIDENCE_DOCKER_IMAGE = WORKBOOK_TERMINAL_IMAGE;

const DEFAULT_WORKSPACE_ID = "refactor-line";
const MAX_PRIVATE_SNAPSHOT_FILE_BYTES = 64 * 1024;
const MAX_PRIVATE_SNAPSHOT_TOTAL_BYTES = 256 * 1024;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024;
const MAX_GIT_STATUS_FILE_BYTES = 16 * 1024 * 1024;
const DEFAULT_GIT_TIMEOUT_MS = 10_000;
const GIT_EXECUTABLE = "/usr/bin/git";
const DEFAULT_DOCKER_TIMEOUT_MS = 30_000;
const CALCULATOR_SOURCE = "calculator/src/index.ts";
const CANONICAL_DUPLICATION_QUALITY_BASELINE = "Findings reported by: eslint.\n- calculator/src/index.ts duplicated operator branch parser\n";
const INVALID_EXPECTED_COMMIT = "invalid-authored-gate-expected-commit";
const INVALID_EXPECTED_TREE = "invalid-authored-gate-expected-tree";
const EXPECTED_WORKER_IDENTITY = "Tutorial Factory Worker <factory-worker@example.invalid>";
const EXPECTED_COMMIT_MESSAGE = "Refactor calculator operand parsing\n\nUse a shared operand reader across prefix operator branches.";

export interface AuthoredGateEvidenceCommandResult {
  status: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export type AuthoredGateEvidenceGitRunner = (request: { cwd: string; args: readonly string[]; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal }) => Promise<AuthoredGateEvidenceCommandResult>;
export type AuthoredGateEvidenceDockerRunner = (request: { file: "docker"; args: readonly string[]; cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal; input?: Buffer; maxStdoutBytes?: number; maxStderrBytes?: number }) => Promise<AuthoredGateEvidenceCommandResult>;

export interface AuthoredGateEvidenceProbeRequest {
  workspaceRoot: string;
  label: string;
  signal?: AbortSignal;
}

export interface AuthoredGateEvidenceProbe {
  probeCalculator(request: AuthoredGateEvidenceProbeRequest): Promise<AuthoredCalculatorBehaviorProjection>;
}

export interface AuthoredWorkbookScenarioGateEvidenceOptions {
  scenario: AuthoredWorkbookScenarioDescriptor;
  workspace: Pick<AuthoredCurriculumSliceWorkspace, "assertGuardedStateUnchanged" | "sourceTutorialRoot" | "root">;
  session: TutorialSessionPaths;
  trace: AuthoredWorkbookEvalSessionTrace;
  commandStubHandle?: Pick<AuthoredCommandStubHandle, "hostEvidencePath" | "runId">;
  workspaceId?: string;
  probe?: AuthoredGateEvidenceProbe;
  gitRunner?: AuthoredGateEvidenceGitRunner;
  signal?: AbortSignal;
}

export interface AuthoredGateEvidenceGitTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  objectId: string;
}

export interface AuthoredGateEvidenceWorkspaceManifestEntry {
  path: string;
  fingerprint: string;
}

export interface AuthoredGateEvidenceGitSnapshot {
  head?: string;
  tree?: string;
  status: string;
  subjects: readonly string[];
  topCommit?: string;
  topCommitTree?: string;
  topCommitBody?: string;
  topCommitParents: readonly string[];
  topCommitIdentity?: string;
  topCommitAuthorIdentity?: string;
  topCommitCommitterIdentity?: string;
  topCommitRaw?: string;
  configuredIdentity?: string;
  treeManifest: readonly AuthoredGateEvidenceGitTreeEntry[];
}

export interface AuthoredGateEvidenceRunBaseline {
  scenarioId: string;
  workspaceRoot?: string;
  calculatorSourceSha256?: string;
  calculatorSourceContent?: string;
  workspaceManifest?: readonly AuthoredGateEvidenceWorkspaceManifestEntry[];
  git?: AuthoredGateEvidenceGitSnapshot;
}

export interface AuthoredWorkbookScenarioGateEvidenceCollector {
  readonly baseline?: AuthoredGateEvidenceRunBaseline;
  captureBaseline(): Promise<AuthoredGateEvidenceRunBaseline>;
  captureGateCheckpoint(label: AuthoredWorkbookGateCheckpointLabel): Promise<void>;
  collectGateInput(): Promise<AuthoredWorkbookScenarioGateInput>;
}

interface CheckpointEvidence {
  label: AuthoredWorkbookGateCheckpointLabel;
  behavior?: AuthoredCalculatorBehaviorProjection;
}

type FileIdentity = { dev: number; ino: number; nlink: number; size: number; mode: number };
type GitIndexEntry = { path: string; mode: "100644" | "100755"; objectId: string };
type GitStatusCode = "A" | "D" | "M" | "T";

const execFileAsync = promisify(execFile);

export function createAuthoredWorkbookScenarioGateEvidenceCollector(options: AuthoredWorkbookScenarioGateEvidenceOptions): AuthoredWorkbookScenarioGateEvidenceCollector {
  const checkpointRecorder = createAuthoredWorkbookScenarioGateCheckpointRecorder(options.scenario);
  const checkpoints = new Map<AuthoredWorkbookGateCheckpointLabel, CheckpointEvidence>();
  let baseline: AuthoredGateEvidenceRunBaseline | undefined;
  return {
    get baseline() { return baseline; },
    async captureBaseline() {
      baseline = await captureAuthoredWorkbookScenarioRunBaseline(options);
      return baseline;
    },
    async captureGateCheckpoint(label) {
      throwIfAborted(options.signal);
      if (!baseline) throw new AuthoredGateEvidenceError("Gate checkpoint captured before the immutable run baseline.");
      checkpointRecorder.captureGateCheckpoint(label);
      const workspaceRoot = learnerWorkspaceRoot(options.session, options.workspaceId);
      const behavior = workspaceRoot ? await (options.probe ?? new DockerAuthoredGateEvidenceProbe()).probeCalculator({ workspaceRoot, label: publicProbeLabel(label), signal: options.signal }) : undefined;
      checkpoints.set(label, deepFreeze({ label, ...(behavior ? { behavior } : {}) }));
    },
    async collectGateInput() {
      if (!baseline) throw new AuthoredGateEvidenceError("Gate evidence baseline was not captured before scenario drive.");
      return collectAuthoredWorkbookScenarioGateInput({ ...options, baseline, checkpoints: [...checkpoints.values()] });
    }
  };
}

export async function captureAuthoredWorkbookScenarioRunBaseline(options: AuthoredWorkbookScenarioGateEvidenceOptions): Promise<AuthoredGateEvidenceRunBaseline> {
  throwIfAborted(options.signal);
  await options.workspace.assertGuardedStateUnchanged();
  const workspaceRoot = learnerWorkspaceRoot(options.session, options.workspaceId);
  const calculatorSource = workspaceRoot ? await readStrictWorkspaceFile(workspaceRoot, CALCULATOR_SOURCE, { signal: options.signal }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }) : undefined;
  const manifest = workspaceRoot ? await workspaceTreeManifest(workspaceRoot, options.signal) : undefined;
  const git = workspaceRoot ? await readGitSnapshot(workspaceRoot, options.gitRunner ?? defaultGitRunner, options.signal) : undefined;
  return deepFreeze({
    scenarioId: options.scenario.id,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    ...(calculatorSource ? { calculatorSourceSha256: sha256Text(calculatorSource.content), calculatorSourceContent: calculatorSource.content } : {}),
    ...(manifest ? { workspaceManifest: manifest } : {}),
    ...(git ? { git } : {})
  });
}

export async function collectAuthoredWorkbookScenarioGateInput(options: AuthoredWorkbookScenarioGateEvidenceOptions & { baseline: AuthoredGateEvidenceRunBaseline; checkpoints?: readonly CheckpointEvidence[] }): Promise<AuthoredWorkbookScenarioGateInput> {
  try {
    throwIfAborted(options.signal);
    await options.workspace.assertGuardedStateUnchanged();
    const workspaceRoot = learnerWorkspaceRoot(options.session, options.workspaceId);
    const artifactPolicy = authoredWorkbookScenarioPublicArtifactPolicyById(options.scenario.id);
    const capturedArtifacts = workspaceRoot ? await snapshotExactWorkspaceFiles(workspaceRoot, artifactPolicy.artifactAllowlist, options.signal) : [];
    assertExactSnapshotPaths(capturedArtifacts, artifactPolicy.artifactAllowlist, "workspace evidence files");
    const artifactSnapshots = copyArtifactSnapshots(capturedArtifacts);
    const workspaceFileSnapshots = copyArtifactSnapshots(capturedArtifacts);

    const rawEvents = options.scenario.runnerPrivate?.gateEvidence.rawWorkbookTimeline ? await readAuthoredWorkbookTimeline(options.session.sessionRoot) : [];
    options.trace.internalEvents = rawEvents;
    options.trace.artifacts = copyArtifactSnapshots(capturedArtifacts);
    const traceForPublicProjection = { ...options.trace, internalEvents: rawEvents.filter((event) => event.type !== "lesson_jump_started") };
    const publicTrace = projectAuthoredWorkbookEvalTrace(traceForPublicProjection);

    const commandInvocations = await readCommandEvidenceForScenario(options.scenario, options.commandStubHandle, options.signal);
    const facts = await deriveScenarioFacts({ ...options, workspaceRoot, commandInvocations, artifactSnapshots, workspaceFileSnapshots, rawEvents });
    const input: AuthoredWorkbookScenarioGateInput = {
      trace: publicTrace,
      commandInvocations,
      artifactSnapshots,
      workspaceFileSnapshots,
      rawEvents,
      facts
    };
    return deepFreeze(input);
  } catch (error) {
    if (options.signal?.aborted) throw new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_ABORTED_PUBLIC_ERROR, error);
    if (error instanceof AuthoredGateEvidenceError) throw error;
    throw new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_PUBLIC_ERROR, error);
  }
}

async function deriveScenarioFacts(options: AuthoredWorkbookScenarioGateEvidenceOptions & { baseline: AuthoredGateEvidenceRunBaseline; checkpoints?: readonly CheckpointEvidence[]; workspaceRoot?: string; commandInvocations: readonly AuthoredCommandInvocationEvidence[]; artifactSnapshots: readonly AuthoredWorkbookEvalArtifactSnapshot[]; workspaceFileSnapshots: readonly AuthoredWorkbookEvalArtifactSnapshot[]; rawEvents: readonly { type?: string }[] }): Promise<AuthoredWorkbookScenarioGateFacts> {
  const finalSource = options.workspaceRoot ? await readStrictWorkspaceFile(options.workspaceRoot, CALCULATOR_SOURCE, { signal: options.signal }).then((file) => file.content).catch(() => undefined) : undefined;
  const finalGit = options.workspaceRoot ? await readGitSnapshot(options.workspaceRoot, options.gitRunner ?? defaultGitRunner, options.signal) : undefined;
  const behaviorTimeline = (options.checkpoints ?? []).map((checkpoint) => checkpoint.behavior).filter((value): value is AuthoredCalculatorBehaviorProjection => value !== undefined);
  const finalBehavior = options.workspaceRoot && finalSource ? await (options.probe ?? new DockerAuthoredGateEvidenceProbe()).probeCalculator({ workspaceRoot: options.workspaceRoot, label: "final", signal: options.signal }) : undefined;
  const outsideAllowlist = options.workspaceRoot && options.baseline.workspaceManifest ? changedWorkspacePathsOutsideAllowlist(options.baseline.workspaceManifest, await workspaceTreeManifest(options.workspaceRoot, options.signal), options.scenario) : [];

  const gitExpectations = deriveGitExpectations(options.scenario, options.baseline, finalGit, finalSource);
  const facts: AuthoredWorkbookScenarioGateFacts = {
    authoredSourceChanged: false,
    disposableCurriculumChanged: false,
    lessonJumpStarted: options.rawEvents.some((event) => event.type === "lesson_jump_started"),
    commandStubsCreated: options.commandStubHandle !== undefined,
    learnerWorkspaceChangedOutsideAllowlist: outsideAllowlist,
    ...(finalGit ? {
      calculatorGitStatus: finalGit.status,
      calculatorHeadChanged: finalGit.head !== undefined && options.baseline.git?.head !== undefined ? finalGit.head !== options.baseline.git.head : false,
      calculatorCommitSubjects: finalGit.subjects,
      calculatorTopCommit: finalGit.topCommit,
      calculatorTopCommitTree: finalGit.topCommitTree
    } : {}),
    ...(gitExpectations.expectedTopCommit ? { calculatorExpectedTopCommit: gitExpectations.expectedTopCommit } : {}),
    ...(gitExpectations.expectedTopCommitTree ? { calculatorExpectedTopCommitTree: gitExpectations.expectedTopCommitTree } : {}),
    ...(options.baseline.calculatorSourceSha256 ? { lesson001CalculatorBeforeSha256: options.baseline.calculatorSourceSha256 } : {}),
    ...(finalSource ? { lesson001CalculatorAfterSha256: sha256Text(finalSource) } : {}),
    ...(options.commandStubHandle ? { expectedCommandStubRunId: options.commandStubHandle.runId } : {}),
    ...(expectedCanonicalBaselineFromBaseline(options.baseline) ? {
      expectedCanonicalBaselineContent: expectedCanonicalBaselineFromBaseline(options.baseline)!,
      expectedCanonicalBaselineSha256: sha256Text(expectedCanonicalBaselineFromBaseline(options.baseline)!)
    } : {}),
    ...(finalBehavior ? { calculatorBehaviorProjection: finalBehavior } : {}),
    ...(behaviorTimeline.length ? { calculatorBehaviorTimeline: behaviorTimeline } : {})
  };
  return facts;
}

function deriveGitExpectations(scenario: AuthoredWorkbookScenarioDescriptor, baseline: AuthoredGateEvidenceRunBaseline, finalGit: AuthoredGateEvidenceGitSnapshot | undefined, finalSource: string | undefined): { expectedTopCommit?: string; expectedTopCommitTree?: string } {
  if (!finalGit?.topCommit || !finalGit.topCommitTree) return {};
  if (scenario.id !== "lesson-013-operator-judgement") return {};
  const expectedSource = baseline.calculatorSourceContent === undefined ? undefined : completeRefactorSource(baseline.calculatorSourceContent);
  const expectedTree = expectedSource === undefined || baseline.git === undefined ? undefined : computeExpectedLesson013Tree(baseline.git.treeManifest, expectedSource);
  const expectedCommit = expectedTree === undefined || baseline.git?.head === undefined || finalGit.topCommitRaw === undefined ? undefined : computeExpectedLesson013Commit(finalGit.topCommitRaw, baseline.git.head, expectedTree);
  const valid = baseline.git?.head !== undefined
    && finalGit.topCommitParents.length === 1
    && finalGit.topCommitParents[0] === baseline.git.head
    && finalGit.topCommitBody?.trimEnd() === EXPECTED_COMMIT_MESSAGE
    && finalGit.topCommitAuthorIdentity === EXPECTED_WORKER_IDENTITY
    && finalGit.topCommitCommitterIdentity === EXPECTED_WORKER_IDENTITY
    && finalGit.configuredIdentity === EXPECTED_WORKER_IDENTITY
    && finalGit.status === ""
    && expectedSource !== undefined
    && finalSource === expectedSource
    && expectedTree !== undefined
    && finalGit.topCommitTree === expectedTree
    && expectedCommit !== undefined
    && finalGit.topCommit === expectedCommit;
  return { expectedTopCommit: valid ? expectedCommit : INVALID_EXPECTED_COMMIT, expectedTopCommitTree: valid ? expectedTree : INVALID_EXPECTED_TREE };
}

async function readCommandEvidenceForScenario(scenario: AuthoredWorkbookScenarioDescriptor, handle: Pick<AuthoredCommandStubHandle, "hostEvidencePath" | "runId"> | undefined, signal?: AbortSignal): Promise<AuthoredCommandInvocationEvidence[]> {
  throwIfAborted(signal);
  if (scenario.stubLessonNumber === undefined) {
    if (handle) throw new AuthoredGateEvidenceError("Lesson 001 and primer scenarios must not create authored command stubs.");
    return [];
  }
  if (scenario.runnerPrivate?.gateEvidence.commandStubInvocations && !handle) throw new AuthoredGateEvidenceError("Scenario requires authored command-stub evidence, but no current handle was provided.");
  if (!handle) return [];
  const records = await readAuthoredCommandStubEvidence(handle.hostEvidencePath);
  for (const record of records) {
    if (record.runId !== handle.runId || record.namespace !== "evals/workbook/authored-workbook/command-stubs" || record.owner !== "authored-eval" || record.schemaVersion !== 1) {
      throw new AuthoredGateEvidenceError("Authored command-stub evidence did not belong to the current run.");
    }
  }
  return records;
}

function expectedCanonicalBaselineFromBaseline(baseline: AuthoredGateEvidenceRunBaseline): string | undefined {
  if (baseline.calculatorSourceContent === undefined) return undefined;
  return completeRefactorSource(baseline.calculatorSourceContent) === baseline.calculatorSourceContent ? undefined : CANONICAL_DUPLICATION_QUALITY_BASELINE;
}

function publicProbeLabel(label: AuthoredWorkbookGateCheckpointLabel): string {
  return label === "lessons003004:after-multiply-only" ? "after-multiply-only" : label;
}

export class DockerAuthoredGateEvidenceProbe implements AuthoredGateEvidenceProbe {
  readonly #dockerRunner: AuthoredGateEvidenceDockerRunner;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #tempParent: string;
  readonly #timeoutMs: number;

  constructor(options: { dockerRunner?: AuthoredGateEvidenceDockerRunner; environment?: NodeJS.ProcessEnv; tempParent?: string; timeoutMs?: number; repositoryRoot?: string } = {}) {
    this.#dockerRunner = options.dockerRunner ?? defaultDockerRunner;
    this.#environment = options.environment ?? process.env;
    this.#tempParent = options.tempParent ?? tmpdir();
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_DOCKER_TIMEOUT_MS;
  }

  async probeCalculator(request: AuthoredGateEvidenceProbeRequest): Promise<AuthoredCalculatorBehaviorProjection> {
    const workspaceRoot = await realpath(resolve(request.workspaceRoot));
    throwIfAborted(request.signal);
    const sourceBefore = await readStrictWorkspaceFile(workspaceRoot, CALCULATOR_SOURCE, { signal: request.signal });
    const probeRoot = await mkdtemp(join(this.#tempParent, "authored-gate-calculator-probe-"));
    const name = `authored-gate-probe-${randomUUID()}`;
    const volume = `authored-gate-probe-volume-${randomUUID()}`;
    let containerCreated = false;
    let volumeCreated = false;
    let primaryError: unknown;
    let result: AuthoredCalculatorBehaviorProjection | undefined;
    try {
      const calculatorProbe = resolve(probeRoot, "calculator");
      await cp(resolve(workspaceRoot, "calculator"), calculatorProbe, { recursive: true, verbatimSymlinks: false, filter: (source) => !source.split(sep).includes("node_modules") && !source.split(sep).includes(".git") });
      await chmod(resolve(calculatorProbe, "src/index.ts"), 0o444).catch(() => undefined);
      const archive = await buildBoundedWorkspaceTar(calculatorProbe);
      await expectZero(await this.#dockerRunner({ file: "docker", args: dockerProbeVolumeCreateArguments(volume), env: dockerClientEnvironment(this.#environment), timeoutMs: this.#timeoutMs, signal: request.signal }), "volume-create");
      volumeCreated = true;
      await expectZero(await this.#dockerRunner({ file: "docker", args: dockerProbePopulateVolumeArguments(volume), env: dockerClientEnvironment(this.#environment), timeoutMs: this.#timeoutMs, signal: request.signal, input: archive, maxStdoutBytes: 8 * 1024, maxStderrBytes: 8 * 1024 }), "volume-populate");
      const args = dockerProbeCreateArguments({ name, volume });
      await expectZero(await this.#dockerRunner({ file: "docker", args, env: dockerClientEnvironment(this.#environment), timeoutMs: this.#timeoutMs, signal: request.signal }), "create");
      containerCreated = true;
      const started = await this.#dockerRunner({ file: "docker", args: ["start", "--attach", name], env: dockerClientEnvironment(this.#environment), timeoutMs: this.#timeoutMs, signal: request.signal, maxStdoutBytes: 16 * 1024, maxStderrBytes: 8 * 1024 });
      if (started.status !== 0) throw new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_PUBLIC_ERROR, { stage: "start", stderr: started.stderr.slice(0, 512) });
      const parsed = parseProbeOutput(started.stdout, request.label, sourceBefore.content);
      const sourceAfter = await readStrictWorkspaceFile(workspaceRoot, CALCULATOR_SOURCE, { signal: request.signal });
      if (sourceAfter.identity.dev !== sourceBefore.identity.dev || sourceAfter.identity.ino !== sourceBefore.identity.ino || sourceAfter.content !== sourceBefore.content) throw new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_PUBLIC_ERROR, "Calculator source changed during trusted probe.");
      result = parsed;
    } catch (error) {
      primaryError = request.signal?.aborted ? new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_ABORTED_PUBLIC_ERROR, error) : error instanceof AuthoredGateEvidenceError ? error : new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_PUBLIC_ERROR, error);
    }

    // Cleanup is part of the security boundary: a cleanup failure takes precedence over both
    // successful probe output and any earlier primary probe error so callers never accept evidence
    // while a container or volume removal could not be confirmed.
    const cleanupError = await cleanupDockerProbe(this.#dockerRunner, this.#environment, { name, volume, probeRoot, containerCreated, volumeCreated });
    if (cleanupError !== undefined) throw new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_CLEANUP_PUBLIC_ERROR, cleanupError);
    if (primaryError !== undefined) throw primaryError;
    if (result === undefined) throw new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_PUBLIC_ERROR);
    return result;
  }
}

async function cleanupDockerProbe(dockerRunner: AuthoredGateEvidenceDockerRunner, environment: NodeJS.ProcessEnv, input: { name: string; volume: string; probeRoot: string; containerCreated: boolean; volumeCreated: boolean }): Promise<unknown> {
  let cleanupError: unknown;
  if (input.containerCreated) {
    try {
      const removed = await dockerRunner({ file: "docker", args: ["rm", "-f", input.name], env: dockerClientEnvironment(environment), timeoutMs: 10_000, signal: AbortSignal.timeout(10_000), maxStdoutBytes: 8 * 1024, maxStderrBytes: 8 * 1024 });
      if (removed.status !== 0) cleanupError = { stage: "docker-rm", status: removed.status };
    } catch (error) { cleanupError = error; }
  }
  if (input.volumeCreated) {
    try {
      const removed = await dockerRunner({ file: "docker", args: ["volume", "rm", "-f", input.volume], env: dockerClientEnvironment(environment), timeoutMs: 10_000, signal: AbortSignal.timeout(10_000), maxStdoutBytes: 8 * 1024, maxStderrBytes: 8 * 1024 });
      if (removed.status !== 0) cleanupError ??= { stage: "docker-volume-rm", status: removed.status };
    } catch (error) { cleanupError ??= error; }
  }
  try { await rm(input.probeRoot, { recursive: true, force: true }); }
  catch (error) { cleanupError ??= error; }
  return cleanupError;
}

export function dockerProbeVolumeCreateArguments(volume: string): string[] {
  return ["volume", "create", "--label", "authored-workbook-gate-probe=true", volume];
}

export function dockerProbePopulateVolumeArguments(volume: string): string[] {
  return ["run", "--rm", "-i", "--user", "0:0", "--read-only", "--security-opt=no-new-privileges", "--network=none", "--mount", `type=volume,src=${volume},dst=/workspace/calculator`, "--workdir", "/workspace/calculator", WORKBOOK_TERMINAL_IMAGE, "tar", "--same-owner", "-xf", "-"];
}

export function dockerProbeCreateArguments(input: { name: string; volume: string }): string[] {
  const [uid, gid] = dockerContainerUser().split(":");
  return [
    "create", "--name", input.name, "--label", "authored-workbook-gate-probe=true", "--user", dockerContainerUser(), "--read-only",
    "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=128", "--memory=768m", "--cpus=1", "--network=none", "--init",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", "--tmpfs", `/home/learner/.npm:uid=${uid},gid=${gid},mode=0700`,
    "--mount", `type=volume,src=${input.volume},dst=/workspace/calculator`,
    "--workdir", "/workspace/calculator", WORKBOOK_TERMINAL_IMAGE, "/bin/bash", "-lc", dockerProbeScript()
  ];
}

function dockerProbeScript(): string {
  return String.raw`set +e
set +u
set +o pipefail
npm test >/tmp/test.out 2>/tmp/test.err
test_status=$?
node scripts/quality.mjs >/tmp/quality.out 2>&1
quality_status=$?
AUTHORED_PROBE_TEST_STATUS="$test_status" AUTHORED_PROBE_QUALITY_STATUS="$quality_status" node --input-type=module <<'NODE'
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const MAX_SUMMARY_BYTES = 2048;
function readText(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}
function bound(text, bytes = MAX_SUMMARY_BYTES) {
  const buffer = Buffer.from(text, 'utf8');
  return buffer.length <= bytes ? text : buffer.subarray(0, bytes).toString('utf8').replace(/[\uFFFD\s]*$/u, '') + '\n[truncated]';
}
function sanitizeQuality(text) {
  return text.replaceAll(process.cwd(), '<calculator>').replaceAll('/workspace/calculator', '<calculator>');
}
function summarizeQuality(text) {
  const sanitized = sanitizeQuality(text);
  if (sanitized.includes('All quality checks passed.')) return 'All quality checks passed.';
  const lines = sanitized.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  const summary = lines.filter((line) => /Findings reported by:|is not installed\. Run npm install\.|could not run:/i.test(line));
  if (summary.length > 0) return bound(summary.slice(0, 8).join('\n'));
  if (lines.length === 0) return 'quality command produced no output.';
  return bound(lines.slice(-8).join('\n'));
}
const source = readText('src/index.ts');
const multiplyComplete = /if \(word === "multiply"\) \{\n\s*const first = readFirstOperand\("by"\);/.test(source);
const divideComplete = /if \(word === "divide"\) \{\n\s*const first = readFirstOperand\("by"\);/.test(source);
let mod;
try { mod = await import('./dist/index.js'); } catch {}
const cases = [];
if (mod?.evaluateSpokenExpression) {
  for (const [enabled, input] of [[multiplyComplete, 'multiply 6 by 7'], [divideComplete, 'divide 84 by 2']]) {
    if (!enabled) continue;
    try { cases.push({ input, output: mod.evaluateSpokenExpression(input) }); } catch {}
  }
}
const testOutput = readText('/tmp/test.out');
const qualityOutput = summarizeQuality(readText('/tmp/quality.out'));
console.log(JSON.stringify({
  marker: 'authored-gate-calculator-probe-v1',
  sourceSha256: createHash('sha256').update(source).digest('hex'),
  testStatus: Number(process.env.AUTHORED_PROBE_TEST_STATUS || '1') === 0 ? 'passed' : 'failed',
  testMarker: testOutput.includes('Test Files') || testOutput.includes('passed'),
  qualityStatus: Number(process.env.AUTHORED_PROBE_QUALITY_STATUS || '1') === 0 ? 'passed' : 'failed',
  qualityOutput,
  cases
}));
NODE`;
}

function parseProbeOutput(stdout: string, label: string, expectedSource: string): AuthoredCalculatorBehaviorProjection {
  const line = stdout.trim().split(/\r?\n/).find((candidate) => candidate.includes('"authored-gate-calculator-probe-v1"'));
  if (!line) throw new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_PUBLIC_ERROR, "Trusted probe did not return its bounded marker.");
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { throw new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_PUBLIC_ERROR, "Trusted probe returned invalid bounded JSON."); }
  if (!isRecord(parsed) || parsed.marker !== "authored-gate-calculator-probe-v1" || (parsed.testStatus !== "passed" && parsed.testStatus !== "failed") || (parsed.qualityStatus !== "passed" && parsed.qualityStatus !== "failed") || typeof parsed.qualityOutput !== "string" || parsed.qualityOutput.trim().length === 0 || Buffer.byteLength(parsed.qualityOutput, "utf8") > 2048 || containsUnsanitizedProbePath(parsed.qualityOutput) || typeof parsed.sourceSha256 !== "string" || parsed.sourceSha256 !== sha256Text(expectedSource) || !Array.isArray(parsed.cases)) {
    throw new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_PUBLIC_ERROR, "Trusted probe returned an invalid projection.");
  }
  const cases = parsed.cases.map((entry) => {
    if (!isRecord(entry) || typeof entry.input !== "string" || typeof entry.output !== "number") throw new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_PUBLIC_ERROR, "Trusted probe returned invalid calculator cases.");
    if (entry.input !== "multiply 6 by 7" && entry.input !== "divide 84 by 2") throw new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_PUBLIC_ERROR, "Trusted probe returned a non-allowlisted calculator case.");
    return { input: entry.input, output: entry.output };
  });
  return {
    label,
    sourceSha256: parsed.sourceSha256,
    testStatus: parsed.testStatus,
    qualityStatus: parsed.qualityStatus,
    qualityOutput: parsed.qualityOutput,
    cases
  };
}

async function defaultGitRunner(request: { cwd: string; args: readonly string[]; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal }): Promise<AuthoredGateEvidenceCommandResult> {
  throwIfAborted(request.signal);
  const args = safeGitArguments(request.args);
  try {
    const result = await execFileAsync(GIT_EXECUTABLE, args, { cwd: request.cwd, env: request.env, timeout: request.timeoutMs, killSignal: "SIGKILL", encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT_BYTES, signal: request.signal, windowsHide: true });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (request.signal?.aborted) throw new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_ABORTED_PUBLIC_ERROR, error);
    const execError = error as ExecFileException & { stdout?: string; stderr?: string };
    return { status: typeof execError.code === "number" ? execError.code : 1, signal: execError.signal, stdout: boundPossiblyTruncatedOutput(String(execError.stdout ?? "")), stderr: boundPossiblyTruncatedOutput(String(execError.stderr ?? "")) };
  }
}

function safeGitArguments(args: readonly string[]): string[] {
  const command = args[0];
  if (!command || !["rev-parse", "ls-files", "rev-list", "cat-file", "ls-tree"].includes(command)) throw new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_PUBLIC_ERROR);
  if (args.some((arg) => arg.includes("\0"))) throw new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_PUBLIC_ERROR);
  return [
    "--no-optional-locks",
    "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.pager=cat",
    "-c", "pager.show=false",
    "-c", "pager.log=false",
    "-c", "pager.diff=false",
    "-c", "diff.external=",
    "-c", "diff.trustExitCode=false",
    "-c", "filter.lfs.required=false",
    "-c", "filter.lfs.clean=cat",
    "-c", "filter.lfs.smudge=cat",
    "-c", "filter.process=",
    ...args
  ];
}

function boundPossiblyTruncatedOutput(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  return bytes.length > MAX_GIT_OUTPUT_BYTES ? bytes.subarray(0, MAX_GIT_OUTPUT_BYTES).toString("utf8") : text;
}

async function defaultDockerRunner(request: { file: "docker"; args: readonly string[]; cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal; input?: Buffer; maxStdoutBytes?: number; maxStderrBytes?: number }): Promise<AuthoredGateEvidenceCommandResult> {
  throwIfAborted(request.signal);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(request.file, [...request.args], { cwd: request.cwd, env: request.env, stdio: [request.input ? "pipe" : "ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const maxStdout = request.maxStdoutBytes ?? 64 * 1024;
    const maxStderr = request.maxStderrBytes ?? 16 * 1024;
    const cleanupAbort = () => request.signal?.removeEventListener("abort", abort);
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupAbort();
      action();
    };
    const abort = () => {
      child.kill("SIGKILL");
      finish(() => reject(new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_ABORTED_PUBLIC_ERROR)));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_PUBLIC_ERROR, "Docker command timed out.")));
    }, request.timeoutMs);
    timer.unref?.();
    request.signal?.addEventListener("abort", abort, { once: true });
    child.stdout!.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdout) abort(); else stdout.push(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxStderr) abort(); else stderr.push(chunk);
    });
    child.on("error", () => finish(() => reject(new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_PUBLIC_ERROR))));
    child.on("close", (status, signal) => finish(() => resolvePromise({ status, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") })));
    if (request.input && child.stdin) {
      child.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") finish(() => reject(new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_PUBLIC_ERROR))); });
      child.stdin.end(request.input);
    }
  });
}

async function readGitSnapshot(workspaceRoot: string, runner: AuthoredGateEvidenceGitRunner, signal?: AbortSignal): Promise<AuthoredGateEvidenceGitSnapshot> {
  const env = gitEnvironment();
  const run = async (args: readonly string[], allowedStatuses: readonly number[] = [0]): Promise<string> => {
    const result = await runner({ cwd: workspaceRoot, args, env, timeoutMs: DEFAULT_GIT_TIMEOUT_MS, signal });
    if (!allowedStatuses.includes(result.status ?? 1)) return "";
    return boundCommandOutput(result.stdout, "git output");
  };
  const head = (await run(["rev-parse", "--verify", "HEAD"])).trimEnd();
  const tree = (await run(["rev-parse", "--verify", "HEAD^{tree}"])).trimEnd();
  const treeManifest = parseGitTreeManifest(await run(["ls-tree", "-rz", "-r", "-t", "--full-tree", "HEAD"]));
  const statusText = await deriveTrustedGitStatus(workspaceRoot, run, treeManifest, signal);
  const commitIds = (await run(["rev-list", "--max-count=20", "HEAD"])).trim().split("\n").filter(Boolean);
  const commitObjects = await Promise.all(commitIds.map((commit) => run(["cat-file", "commit", commit])));
  const subjects = commitObjects.map((object) => parseCommitObject(object).subject).filter(Boolean);
  const topCommit = head;
  const topCommitRaw = commitObjects[0] ?? (topCommit ? await run(["cat-file", "commit", topCommit]) : "");
  const parsedTop = topCommitRaw ? parseCommitObject(topCommitRaw) : undefined;
  const configuredIdentity = await readLocalGitConfigIdentity(workspaceRoot);
  return deepFreeze({
    ...(head ? { head } : {}),
    ...(tree ? { tree } : {}),
    status: statusText,
    subjects,
    ...(topCommit ? { topCommit } : {}),
    ...(parsedTop?.tree ? { topCommitTree: parsedTop.tree } : {}),
    ...(parsedTop?.message ? { topCommitBody: parsedTop.message.trimEnd() } : {}),
    topCommitParents: parsedTop?.parents ?? [],
    ...(parsedTop?.authorIdentity ? { topCommitIdentity: parsedTop.authorIdentity, topCommitAuthorIdentity: parsedTop.authorIdentity } : {}),
    ...(parsedTop?.committerIdentity ? { topCommitCommitterIdentity: parsedTop.committerIdentity } : {}),
    ...(topCommitRaw ? { topCommitRaw } : {}),
    ...(configuredIdentity ? { configuredIdentity } : {}),
    treeManifest
  });
}

async function deriveTrustedGitStatus(workspaceRoot: string, run: (args: readonly string[], allowedStatuses?: readonly number[]) => Promise<string>, headTreeManifest: readonly AuthoredGateEvidenceGitTreeEntry[], signal?: AbortSignal): Promise<string> {
  const indexEntries = parseGitIndexStage(await run(["ls-files", "--stage", "-z", "--"]));
  const untracked = parseNulPathList(await run(["ls-files", "--others", "--exclude-standard", "-z", "--"]), "Git untracked file list");
  const status = new Map<string, GitStatusCode>();
  const indexByPath = new Map(indexEntries.map((entry) => [entry.path, entry]));
  const headFiles = new Map<string, AuthoredGateEvidenceGitTreeEntry>();
  for (const entry of headTreeManifest) {
    if (entry.type === "tree") continue;
    if (headFiles.has(entry.path)) throw new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_PUBLIC_ERROR, "Git tree manifest contained duplicate paths.");
    headFiles.set(entry.path, entry);
    if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) throw new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_PUBLIC_ERROR, "Gate evidence only supports regular tracked files.");
  }

  for (const [path, headEntry] of headFiles) {
    const indexEntry = indexByPath.get(path);
    if (!indexEntry) {
      status.set(path, "D");
    } else if (indexEntry.objectId !== headEntry.objectId || indexEntry.mode !== headEntry.mode) {
      status.set(path, "M");
    }
  }
  for (const entry of indexEntries) {
    if (!headFiles.has(entry.path)) status.set(entry.path, "A");
  }

  const root = await realpath(resolve(workspaceRoot));
  for (const entry of indexEntries) {
    throwIfAborted(signal);
    const worktree = await readStrictWorkspaceFileBytes(root, entry.path, { maxBytes: MAX_GIT_STATUS_FILE_BYTES, signal }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!worktree) {
      status.set(entry.path, "D");
      continue;
    }
    const worktreeMode = gitRegularFileMode(worktree.identity.mode);
    if (worktreeMode !== entry.mode || gitObjectId("blob", worktree.content) !== entry.objectId) status.set(entry.path, "M");
  }

  for (const path of untracked) if (indexByPath.has(path) || headFiles.has(path)) throw new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_PUBLIC_ERROR, "Git untracked file list overlapped tracked paths.");
  const trackedRows = [...status.entries()].map(([path, code]) => `${code}\t${path}`);
  const untrackedRows = untracked.map((path) => `?? ${path}`);
  return [...trackedRows, ...untrackedRows].sort((left, right) => left.localeCompare(right)).join("\n");
}

function parseGitIndexStage(text: string): GitIndexEntry[] {
  const entries: GitIndexEntry[] = [];
  const seen = new Set<string>();
  for (const record of parseStrictNulRecords(text, "Git index")) {
    const match = /^(\d{6}) ([a-f0-9]{40}) ([0-3])\t(.+)$/.exec(record);
    if (!match) throw new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_PUBLIC_ERROR, "Git index could not be parsed.");
    const mode = match[1]!;
    const objectId = match[2]!;
    const stage = match[3]!;
    const path = safeGitRelativeFile(match[4]!);
    if (stage !== "0") throw new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_PUBLIC_ERROR, "Git index contains unmerged entries.");
    if (mode !== "100644" && mode !== "100755") throw new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_PUBLIC_ERROR, "Gate evidence only supports regular tracked files.");
    if (seen.has(path)) throw new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_PUBLIC_ERROR, "Git index contained duplicate paths.");
    seen.add(path);
    entries.push({ path, mode, objectId });
  }
  return entries;
}

function parseNulPathList(text: string, label: string): string[] {
  const paths = parseStrictNulRecords(text, label).map((entry) => safeGitRelativeFile(entry));
  if (new Set(paths).size !== paths.length) throw new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_PUBLIC_ERROR, `${label} contained duplicate paths.`);
  return paths;
}

function parseStrictNulRecords(text: string, label: string): string[] {
  if (text === "") return [];
  if (!text.endsWith("\0")) throw new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_PUBLIC_ERROR, `${label} was truncated.`);
  const records = text.slice(0, -1).split("\0");
  if (records.some((record) => record.length === 0)) throw new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_PUBLIC_ERROR, `${label} contained an empty record.`);
  return records;
}

function gitRegularFileMode(mode: number): "100644" | "100755" {
  return (mode & 0o111) === 0 ? "100644" : "100755";
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    HOME: "/dev/null",
    PATH: "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOGLOBAL: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "true",
    SSH_ASKPASS: "true",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_OPTIONAL_LOCKS: "0"
  };
}

function boundCommandOutput(text: string, label: string): string {
  if (Buffer.byteLength(text, "utf8") > MAX_GIT_OUTPUT_BYTES) throw new AuthoredGateEvidenceError(`${label} exceeded the evaluator output limit.`);
  return text;
}

function parseGitTreeManifest(text: string): readonly AuthoredGateEvidenceGitTreeEntry[] {
  const seen = new Set<string>();
  const entries = parseStrictNulRecords(text, "Git tree manifest").map((line) => {
    const match = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40})\t(.+)$/.exec(line);
    if (!match) throw new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_PUBLIC_ERROR, "Git tree manifest could not be parsed.");
    const path = safeGitRelativeFile(match[4]!);
    if (seen.has(path)) throw new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_PUBLIC_ERROR, "Git tree manifest contained duplicate paths.");
    seen.add(path);
    return { mode: match[1]!, type: match[2]! as "blob" | "tree" | "commit", objectId: match[3]!, path };
  });
  return entries;
}

function parseCommitObject(text: string): { tree?: string; parents: string[]; authorIdentity?: string; committerIdentity?: string; message: string; subject: string } {
  const splitAt = text.indexOf("\n\n");
  const header = splitAt === -1 ? text : text.slice(0, splitAt);
  const message = splitAt === -1 ? "" : text.slice(splitAt + 2);
  const parents: string[] = [];
  let tree: string | undefined;
  let authorIdentity: string | undefined;
  let committerIdentity: string | undefined;
  for (const line of header.split("\n")) {
    if (line.startsWith("tree ")) tree = line.slice(5);
    else if (line.startsWith("parent ")) parents.push(line.slice(7));
    else if (line.startsWith("author ")) authorIdentity = parseGitIdentity(line.slice(7));
    else if (line.startsWith("committer ")) committerIdentity = parseGitIdentity(line.slice(10));
  }
  return { tree, parents, authorIdentity, committerIdentity, message, subject: message.split("\n", 1)[0] ?? "" };
}

function parseGitIdentity(value: string): string | undefined {
  const match = /^(.* <[^<>]+>) -?\d+ [+-]\d{4}$/.exec(value);
  return match?.[1];
}

async function readLocalGitConfigIdentity(workspaceRoot: string): Promise<string | undefined> {
  try {
    const config = await readStrictWorkspaceFile(workspaceRoot, ".git/config", { maxBytes: 64 * 1024 });
    const user = parseGitConfigUser(config.content);
    return user.name || user.email ? `${user.name} <${user.email}>` : undefined;
  } catch {
    return undefined;
  }
}

function parseGitConfigUser(text: string): { name: string; email: string } {
  let inUser = false;
  let name = "";
  let email = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) {
      inUser = section[1] === "user";
      continue;
    }
    if (!inUser || line.startsWith("#") || line.startsWith(";")) continue;
    const match = /^([A-Za-z0-9.-]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    if (match[1] === "name") name = match[2] ?? "";
    if (match[1] === "email") email = match[2] ?? "";
  }
  return { name, email };
}

async function expectZero(result: AuthoredGateEvidenceCommandResult, stage: string): Promise<void> {
  if (result.status !== 0) throw new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_PUBLIC_ERROR, { stage, stderr: result.stderr.slice(0, 512) });
}

function learnerWorkspaceRoot(session: TutorialSessionPaths, workspaceId = DEFAULT_WORKSPACE_ID): string | undefined {
  const root = session.workspaceRoots[workspaceId];
  return root === undefined ? undefined : resolve(root);
}

async function snapshotExactWorkspaceFiles(workspaceRoot: string, files: readonly string[], signal?: AbortSignal): Promise<AuthoredWorkbookEvalArtifactSnapshot[]> {
  if (new Set(files).size !== files.length) throw new AuthoredGateEvidenceError("Duplicate workspace evidence path.");
  if (files.length > 50) throw new AuthoredGateEvidenceError("Too many workspace evidence files.");
  const snapshots: AuthoredWorkbookEvalArtifactSnapshot[] = [];
  let total = 0;
  for (const file of files) {
    throwIfAborted(signal);
    const snapshot = await readStrictWorkspaceFile(workspaceRoot, file, { maxBytes: MAX_PRIVATE_SNAPSHOT_FILE_BYTES, signal });
    total += Buffer.byteLength(snapshot.content, "utf8");
    if (total > MAX_PRIVATE_SNAPSHOT_TOTAL_BYTES) throw new AuthoredGateEvidenceError("Workspace evidence files exceeded the total byte limit.");
    snapshots.push({ path: snapshot.path, content: snapshot.content });
  }
  return snapshots;
}

function copyArtifactSnapshots(snapshots: readonly AuthoredWorkbookEvalArtifactSnapshot[]): AuthoredWorkbookEvalArtifactSnapshot[] {
  return snapshots.map((snapshot) => ({ path: snapshot.path, content: snapshot.content }));
}

async function readStrictWorkspaceFile(workspaceRoot: string, file: string, options: { maxBytes?: number; signal?: AbortSignal } = {}): Promise<{ path: string; content: string; identity: FileIdentity }> {
  const result = await readStrictWorkspaceFileBytes(workspaceRoot, file, options);
  return { path: result.path, content: result.content.toString("utf8"), identity: result.identity };
}

async function readStrictWorkspaceManifestFile(workspaceRoot: string, file: string, options: { maxBytes?: number; signal?: AbortSignal } = {}): Promise<{ path: string; content: string; identity: FileIdentity }> {
  const result = await readStrictWorkspaceFileBytesWithSafePath(workspaceRoot, safePrivateWorkspaceManifestFile(file), options);
  return { path: result.path, content: result.content.toString("utf8"), identity: result.identity };
}

async function readStrictWorkspaceFileBytes(workspaceRoot: string, file: string, options: { maxBytes?: number; signal?: AbortSignal } = {}): Promise<{ path: string; content: Buffer; identity: FileIdentity }> {
  return readStrictWorkspaceFileBytesWithSafePath(workspaceRoot, safeRelativeFile(file), options);
}

async function readStrictWorkspaceFileBytesWithSafePath(workspaceRoot: string, safeFile: string, options: { maxBytes?: number; signal?: AbortSignal } = {}): Promise<{ path: string; content: Buffer; identity: FileIdentity }> {
  throwIfAborted(options.signal);
  const root = await realpath(resolve(workspaceRoot));
  const absolute = resolve(root, safeFile);
  if (!inside(root, absolute)) throw new AuthoredGateEvidenceError("Workspace evidence path escaped the workspace.");
  const pathInfo = await lstat(absolute);
  if (pathInfo.isSymbolicLink() || !pathInfo.isFile() || pathInfo.nlink !== 1) throw new AuthoredGateEvidenceError(`Workspace evidence path is not a single ordinary file: ${safeFile}.`);
  if (pathInfo.size > (options.maxBytes ?? MAX_PRIVATE_SNAPSHOT_FILE_BYTES)) throw new AuthoredGateEvidenceError(`Workspace evidence file is too large: ${safeFile}.`);
  const real = await realpath(absolute);
  const stableRelative = relative(root, real).split(sep).join("/");
  if (stableRelative !== safeFile) throw new AuthoredGateEvidenceError(`Workspace evidence path is an alias: ${safeFile}.`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!sameIdentity(pathInfo, opened) || opened.size !== pathInfo.size || !opened.isFile() || opened.nlink !== 1) throw new AuthoredGateEvidenceError(`Workspace evidence file changed before read: ${safeFile}.`);
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < opened.size) {
      throwIfAborted(options.signal);
      const read = await handle.read(buffer, offset, opened.size - offset, offset);
      if (read.bytesRead === 0) throw new AuthoredGateEvidenceError(`Workspace evidence file changed during read: ${safeFile}.`);
      offset += read.bytesRead;
    }
    const extra = Buffer.alloc(1);
    const extraRead = await handle.read(extra, 0, 1, opened.size);
    if (extraRead.bytesRead !== 0) throw new AuthoredGateEvidenceError(`Workspace evidence file grew during read: ${safeFile}.`);
    const after = await handle.stat();
    if (!sameIdentity(opened, after) || after.size !== opened.size || !after.isFile() || after.nlink !== 1) throw new AuthoredGateEvidenceError(`Workspace evidence file changed during read: ${safeFile}.`);
    return { path: safeFile, content: buffer, identity: { dev: after.dev, ino: after.ino, nlink: after.nlink, size: after.size, mode: after.mode } };
  } finally {
    await handle?.close();
  }
}

async function workspaceTreeManifest(workspaceRoot: string, signal?: AbortSignal): Promise<readonly AuthoredGateEvidenceWorkspaceManifestEntry[]> {
  const root = await realpath(resolve(workspaceRoot));
  const manifest = new Map<string, string>();
  async function visit(directory: string): Promise<void> {
    throwIfAborted(signal);
    const entries = await import("node:fs/promises").then((fs) => fs.readdir(directory, { withFileTypes: true }));
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const absolute = resolve(directory, entry.name);
      const rel = relative(root, absolute).split(sep).join("/");
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new AuthoredGateEvidenceError(`Workspace contains symlink at evidence boundary: ${rel}.`);
      if (info.isDirectory()) {
        manifest.set(`${rel}/`, `dir:${info.dev}:${info.ino}:${info.mode}`);
        await visit(absolute);
      } else if (info.isFile()) {
        if (info.nlink !== 1) throw new AuthoredGateEvidenceError(`Workspace contains hardlinked file at evidence boundary: ${rel}.`);
        if (info.size > MAX_PRIVATE_SNAPSHOT_FILE_BYTES) manifest.set(rel, `file:${info.dev}:${info.ino}:${info.mode}:${info.size}:oversize`);
        else {
          const file = await readStrictWorkspaceManifestFile(root, rel, { signal });
          manifest.set(rel, `file:${file.identity.dev}:${file.identity.ino}:${file.identity.mode}:${file.identity.size}:${sha256Text(file.content)}`);
        }
      } else {
        throw new AuthoredGateEvidenceError(`Workspace contains unsupported node at evidence boundary: ${rel}.`);
      }
    }
  }
  await visit(root);
  return [...manifest.entries()].map(([path, fingerprint]) => ({ path, fingerprint })).sort((left, right) => left.path.localeCompare(right.path));
}

function changedWorkspacePathsOutsideAllowlist(beforeEntries: readonly AuthoredGateEvidenceWorkspaceManifestEntry[], afterEntries: readonly AuthoredGateEvidenceWorkspaceManifestEntry[], scenario: AuthoredWorkbookScenarioDescriptor): string[] {
  const before = new Map(beforeEntries.map((entry) => [entry.path, entry.fingerprint]));
  const after = new Map(afterEntries.map((entry) => [entry.path, entry.fingerprint]));
  const allowedFiles = new Set([...(scenario.runnerPrivate?.mutationAllowlist.learnerWorkspaceFiles ?? []), ...(scenario.runnerPrivate?.gateEvidence.workspaceFiles ?? [])]);
  const allowedPrefixes = [...(scenario.runnerPrivate?.mutationAllowlist.learnerWorkspacePathPrefixes ?? []), ...(scenario.runnerPrivate?.gateEvidence.workspacePathPrefixes ?? [])];
  const allowedDirectories = allowedMutationDirectories([...allowedFiles, ...allowedPrefixes]);
  const changed = new Set([...before.keys(), ...after.keys()]);
  return [...changed]
    .filter((path) => before.get(path) !== after.get(path))
    .filter((path) => !allowedFiles.has(path) && !allowedPrefixes.some((prefix) => path.startsWith(prefix)) && !(path.endsWith("/") && allowedDirectories.has(path)))
    .sort();
}

function allowedMutationDirectories(paths: readonly string[]): Set<string> {
  const directories = new Set<string>([".tmp/"]);
  for (const path of paths) {
    const parts = path.replace(/\/$/, "").split("/").filter(Boolean);
    for (let index = 1; index < parts.length; index += 1) directories.add(`${parts.slice(0, index).join("/")}/`);
    if (path.endsWith("/")) directories.add(path);
  }
  return directories;
}

function assertExactSnapshotPaths(snapshots: readonly AuthoredWorkbookEvalArtifactSnapshot[], expected: readonly string[], label: string): void {
  const actual = snapshots.map((snapshot) => snapshot.path);
  const normalized = expected.map(safeRelativeFile);
  if (new Set(actual).size !== actual.length || JSON.stringify(actual) !== JSON.stringify(normalized)) throw new AuthoredGateEvidenceError(`Unexpected ${label} path set.`);
}

function safeRelativeFile(file: string): string {
  const normalized = safePrivateWorkspaceManifestFile(file);
  if (/(^|\/)events(\/|$)|(^|\/)workbook\/events\.jsonl$/i.test(normalized)) throw new AuthoredGateEvidenceError("Raw event files are not public artifacts.");
  return normalized;
}

function safePrivateWorkspaceManifestFile(file: string): string {
  if (typeof file !== "string" || !file || isAbsolute(file) || file.includes("\0") || file.includes("\\")) throw new AuthoredGateEvidenceError("Unsafe workspace evidence path.");
  const normalized = file.split("/").filter(Boolean).join("/");
  const parts = normalized.split("/");
  if (normalized !== file || parts.some((part) => part === "." || part === "..")) throw new AuthoredGateEvidenceError("Unsafe workspace evidence path.");
  return normalized;
}

function safeGitRelativeFile(file: string): string {
  const normalized = safeRelativeFile(file);
  if (normalized.length > 4096 || /[\u0001-\u001f\u007f\ufffd]/u.test(normalized) || normalized.split("/").includes(".git")) throw new AuthoredGateEvidenceError("Unsafe Git evidence path.");
  return normalized;
}

function containsUnsanitizedProbePath(text: string): boolean {
  return /\/workspace\/calculator|\/private\/var\/|\/var\/folders\//.test(text);
}

function bindMount(src: string, dst: string, readonly = false): string {
  return `type=bind,src=${src},dst=${dst}${readonly ? ",readonly" : ""}`;
}

function sameIdentity(left: FileIdentity | Stats, right: FileIdentity | Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function completeRefactorSource(source: string): string | undefined {
  return authoredCalculatorCanonicalRefactorSource(source);
}

function computeExpectedLesson013Tree(baselineTreeManifest: readonly AuthoredGateEvidenceGitTreeEntry[], expectedSource: string): string | undefined {
  const sourceEntry = baselineTreeManifest.find((entry) => entry.path === CALCULATOR_SOURCE);
  if (!sourceEntry || sourceEntry.type !== "blob") return undefined;
  const replacementBlob = gitObjectId("blob", Buffer.from(expectedSource, "utf8"));
  const entriesByParent = new Map<string, AuthoredGateEvidenceGitTreeEntry[]>();
  for (const entry of baselineTreeManifest) {
    const slash = entry.path.lastIndexOf("/");
    const parent = slash === -1 ? "" : entry.path.slice(0, slash);
    const child = slash === -1 ? entry.path : entry.path.slice(slash + 1);
    const nextEntry = entry.path === CALCULATOR_SOURCE ? { ...entry, objectId: replacementBlob } : entry;
    const list = entriesByParent.get(parent) ?? [];
    list.push({ ...nextEntry, path: child });
    entriesByParent.set(parent, list);
  }
  const treeIds = new Map<string, string>();
  const treePaths = baselineTreeManifest.filter((entry) => entry.type === "tree").map((entry) => entry.path).sort((left, right) => right.split("/").length - left.split("/").length);
  for (const treePath of treePaths) {
    const id = computeTreeObjectId(entriesByParent.get(treePath) ?? [], treeIds, treePath);
    treeIds.set(treePath, id);
  }
  return computeTreeObjectId(entriesByParent.get("") ?? [], treeIds, "");
}

function computeTreeObjectId(entries: readonly AuthoredGateEvidenceGitTreeEntry[], treeIds: ReadonlyMap<string, string>, parentPath: string): string {
  const chunks: Buffer[] = [];
  const sorted = [...entries].sort((left, right) => Buffer.compare(Buffer.from(gitTreeSortPath(left), "utf8"), Buffer.from(gitTreeSortPath(right), "utf8")));
  for (const entry of sorted) {
    const objectId = entry.type === "tree" ? treeIds.get(parentPath ? `${parentPath}/${entry.path}` : entry.path) : entry.objectId;
    if (!objectId) throw new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_PUBLIC_ERROR, "Git tree manifest was incomplete.");
    chunks.push(Buffer.from(`${entry.type === "tree" ? "40000" : entry.mode} ${entry.path}\0`, "utf8"), Buffer.from(objectId, "hex"));
  }
  return gitObjectId("tree", Buffer.concat(chunks));
}

function gitTreeSortPath(entry: Pick<AuthoredGateEvidenceGitTreeEntry, "path" | "type">): string {
  return entry.type === "tree" ? `${entry.path}/` : entry.path;
}

function computeExpectedLesson013Commit(rawCommit: string, expectedParent: string, expectedTree: string): string | undefined {
  const parsed = parseCommitObject(rawCommit);
  if (parsed.tree !== expectedTree) return undefined;
  if (parsed.parents.length !== 1 || parsed.parents[0] !== expectedParent) return undefined;
  if (parsed.authorIdentity !== EXPECTED_WORKER_IDENTITY || parsed.committerIdentity !== EXPECTED_WORKER_IDENTITY) return undefined;
  if (parsed.message.trimEnd() !== EXPECTED_COMMIT_MESSAGE) return undefined;
  return gitObjectId("commit", Buffer.from(rawCommit, "utf8"));
}

function gitObjectId(type: "blob" | "tree" | "commit", body: Buffer): string {
  return createHash("sha1").update(`${type} ${body.length}\0`).update(body).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AuthoredGateEvidenceError(AUTHORED_GATE_EVIDENCE_ABORTED_PUBLIC_ERROR);
}

export class AuthoredGateEvidenceError extends Error {
  readonly publicMessage: string;
  readonly privateDiagnostics?: unknown;
  constructor(publicMessage = AUTHORED_GATE_EVIDENCE_PUBLIC_ERROR, privateDiagnostics?: unknown) {
    super(publicMessage);
    this.name = "AuthoredGateEvidenceError";
    this.publicMessage = publicMessage;
    if (privateDiagnostics !== undefined) this.privateDiagnostics = privateDiagnostics;
  }
}

function deepFreeze<T>(value: T): T {
  if (value instanceof Map || value instanceof Set || value instanceof Date) throw new AuthoredGateEvidenceError("Gate evidence must be serializable plain data.");
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
