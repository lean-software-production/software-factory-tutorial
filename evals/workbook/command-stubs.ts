import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, delimiter, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

export const AUTHORED_COMMAND_STUB_NAMESPACE = "evals/workbook/authored-workbook/command-stubs";
export const AUTHORED_COMMAND_STUB_OWNER = "authored-eval";
export const AUTHORED_COMMAND_STUB_SCHEMA_VERSION = 1;

export type AuthoredCommandStubKind = "pi" | "npm";
export type AuthoredPiMode = "text" | "json" | "rpc";
export type AuthoredPiTools = "read,grep,find,ls" | "read,grep,find,ls,bash" | "read,edit,write,grep,find,ls" | "none";
export type AuthoredStation = "doer" | "validator" | "repair" | "commit" | "ask";
export type AuthoredVerdict = "PASS" | "FAIL";
export type AuthoredMutation = "partial-refactor" | "complete-refactor" | "already-complete" | "none";
export type AuthoredSignal = "verdict-fail-feedback" | "verdict-pass-evidence" | "complete-labelled-evidence" | "commit-message-request" | "record-question";
export type AuthoredEventClass = "text" | "queue_update" | "tool_execution_start" | "message_update" | "message_end" | "agent_end" | "response";
export type AuthoredRejectionCode =
  | "MISSING_CONFIG"
  | "CONFIG_UNREADABLE"
  | "CONFIG_INVALID"
  | "CWD_OUTSIDE_WORKSPACE"
  | "CWD_NOT_ALLOWED"
  | "PROMPT_TOO_LARGE"
  | "PI_ARG_NOT_ALLOWLISTED"
  | "PI_NO_SESSION_REQUIRED"
  | "PI_MODE_NOT_ALLOWLISTED"
  | "PI_RPC_WITH_PROMPT_FLAG"
  | "PI_PROMPT_FLAG_REQUIRED"
  | "PI_TOOLS_CONFLICT"
  | "PI_TOOLS_NOT_ALLOWLISTED"
  | "PI_VALIDATOR_BASH_AFTER_LESSON_006"
  | "PI_RPC_TOOLS_NOT_ALLOWLISTED"
  | "MUTATION_PATH_NOT_ALLOWED"
  | "SOURCE_ANCHOR_MISSING"
  | "RUNTIME_LAYOUT_UNSAFE"
  | "EVIDENCE_LIMIT_EXCEEDED"
  | "RPC_JSON_INVALID"
  | "RPC_COMMAND_NOT_ALLOWLISTED"
  | "RPC_PROMPT_TOO_LARGE"
  | "RPC_STEER_TOO_LARGE"
  | "RPC_DUPLICATE_PROMPT"
  | "RPC_STEER_BEFORE_PROMPT"
  | "RPC_INPUT_TOO_LARGE"
  | "RPC_LINE_TOO_LARGE"
  | "RPC_COMMAND_LIMIT_EXCEEDED"
  | "RPC_OUTPUT_TOO_LARGE"
  | "RPC_FIFO_HOLDER_REQUIRED"
  | "RPC_PROMPT_REQUIRED"
  | "NPM_COMMAND_NOT_ALLOWLISTED"
  | "EXECUTABLE_NOT_ALLOWLISTED"
  | "LOCK_UNAVAILABLE"
  | "UNHANDLED_STUB_ERROR";

export type AuthoredCommandInvocationEvidence = {
  namespace: typeof AUTHORED_COMMAND_STUB_NAMESPACE;
  owner: typeof AUTHORED_COMMAND_STUB_OWNER;
  schemaVersion: typeof AUTHORED_COMMAND_STUB_SCHEMA_VERSION;
  /** Random per-fixture identity copied from the generated command-stub config. */
  runId: string;
  kind: AuthoredCommandStubKind;
  accepted: boolean;
  cwd: string;
  mode?: AuthoredPiMode;
  tools?: AuthoredPiTools;
  station?: AuthoredStation;
  verdict?: AuthoredVerdict;
  mutation?: AuthoredMutation;
  prompt?: { bytes: number; sha256: string; signals: AuthoredSignal[] };
  rpc?: { commandCount: number; promptBytes: number; promptSha256: string; earlySteerCount: number; lateSteerCount: number; steerBytes: number; steerSha256: string };
  output?: { bytes: number; sha256: string; eventClasses: AuthoredEventClass[] };
  rejectionCode?: AuthoredRejectionCode;
};

export type AuthoredCommandStubOptions = {
  /** Authored lesson number. Lesson 001 is deliberately unsupported: it must use the real headless boundary. */
  lessonNumber: number;
  /** Disposable learner session workspace root that owns calculator/ and factory/. */
  workspaceRoot: string;
  scenarioId?: string;
  maxPromptBytes?: number;
  maxEvidenceEntryBytes?: number;
  maxEvidenceTotalBytes?: number;
  rpcEarlySteerWindowMs?: number;
  rpcLateSteerWindowMs?: number;
};

export type AuthoredCommandStubHandle = {
  /** Host path to the generated bin directory. */
  hostBinDir: string;
  /** Host path to the generated state directory under the disposable workspace's ignored factory/.tmp/. */
  hostStateDir: string;
  /** Host path to public structural invocation evidence. */
  hostEvidencePath: string;
  /** Host path to the host-runtime stub config. */
  hostConfigPath: string;
  /** Host path to the container-runtime config file as seen before Docker bind mounting. */
  hostContainerConfigPath: string;
  /** Workspace-relative generated bin path, suitable for script assertions. */
  workspaceRelativeBinPath: string;
  /** Container path when the disposable workspace is mounted at /workspace. */
  containerBinPath: string;
  /** Container path to state when the disposable workspace is mounted at /workspace. */
  containerStateDir: string;
  /** Container path to public structural invocation evidence. */
  containerEvidencePath: string;
  /** Container path to the generated config when the disposable workspace is mounted at /workspace. */
  containerConfigPath: string;
  /** Random identity shared by the generated config and every evidence record for this fixture. */
  runId: string;
  /** Shell snippet for future scripted terminal actions inside the canonical /workspace bind mount. */
  containerShellActivation: string;
  /** Minimal host subprocess environment for deterministic tests; intentionally not process.env. */
  hostEnv: NodeJS.ProcessEnv;
  close(): Promise<void>;
};

const WORKSPACE_RELATIVE_STATE_DIR = "factory/.tmp/authored-eval-command-stubs";
const WORKSPACE_RELATIVE_BIN_PATH = `${WORKSPACE_RELATIVE_STATE_DIR}/bin`;
const CONTAINER_WORKSPACE = "/workspace";
const DEFAULT_MAX_PROMPT_BYTES = 256_000;
const DEFAULT_MAX_EVIDENCE_ENTRY_BYTES = 8_192;
export const AUTHORED_STUB_RPC_EARLY_STEER_WINDOW_MS = 5_000;
const DEFAULT_MAX_EVIDENCE_TOTAL_BYTES = 1_000_000;
const MAX_EVIDENCE_READ_BYTES = 1_000_000;
const MAX_EVIDENCE_LINE_BYTES = 16_384;
const MAX_EVIDENCE_ENTRIES = 1_000;
const MAX_EVIDENCE_ARRAY_LENGTH = 64;

export const AUTHORED_CALCULATOR_REFACTOR_HELPER = "\n    const readFirstOperand = (separator: \"and\" | \"from\" | \"by\"): number => {\n      const first = read();\n      if (pieces[place++] !== separator) fail();\n      return first;\n    };\n";

export const AUTHORED_CALCULATOR_REFACTOR_ANCHORS = Object.freeze({
  insertion: "\n    // Operators are prefix forms. Each branch repeats the same parser work on\n",
  addBefore: "    if (word === \"add\") {\n      const first = read();\n      if (pieces[place++] !== \"and\") fail();\n      const second = read();\n      return first + second;\n    }",
  addAfter: "    if (word === \"add\") {\n      const first = readFirstOperand(\"and\");\n      const second = read();\n      return first + second;\n    }",
  subtractBefore: "    if (word === \"subtract\") {\n      const first = read();\n      if (pieces[place++] !== \"from\") fail();\n      const second = read();\n      return second - first;\n    }",
  subtractAfter: "    if (word === \"subtract\") {\n      const first = readFirstOperand(\"from\");\n      const second = read();\n      return second - first;\n    }",
  multiplyBefore: "    if (word === \"multiply\") {\n      const first = read();\n      if (pieces[place++] !== \"by\") fail();\n      const second = read();\n      return first * second;\n    }",
  multiplyAfter: "    if (word === \"multiply\") {\n      const first = readFirstOperand(\"by\");\n      const second = read();\n      return first * second;\n    }",
  divideBefore: "    if (word === \"divide\") {\n      const first = read();\n      if (pieces[place++] !== \"by\") fail();\n      const second = read();\n      if (second === 0) fail();\n      return first / second;\n    }",
  divideAfter: "    if (word === \"divide\") {\n      const first = readFirstOperand(\"by\");\n      const second = read();\n      if (second === 0) fail();\n      return first / second;\n    }"
});

export function authoredCalculatorCanonicalRefactorSource(source: string): string | undefined {
  const branches = [
    [AUTHORED_CALCULATOR_REFACTOR_ANCHORS.addBefore, AUTHORED_CALCULATOR_REFACTOR_ANCHORS.addAfter],
    [AUTHORED_CALCULATOR_REFACTOR_ANCHORS.subtractBefore, AUTHORED_CALCULATOR_REFACTOR_ANCHORS.subtractAfter],
    [AUTHORED_CALCULATOR_REFACTOR_ANCHORS.multiplyBefore, AUTHORED_CALCULATOR_REFACTOR_ANCHORS.multiplyAfter],
    [AUTHORED_CALCULATOR_REFACTOR_ANCHORS.divideBefore, AUTHORED_CALCULATOR_REFACTOR_ANCHORS.divideAfter]
  ] as const;
  const helperCount = occurrences(source, "const readFirstOperand = ");
  if (helperCount > 1) return undefined;
  const complete = helperCount === 1 && branches.every(([, after]) => occurrences(source, after) === 1) && branches.every(([before]) => occurrences(source, before) === 0);
  if (complete) return source;
  let next = source;
  if (helperCount === 0) {
    if (occurrences(next, AUTHORED_CALCULATOR_REFACTOR_ANCHORS.insertion) !== 1) return undefined;
    next = next.replace(AUTHORED_CALCULATOR_REFACTOR_ANCHORS.insertion, AUTHORED_CALCULATOR_REFACTOR_HELPER + AUTHORED_CALCULATOR_REFACTOR_ANCHORS.insertion);
  }
  for (const [before, after] of branches) {
    const beforeCount = occurrences(next, before);
    const afterCount = occurrences(next, after);
    if (afterCount === 1 && beforeCount === 0) continue;
    if (afterCount === 0 && beforeCount === 1) {
      next = next.replace(before, after);
      continue;
    }
    return undefined;
  }
  return authoredCalculatorCanonicalRefactorSource(next) === next ? next : undefined;
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

export async function createAuthoredCommandStubs(options: AuthoredCommandStubOptions): Promise<AuthoredCommandStubHandle> {
  if (!Number.isInteger(options.lessonNumber) || options.lessonNumber < 2 || options.lessonNumber > 13) {
    throw new Error("Authored command stubs are only for post-Lesson-001 authored scenarios (002-013).");
  }

  const workspaceRoot = await realpath(resolve(options.workspaceRoot));
  rejectAuthoredSourceFixture(workspaceRoot);
  await assertDirectoryNoSymlink(resolve(workspaceRoot, "factory"), "factory");
  await ensureDirectoryInsideWorkspace(workspaceRoot, resolve(workspaceRoot, "factory/.tmp"));
  await assertDirectoryNoSymlink(resolve(workspaceRoot, "factory/.tmp"), "factory/.tmp");
  await assertDirectoryNoSymlink(resolve(workspaceRoot, "calculator"), "calculator");
  await assertDirectoryNoSymlink(resolve(workspaceRoot, "calculator/src"), "calculator/src");
  await assertFileNoSymlink(resolve(workspaceRoot, "calculator/src/index.ts"), "calculator/src/index.ts");

  const hostStateDir = resolve(workspaceRoot, WORKSPACE_RELATIVE_STATE_DIR);
  const hostBinDir = resolve(workspaceRoot, WORKSPACE_RELATIVE_BIN_PATH);
  const hostEvidencePath = resolve(hostStateDir, "invocations.jsonl");
  const hostContainerConfigPath = resolve(hostStateDir, "container-config.json");
  const containerStateDir = `${CONTAINER_WORKSPACE}/${WORKSPACE_RELATIVE_STATE_DIR}`;
  const containerBinPath = `${CONTAINER_WORKSPACE}/${WORKSPACE_RELATIVE_BIN_PATH}`;
  const containerEvidencePath = `${containerStateDir}/invocations.jsonl`;
  const containerConfigPath = `${containerStateDir}/container-config.json`;

  await assertPathAbsentOrDirectoryNoSymlink(hostStateDir, "state dir");
  await removeDirectoryInsideWorkspace(workspaceRoot, hostStateDir);
  await ensureDirectoryInsideWorkspace(workspaceRoot, hostBinDir);
  await writeFileInsideWorkspaceExclusive(workspaceRoot, hostEvidencePath, "");

  const hostControlDir = await mkdtemp(join(tmpdir(), "authored-eval-command-stubs-"));
  const hostConfigPath = resolve(hostControlDir, "host-config.json");
  const hostHome = resolve(hostControlDir, "home");
  const hostTmp = resolve(hostControlDir, "tmp");
  await mkdir(hostHome, { recursive: true });
  await mkdir(hostTmp, { recursive: true });

  const sharedConfig = {
    namespace: AUTHORED_COMMAND_STUB_NAMESPACE,
    owner: AUTHORED_COMMAND_STUB_OWNER,
    schemaVersion: AUTHORED_COMMAND_STUB_SCHEMA_VERSION,
    runId: randomUUID(),
    lessonNumber: options.lessonNumber,
    scenarioId: options.scenarioId ?? "authored-scenario",
    maxPromptBytes: options.maxPromptBytes ?? DEFAULT_MAX_PROMPT_BYTES,
    maxEvidenceEntryBytes: options.maxEvidenceEntryBytes ?? DEFAULT_MAX_EVIDENCE_ENTRY_BYTES,
    maxEvidenceTotalBytes: options.maxEvidenceTotalBytes ?? DEFAULT_MAX_EVIDENCE_TOTAL_BYTES,
    rpcEarlySteerWindowMs: options.rpcEarlySteerWindowMs ?? AUTHORED_STUB_RPC_EARLY_STEER_WINDOW_MS,
    rpcLateSteerWindowMs: options.rpcLateSteerWindowMs ?? 500
  };
  await writeJsonAtomic(hostConfigPath, {
    ...sharedConfig,
    runtime: "host",
    workspaceRoot,
    stateDir: hostStateDir,
    evidencePath: hostEvidencePath
  });
  await writeJsonAtomicInsideWorkspace(workspaceRoot, hostContainerConfigPath, {
    ...sharedConfig,
    runtime: "container",
    workspaceRoot: CONTAINER_WORKSPACE,
    stateDir: containerStateDir,
    evidencePath: containerEvidencePath
  });

  const stub = commandStubJavaScript();
  const piPath = resolve(hostBinDir, "pi");
  const npmPath = resolve(hostBinDir, "npm");
  await writeFileInsideWorkspaceExclusive(workspaceRoot, piPath, stub);
  await writeFileInsideWorkspaceExclusive(workspaceRoot, npmPath, stub);
  await chmod(piPath, 0o755);
  await chmod(npmPath, 0o755);

  const nodeBinDir = dirname(process.execPath);
  const hostEnv: NodeJS.ProcessEnv = {
    AUTHORED_EVAL_COMMAND_STUB_CONFIG: hostConfigPath,
    AUTHORED_EVAL_NO_NETWORK: "1",
    HOME: hostHome,
    TMPDIR: hostTmp,
    LANG: "C.UTF-8",
    npm_config_offline: "true",
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    npm_config_yes: "false",
    npm_config_cache: resolve(hostTmp, "npm-cache"),
    PATH: `${hostBinDir}${delimiter}${nodeBinDir}`
  };

  const containerShellActivation = `export AUTHORED_EVAL_COMMAND_STUB_CONFIG=${shellQuote(containerConfigPath)}; export AUTHORED_EVAL_NO_NETWORK=1; export npm_config_offline=true; export npm_config_ignore_scripts=true; export npm_config_audit=false; export npm_config_fund=false; export npm_config_update_notifier=false; export npm_config_yes=false; export PATH=${shellQuote(containerBinPath)}:"$PATH"`;

  return {
    hostBinDir,
    hostStateDir,
    hostEvidencePath,
    hostConfigPath,
    hostContainerConfigPath,
    workspaceRelativeBinPath: WORKSPACE_RELATIVE_BIN_PATH,
    containerBinPath,
    containerStateDir,
    containerEvidencePath,
    containerConfigPath,
    runId: sharedConfig.runId,
    containerShellActivation,
    hostEnv,
    close: async () => {
      await removeDirectoryInsideWorkspace(workspaceRoot, hostStateDir);
      await rm(hostControlDir, { recursive: true, force: true });
    }
  };
}

const ALLOWED_KINDS = ["pi", "npm"] as const;
const ALLOWED_MODES = ["text", "json", "rpc"] as const;
const ALLOWED_TOOLS = ["read,grep,find,ls", "read,grep,find,ls,bash", "read,edit,write,grep,find,ls", "none"] as const;
const ALLOWED_STATIONS = ["doer", "validator", "repair", "commit", "ask"] as const;
const ALLOWED_VERDICTS = ["PASS", "FAIL"] as const;
const ALLOWED_MUTATIONS = ["partial-refactor", "complete-refactor", "already-complete", "none"] as const;
const ALLOWED_SIGNALS = ["verdict-fail-feedback", "verdict-pass-evidence", "complete-labelled-evidence", "commit-message-request", "record-question"] as const;
const ALLOWED_EVENT_CLASSES = ["text", "queue_update", "tool_execution_start", "message_update", "message_end", "agent_end", "response"] as const;
const ALLOWED_REJECTION_CODES: readonly AuthoredRejectionCode[] = [
  "MISSING_CONFIG", "CONFIG_UNREADABLE", "CONFIG_INVALID", "CWD_OUTSIDE_WORKSPACE", "CWD_NOT_ALLOWED", "PROMPT_TOO_LARGE", "PI_ARG_NOT_ALLOWLISTED",
  "PI_NO_SESSION_REQUIRED", "PI_MODE_NOT_ALLOWLISTED", "PI_RPC_WITH_PROMPT_FLAG", "PI_PROMPT_FLAG_REQUIRED",
  "PI_TOOLS_CONFLICT", "PI_TOOLS_NOT_ALLOWLISTED", "PI_VALIDATOR_BASH_AFTER_LESSON_006", "PI_RPC_TOOLS_NOT_ALLOWLISTED",
  "MUTATION_PATH_NOT_ALLOWED", "SOURCE_ANCHOR_MISSING", "RUNTIME_LAYOUT_UNSAFE", "EVIDENCE_LIMIT_EXCEEDED", "RPC_JSON_INVALID", "RPC_COMMAND_NOT_ALLOWLISTED",
  "RPC_PROMPT_TOO_LARGE", "RPC_STEER_TOO_LARGE", "RPC_DUPLICATE_PROMPT", "RPC_STEER_BEFORE_PROMPT",
  "RPC_INPUT_TOO_LARGE", "RPC_LINE_TOO_LARGE", "RPC_COMMAND_LIMIT_EXCEEDED", "RPC_OUTPUT_TOO_LARGE", "RPC_FIFO_HOLDER_REQUIRED", "RPC_PROMPT_REQUIRED", "NPM_COMMAND_NOT_ALLOWLISTED",
  "EXECUTABLE_NOT_ALLOWLISTED", "LOCK_UNAVAILABLE", "UNHANDLED_STUB_ERROR"
];

export async function readAuthoredCommandStubEvidence(evidencePath: string): Promise<AuthoredCommandInvocationEvidence[]> {
  let handle;
  try {
    const parentPath = resolve(evidencePath, "..");
    const parentEntry = await lstat(parentPath);
    if (parentEntry.isSymbolicLink() || !parentEntry.isDirectory()) throw evidenceError("UNSAFE_FILE");
    const realParent = await realpath(parentPath);
    if (realParent !== parentPath) throw evidenceError("UNSAFE_FILE");
    const entry = await lstat(evidencePath);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) throw evidenceError("UNSAFE_FILE");
    if (entry.size > MAX_EVIDENCE_READ_BYTES) throw evidenceError("TOTAL_BYTES_EXCEEDED");
    handle = await open(evidencePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1) throw evidenceError("UNSAFE_FILE");
    if (opened.dev !== entry.dev || opened.ino !== entry.ino) throw evidenceError("UNSAFE_FILE");
    if (opened.size > MAX_EVIDENCE_READ_BYTES) throw evidenceError("TOTAL_BYTES_EXCEEDED");
    const buffer = Buffer.alloc(opened.size);
    const read = await handle.read(buffer, 0, opened.size, 0);
    if (read.bytesRead !== opened.size) throw evidenceError("READ_FAILED");
    const after = await handle.stat();
    if (after.size !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino || !after.isFile() || after.nlink !== 1) throw evidenceError("UNSAFE_FILE");
    const text = buffer.toString("utf8");
    if (Buffer.byteLength(text, "utf8") > MAX_EVIDENCE_READ_BYTES) throw evidenceError("TOTAL_BYTES_EXCEEDED");
    if (text.trim().length === 0) return [];
    const lines = text.trim().split("\n");
    if (lines.length > MAX_EVIDENCE_ENTRIES) throw evidenceError("ENTRY_COUNT_EXCEEDED");
    return lines.map((line, index) => {
      if (Buffer.byteLength(line, "utf8") > MAX_EVIDENCE_LINE_BYTES) throw evidenceError("LINE_BYTES_EXCEEDED");
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        throw evidenceError("JSON_PARSE_FAILED");
      }
      return validateEvidenceEntry(parsed, index + 1);
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid authored command evidence:")) throw error;
    throw evidenceError("READ_FAILED");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function validateEvidenceEntry(value: unknown, lineNumber: number): AuthoredCommandInvocationEvidence {
  if (!isRecord(value)) throw evidenceError("ENTRY_NOT_OBJECT");
  const allowedKeys = new Set(["namespace", "owner", "schemaVersion", "runId", "kind", "accepted", "cwd", "mode", "tools", "station", "verdict", "mutation", "prompt", "rpc", "output", "rejectionCode"]);
  rejectUnknownKeys(value, allowedKeys);
  const entry: AuthoredCommandInvocationEvidence = {
    namespace: expectLiteral(value.namespace, AUTHORED_COMMAND_STUB_NAMESPACE, "namespace"),
    owner: expectLiteral(value.owner, AUTHORED_COMMAND_STUB_OWNER, "owner"),
    schemaVersion: expectLiteral(value.schemaVersion, AUTHORED_COMMAND_STUB_SCHEMA_VERSION, "schemaVersion"),
    runId: expectRunId(value.runId, "runId"),
    kind: expectOneOf(value.kind, ALLOWED_KINDS, "kind"),
    accepted: expectBoolean(value.accepted, "accepted"),
    cwd: expectRelativeCwd(value.cwd, "cwd")
  };
  if ("mode" in value) entry.mode = expectOneOf(value.mode, ALLOWED_MODES, "mode");
  if ("tools" in value) entry.tools = expectOneOf(value.tools, ALLOWED_TOOLS, "tools");
  if ("station" in value) entry.station = expectOneOf(value.station, ALLOWED_STATIONS, "station");
  if ("verdict" in value) entry.verdict = expectOneOf(value.verdict, ALLOWED_VERDICTS, "verdict");
  if ("mutation" in value) entry.mutation = expectOneOf(value.mutation, ALLOWED_MUTATIONS, "mutation");
  if ("prompt" in value) entry.prompt = expectPromptEvidence(value.prompt);
  if ("rpc" in value) entry.rpc = expectRpcEvidence(value.rpc);
  if ("output" in value) entry.output = expectOutputEvidence(value.output);
  if ("rejectionCode" in value) entry.rejectionCode = expectOneOf(value.rejectionCode, ALLOWED_REJECTION_CODES, "rejectionCode");
  validateEvidenceFieldCombinations(entry, lineNumber);
  return entry;
}

function validateEvidenceFieldCombinations(entry: AuthoredCommandInvocationEvidence, _lineNumber: number): void {
  if (entry.accepted && entry.rejectionCode) throw evidenceError("FIELD_COMBINATION_INVALID");
  if (!entry.accepted) {
    if (!entry.rejectionCode) throw evidenceError("FIELD_COMBINATION_INVALID");
    if (entry.mode || entry.tools || entry.station || entry.verdict || entry.mutation || entry.prompt || entry.rpc || entry.output) throw evidenceError("FIELD_COMBINATION_INVALID");
    return;
  }
  if (!entry.output) throw evidenceError("FIELD_COMBINATION_INVALID");
  if (entry.kind === "npm") {
    if (entry.mode || entry.tools || entry.station || entry.verdict || entry.mutation || entry.prompt || entry.rpc) throw evidenceError("FIELD_COMBINATION_INVALID");
    return;
  }
  if (!entry.mode || !entry.tools || !entry.station || !entry.mutation) throw evidenceError("FIELD_COMBINATION_INVALID");
  if (entry.mode === "rpc") {
    if (!entry.rpc || entry.prompt) throw evidenceError("FIELD_COMBINATION_INVALID");
  } else if (!entry.prompt || entry.rpc) throw evidenceError("FIELD_COMBINATION_INVALID");
  if (entry.station === "validator" && !entry.verdict) throw evidenceError("FIELD_COMBINATION_INVALID");
  if (entry.station !== "validator" && entry.verdict) throw evidenceError("FIELD_COMBINATION_INVALID");
}

function evidenceError(code: string): Error {
  return new Error(`Invalid authored command evidence: ${code}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(value: Record<string, unknown>, allowedKeys: Set<string>): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw evidenceError("UNKNOWN_KEY");
  }
}

function expectLiteral<T extends string | number>(value: unknown, expected: T, _field: string): T {
  if (value !== expected) throw evidenceError("LITERAL_INVALID");
  return expected;
}

function expectOneOf<const T extends readonly string[]>(value: unknown, allowed: T, _field: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) throw evidenceError("ENUM_INVALID");
  return value as T[number];
}

function expectBoolean(value: unknown, _field: string): boolean {
  if (typeof value !== "boolean") throw evidenceError("BOOLEAN_INVALID");
  return value;
}

function expectRunId(value: unknown, _field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw evidenceError("RUN_ID_INVALID");
  return value;
}

function expectCount(value: unknown, _field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1_000_000) throw evidenceError("COUNT_INVALID");
  return value;
}

function expectHash(value: unknown, _field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw evidenceError("HASH_INVALID");
  return value;
}

function expectRelativeCwd(value: unknown, _field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.startsWith("/") || value.includes("..") || value.includes("\0") || value.includes("\\")) throw evidenceError("CWD_INVALID");
  return value;
}

function expectPromptEvidence(value: unknown): AuthoredCommandInvocationEvidence["prompt"] {
  if (!isRecord(value)) throw evidenceError("PROMPT_INVALID");
  rejectUnknownKeys(value, new Set(["bytes", "sha256", "signals"]));
  if (!Array.isArray(value.signals) || value.signals.length > MAX_EVIDENCE_ARRAY_LENGTH) throw evidenceError("ARRAY_INVALID");
  return { bytes: expectCount(value.bytes, "prompt.bytes"), sha256: expectHash(value.sha256, "prompt.sha256"), signals: value.signals.map((signal) => expectOneOf(signal, ALLOWED_SIGNALS, "prompt.signals")) };
}

function expectRpcEvidence(value: unknown): AuthoredCommandInvocationEvidence["rpc"] {
  if (!isRecord(value)) throw evidenceError("RPC_INVALID");
  rejectUnknownKeys(value, new Set(["commandCount", "promptBytes", "promptSha256", "earlySteerCount", "lateSteerCount", "steerBytes", "steerSha256"]));
  return { commandCount: expectCount(value.commandCount, "rpc.commandCount"), promptBytes: expectCount(value.promptBytes, "rpc.promptBytes"), promptSha256: expectHash(value.promptSha256, "rpc.promptSha256"), earlySteerCount: expectCount(value.earlySteerCount, "rpc.earlySteerCount"), lateSteerCount: expectCount(value.lateSteerCount, "rpc.lateSteerCount"), steerBytes: expectCount(value.steerBytes, "rpc.steerBytes"), steerSha256: expectHash(value.steerSha256, "rpc.steerSha256") };
}

function expectOutputEvidence(value: unknown): AuthoredCommandInvocationEvidence["output"] {
  if (!isRecord(value)) throw evidenceError("OUTPUT_INVALID");
  rejectUnknownKeys(value, new Set(["bytes", "sha256", "eventClasses"]));
  if (!Array.isArray(value.eventClasses) || value.eventClasses.length > MAX_EVIDENCE_ARRAY_LENGTH) throw evidenceError("ARRAY_INVALID");
  return { bytes: expectCount(value.bytes, "output.bytes"), sha256: expectHash(value.sha256, "output.sha256"), eventClasses: value.eventClasses.map((eventClass) => expectOneOf(eventClass, ALLOWED_EVENT_CLASSES, "output.eventClasses")) };
}

async function assertDirectoryNoSymlink(pathname: string, label: string): Promise<void> {
  let entry;
  try { entry = await lstat(pathname); } catch { throw new Error(`Unsafe authored command stub workspace: ${label} must exist as a directory.`); }
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`Unsafe authored command stub workspace: ${label} must be a real directory.`);
}

async function assertFileNoSymlink(pathname: string, label: string): Promise<void> {
  let entry;
  try { entry = await lstat(pathname); } catch { throw new Error(`Unsafe authored command stub workspace: ${label} must exist as a file.`); }
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`Unsafe authored command stub workspace: ${label} must be a real file.`);
}

async function assertPathAbsentOrDirectoryNoSymlink(pathname: string, label: string): Promise<void> {
  try {
    const entry = await lstat(pathname);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`Unsafe authored command stub workspace: ${label} must be a real directory if it exists.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function assertPathInsideWorkspace(workspaceRoot: string, pathname: string): void {
  const rel = relative(workspaceRoot, resolve(pathname));
  if (rel === "" || rel.startsWith("..") || rel.includes(".." + sep) || rel.startsWith(sep)) throw new Error("Path escaped authored command stub workspace.");
}

async function ensureDirectoryInsideWorkspace(workspaceRoot: string, pathname: string): Promise<void> {
  assertPathInsideWorkspace(workspaceRoot, pathname);
  const parent = resolve(pathname, "..");
  assertPathInsideWorkspace(workspaceRoot, parent);
  if (parent !== pathname) {
    try {
      const realParent = await realpath(parent);
      assertPathInsideWorkspace(workspaceRoot, realParent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await mkdir(pathname, { recursive: true });
}

async function writeFileInsideWorkspaceExclusive(workspaceRoot: string, pathname: string, content: string): Promise<void> {
  assertPathInsideWorkspace(workspaceRoot, pathname);
  const parent = resolve(pathname, "..");
  const realParent = await realpath(parent);
  assertPathInsideWorkspace(workspaceRoot, realParent);
  await writeFile(pathname, content, { flag: "wx" });
}

async function removeDirectoryInsideWorkspace(workspaceRoot: string, pathname: string): Promise<void> {
  assertPathInsideWorkspace(workspaceRoot, pathname);
  try {
    const entry = await lstat(pathname);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Refusing to remove unsafe authored command stub state path.");
    const realParent = await realpath(resolve(pathname, ".."));
    assertPathInsideWorkspace(workspaceRoot, realParent);
    await rm(pathname, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function writeJsonAtomic(pathname: string, value: unknown): Promise<void> {
  const temp = `${pathname}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    await rename(temp, pathname);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeJsonAtomicInsideWorkspace(workspaceRoot: string, pathname: string, value: unknown): Promise<void> {
  assertPathInsideWorkspace(workspaceRoot, pathname);
  const parent = await realpath(resolve(pathname, ".."));
  assertPathInsideWorkspace(workspaceRoot, parent);
  await writeJsonAtomic(pathname, value);
}

function rejectAuthoredSourceFixture(workspaceRoot: string): void {
  const normalized = workspaceRoot.split(sep).join("/");
  if (/\/tutorial\/(workspaces|lessons)(\/|$)/.test(normalized)) {
    throw new Error("Refusing to materialize authored-eval command stubs inside authored tutorial source fixtures.");
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function commandStubJavaScript(): string {
  return String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const executable = path.basename(process.argv[1] || "authored-command-stub");
function bareReject(code, exitCode = 1) {
  process.stderr.write("authored-eval command stub rejected: " + code + "\n");
  process.exit(exitCode);
}
const WORKSPACE_RELATIVE_STATE_DIR = "factory/.tmp/authored-eval-command-stubs";
const WORKSPACE_RELATIVE_EVIDENCE = "factory/.tmp/authored-eval-command-stubs/invocations.jsonl";
const config = loadAndValidateConfig();
const lockDir = path.join(config.stateDir, "evidence.lock");
const EVIDENCE_EVENT_CLASSES = Object.freeze({
  text: ["text"],
  json: ["tool_execution_start", "message_update", "message_end", "agent_end"],
  rpc: ["response", "queue_update", "tool_execution_start", "message_update", "message_end", "agent_end"]
});
const REDACTED_STEER = "[authored-eval redacted queued message]";
const QUALITY_PASS = "All quality checks passed.";
const DUPLICATION_FINDING = "calculator/src/index.ts duplicated operator branch parser";
const DETERMINISTIC_NPM_MARKER = "authored-eval npm test stub: calculator tests passed without network.";
const MAX_RPC_COMMANDS = 32;
const MAX_RPC_STEERS = 16;
const MAX_RPC_LINE_BYTES = 4096;
const MAX_RPC_OUTPUT_BYTES = 32768;

function loadAndValidateConfig() {
  const configPath = process.env.AUTHORED_EVAL_COMMAND_STUB_CONFIG;
  if (!configPath || typeof configPath !== "string") bareReject("MISSING_CONFIG", 78);
  let text;
  try {
    const entry = fs.lstatSync(configPath);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1 || entry.size > 65536) bareReject("CONFIG_INVALID", 78);
    const fd = fs.openSync(configPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size > 65536) bareReject("CONFIG_INVALID", 78);
      text = fs.readFileSync(fd, "utf8");
      const after = fs.fstatSync(fd);
      if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || !after.isFile() || after.nlink !== 1) bareReject("CONFIG_INVALID", 78);
    } finally { fs.closeSync(fd); }
  }
  catch (error) {
    if (error && error.code === "ENOENT") bareReject("CONFIG_UNREADABLE", 78);
    if (error && error.message && String(error.message).includes("authored-eval command stub rejected")) throw error;
    bareReject("CONFIG_INVALID", 78);
  }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (_) { bareReject("CONFIG_INVALID", 78); }
  try {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    const required = ["namespace", "owner", "schemaVersion", "runId", "lessonNumber", "scenarioId", "maxPromptBytes", "maxEvidenceEntryBytes", "maxEvidenceTotalBytes", "rpcEarlySteerWindowMs", "rpcLateSteerWindowMs", "runtime", "workspaceRoot", "stateDir", "evidencePath"];
    for (const key of Object.keys(parsed)) if (!required.includes(key)) throw new Error("invalid");
    if (parsed.namespace !== "evals/workbook/authored-workbook/command-stubs") throw new Error("invalid");
    if (parsed.owner !== "authored-eval" || parsed.schemaVersion !== 1) throw new Error("invalid");
    if (typeof parsed.runId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(parsed.runId)) throw new Error("invalid");
    if (!Number.isInteger(parsed.lessonNumber) || parsed.lessonNumber < 2 || parsed.lessonNumber > 13) throw new Error("invalid");
    if (typeof parsed.scenarioId !== "string" || parsed.scenarioId.length === 0 || parsed.scenarioId.length > 128 || parsed.scenarioId.includes("\0")) throw new Error("invalid");
    for (const key of ["maxPromptBytes", "maxEvidenceEntryBytes", "maxEvidenceTotalBytes", "rpcEarlySteerWindowMs", "rpcLateSteerWindowMs"]) {
      if (!Number.isInteger(parsed[key]) || parsed[key] <= 0 || parsed[key] > 10_000_000) throw new Error("invalid");
    }
    if (parsed.runtime !== "host" && parsed.runtime !== "container") throw new Error("invalid");
    for (const key of ["workspaceRoot", "stateDir", "evidencePath"]) {
      if (typeof parsed[key] !== "string" || parsed[key].length === 0 || parsed[key].length > 4096 || parsed[key].includes("\0") || !path.isAbsolute(parsed[key])) throw new Error("invalid");
    }
    if (parsed.runtime === "container") {
      if (parsed.workspaceRoot !== "/workspace") throw new Error("invalid");
      if (parsed.stateDir !== "/workspace/" + WORKSPACE_RELATIVE_STATE_DIR) throw new Error("invalid");
      if (parsed.evidencePath !== "/workspace/" + WORKSPACE_RELATIVE_EVIDENCE) throw new Error("invalid");
    } else {
      const realWorkspace = fs.realpathSync(parsed.workspaceRoot);
      if (realWorkspace !== parsed.workspaceRoot) throw new Error("invalid");
      if (parsed.stateDir !== path.join(parsed.workspaceRoot, WORKSPACE_RELATIVE_STATE_DIR)) throw new Error("invalid");
      if (parsed.evidencePath !== path.join(parsed.workspaceRoot, WORKSPACE_RELATIVE_EVIDENCE)) throw new Error("invalid");
    }
  } catch (_) { bareReject("CONFIG_INVALID", 78); }
  return parsed;
}
let rejecting = false;
function localReject(code, exitCode = 1) {
  if (!rejecting) {
    rejecting = true;
    try { appendEvidenceBestEffort({ kind: executable === "npm" ? "npm" : "pi", accepted: false, cwd: safeCwd(), rejectionCode: code }); } catch (_) {}
  }
  process.stderr.write("authored-eval command stub rejected: " + code + "\n");
  process.exit(exitCode);
}
function reject(code, exitCode = 1) { localReject(code, exitCode); }
function stubError(code) { const error = new Error(code); error.stubRejectionCode = code; return error; }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function pathInside(root, pathname) {
  const rel = path.relative(root, path.resolve(pathname));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
function assertNoSymlinkDirectory(pathname) {
  const entry = fs.lstatSync(pathname);
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("unsafe");
}
function assertNoSymlinkFile(pathname) {
  const entry = fs.lstatSync(pathname);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) throw new Error("unsafe");
}
function assertRuntimeLayout() {
  try {
    const workspace = fs.realpathSync(config.workspaceRoot);
    if (workspace !== config.workspaceRoot && config.runtime === "host") throw new Error("unsafe");
    const expectedState = path.join(config.workspaceRoot, WORKSPACE_RELATIVE_STATE_DIR);
    const expectedEvidence = path.join(config.workspaceRoot, WORKSPACE_RELATIVE_EVIDENCE);
    if (config.stateDir !== expectedState || config.evidencePath !== expectedEvidence) throw new Error("unsafe");
    const paths = {
      factory: path.join(config.workspaceRoot, "factory"),
      factoryTmp: path.join(config.workspaceRoot, "factory", ".tmp"),
      stateDir: config.stateDir,
      calculator: path.join(config.workspaceRoot, "calculator"),
      calculatorSrc: path.join(config.workspaceRoot, "calculator", "src"),
      index: srcPath()
    };
    for (const pathname of [paths.factory, paths.factoryTmp, paths.stateDir, paths.calculator, paths.calculatorSrc]) {
      if (!pathInside(workspace, pathname)) throw new Error("unsafe");
      const parent = fs.realpathSync(path.dirname(pathname));
      if (!pathInside(workspace, parent)) throw new Error("unsafe");
      assertNoSymlinkDirectory(pathname);
      const real = fs.realpathSync(pathname);
      if (real !== pathname || !pathInside(workspace, real)) throw new Error("unsafe");
    }
    if (!pathInside(workspace, paths.index)) throw new Error("unsafe");
    assertNoSymlinkFile(paths.index);
    const realIndexParent = fs.realpathSync(path.dirname(paths.index));
    if (realIndexParent !== path.dirname(paths.index) || !pathInside(workspace, realIndexParent)) throw new Error("unsafe");
  } catch (_) { reject("RUNTIME_LAYOUT_UNSAFE"); }
}
function withLock(fn) {
  assertRuntimeLayout();
  const deadline = Date.now() + 1500;
  while (true) {
    try {
      const parent = fs.realpathSync(path.dirname(lockDir));
      if (parent !== config.stateDir) reject("RUNTIME_LAYOUT_UNSAFE");
      fs.mkdirSync(lockDir, 0o700);
      break;
    }
    catch (error) {
      if (error && error.code === "EEXIST") {
        try {
          const entry = fs.lstatSync(lockDir);
          if (entry.isSymbolicLink() || !entry.isDirectory()) reject("RUNTIME_LAYOUT_UNSAFE");
          const realParent = fs.realpathSync(path.dirname(lockDir));
          if (realParent !== config.stateDir) reject("RUNTIME_LAYOUT_UNSAFE");
          const ageMs = Date.now() - fs.statSync(lockDir).mtimeMs;
          if (ageMs > 10_000) {
            fs.rmSync(lockDir, { recursive: true, force: true });
            continue;
          }
        } catch (inner) { if (inner && inner.stubRejectionCode) throw inner; }
        if (Date.now() < deadline) { sleepMs(5); continue; }
        throw stubError("LOCK_UNAVAILABLE");
      }
      throw error;
    }
  }
  try { return fn(); } finally {
    try {
      const parent = fs.realpathSync(path.dirname(lockDir));
      const entry = fs.lstatSync(lockDir);
      if (parent === config.stateDir && !entry.isSymbolicLink() && entry.isDirectory()) fs.rmSync(lockDir, { recursive: true, force: true });
    } catch (_) { }
  }
}
function evidenceLine(entry) {
  const full = {
    namespace: config.namespace,
    owner: config.owner,
    schemaVersion: config.schemaVersion,
    runId: config.runId,
    ...entry
  };
  const line = JSON.stringify(full) + "\n";
  if (Buffer.byteLength(line, "utf8") > config.maxEvidenceEntryBytes) throw stubError("EVIDENCE_LIMIT_EXCEEDED");
  return line;
}
function openEvidenceForAppend(lineBytes) {
  assertRuntimeLayout();
  const evidenceParent = fs.realpathSync(path.dirname(config.evidencePath));
  if (evidenceParent !== config.stateDir || config.evidencePath !== path.join(config.stateDir, "invocations.jsonl")) throw stubError("RUNTIME_LAYOUT_UNSAFE");
  const entry = fs.lstatSync(config.evidencePath);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) throw stubError("RUNTIME_LAYOUT_UNSAFE");
  const fd = fs.openSync(config.evidencePath, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== entry.dev || opened.ino !== entry.ino) throw stubError("RUNTIME_LAYOUT_UNSAFE");
    if (opened.size + lineBytes > config.maxEvidenceTotalBytes) throw stubError("EVIDENCE_LIMIT_EXCEEDED");
    return fd;
  } catch (error) {
    try { fs.closeSync(fd); } catch (_) {}
    throw error;
  }
}
function appendPreparedEvidence(line) {
  withLock(() => {
    const lineBytes = Buffer.byteLength(line, "utf8");
    const fd = openEvidenceForAppend(lineBytes);
    try { fs.writeSync(fd, line, undefined, "utf8"); }
    finally { fs.closeSync(fd); }
  });
}
function appendEvidenceBestEffort(entry) {
  const line = evidenceLine(entry);
  appendPreparedEvidence(line);
}
function commitAccepted(entry, sourcePlan) {
  const line = evidenceLine(entry);
  withLock(() => {
    const lineBytes = Buffer.byteLength(line, "utf8");
    const fd = openEvidenceForAppend(lineBytes);
    let changed = false;
    try {
      if (sourcePlan && sourcePlan.nextSource !== undefined) {
        writeSourceAtomic(sourcePlan.nextSource);
        changed = true;
      }
      fs.writeSync(fd, line, undefined, "utf8");
    } catch (error) {
      if (changed && sourcePlan && sourcePlan.originalSource !== undefined) {
        try { writeSourceAtomic(sourcePlan.originalSource); } catch (_) {}
      }
      throw error;
    } finally { fs.closeSync(fd); }
  });
}
function appendEvidence(entry) { appendEvidenceBestEffort(entry); }
function workspaceRelativeCwd() {
  assertRuntimeLayout();
  const real = fs.realpathSync(process.cwd());
  const root = fs.realpathSync(config.workspaceRoot);
  const rel = path.relative(root, real);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return rel || ".";
  throw new Error("OUTSIDE_WORKSPACE");
}
function safeCwd() {
  try { return workspaceRelativeCwd(); } catch (_) { return "outside-workspace"; }
}
function requireCwdUnder(allowed) {
  let rel;
  try { rel = workspaceRelativeCwd(); } catch (_) { reject("CWD_OUTSIDE_WORKSPACE"); }
  if (allowed.some((prefix) => rel === prefix || rel.startsWith(prefix + path.sep))) return rel;
  reject("CWD_NOT_ALLOWED");
}
function byteLength(value) { return Buffer.byteLength(value, "utf8"); }
function promptEvidence(prompt) {
  const bytes = byteLength(prompt);
  if (bytes > config.maxPromptBytes) reject("PROMPT_TOO_LARGE");
  return { bytes, sha256: sha256(prompt), signals: promptSignals(prompt) };
}
function promptSignals(prompt) {
  const signals = [];
  if (/VERDICT:\s*FAIL|\[FAIL\]/.test(prompt)) signals.push("verdict-fail-feedback");
  if (/VERDICT:\s*PASS|\[PASS\]/.test(prompt)) signals.push("verdict-pass-evidence");
  if (labelledEvidence(prompt).complete) signals.push("complete-labelled-evidence");
  if (/subject line under 72|commit message|emit only the message/i.test(prompt)) signals.push("commit-message-request");
  if (/Below is the record of the most recent run/i.test(prompt)) signals.push("record-question");
  return signals;
}
function outputEvidence(output, eventClasses) {
  return { bytes: byteLength(output), sha256: sha256(output), eventClasses };
}
async function readBoundedStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > config.maxPromptBytes) reject("PROMPT_TOO_LARGE");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function parsePiArgs(argv) {
  let mode = "text";
  let tools;
  let noTools = false;
  let promptMode = false;
  let noSession = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--no-session") { noSession = true; continue; }
    if (arg === "-p") { promptMode = true; continue; }
    if (arg === "--mode") { mode = argv[++index]; continue; }
    if (arg === "--tools") { tools = argv[++index]; continue; }
    if (arg === "--no-tools") { noTools = true; continue; }
    reject("PI_ARG_NOT_ALLOWLISTED");
  }
  if (!noSession) reject("PI_NO_SESSION_REQUIRED");
  if (!["text", "json", "rpc"].includes(mode)) reject("PI_MODE_NOT_ALLOWLISTED");
  if (mode === "rpc" && promptMode) reject("PI_RPC_WITH_PROMPT_FLAG");
  if (mode !== "rpc" && !promptMode) reject("PI_PROMPT_FLAG_REQUIRED");
  if (noTools && tools) reject("PI_TOOLS_CONFLICT");
  const allowedToolSets = ["read,grep,find,ls", "read,grep,find,ls,bash", "read,edit,write,grep,find,ls"];
  if (!noTools && (!tools || !allowedToolSets.includes(tools))) reject("PI_TOOLS_NOT_ALLOWLISTED");
  if (tools === "read,grep,find,ls,bash" && config.lessonNumber >= 6) reject("PI_VALIDATOR_BASH_AFTER_LESSON_006");
  if (mode === "rpc" && tools !== "read,edit,write,grep,find,ls") reject("PI_RPC_TOOLS_NOT_ALLOWLISTED");
  const cwd = noTools ? requireCwdUnder(["factory"]) : requireCwdUnder(["calculator"]);
  return { mode, tools: noTools ? "none" : tools, toolList: noTools ? [] : tools.split(","), noTools, cwd };
}
function classify(prompt, tools) {
  if (tools === "none") return "ask";
  if (tools === "read,edit,write,grep,find,ls") return (/VERDICT:\s*FAIL|\[FAIL\]|validate-findings|repair\.md/i.test(prompt) || sourceState().partial) ? "repair" : "doer";
  if (/subject line under 72|commit message|emit only the message/i.test(prompt)) return "commit";
  return "validator";
}
function srcPath() { return path.join(config.workspaceRoot, "calculator", "src", "index.ts"); }
function readSource() { assertRuntimeLayout(); return fs.readFileSync(srcPath(), "utf8"); }
function writeSourceAtomic(text) {
  assertRuntimeLayout();
  const destination = srcPath();
  const workspace = fs.realpathSync(config.workspaceRoot);
  const parent = fs.realpathSync(path.dirname(destination));
  if (!pathInside(workspace, destination) || !pathInside(workspace, parent)) reject("MUTATION_PATH_NOT_ALLOWED");
  const tmp = destination + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
  try {
    const destinationEntry = fs.lstatSync(destination);
    if (destinationEntry.isSymbolicLink() || !destinationEntry.isFile() || destinationEntry.nlink !== 1) reject("MUTATION_PATH_NOT_ALLOWED");
    fs.writeFileSync(tmp, text, { flag: "wx" });
    const tmpParent = fs.realpathSync(path.dirname(tmp));
    const tmpEntry = fs.lstatSync(tmp);
    if (tmpParent !== parent || !tmpEntry.isFile() || tmpEntry.isSymbolicLink() || tmpEntry.nlink !== 1) reject("MUTATION_PATH_NOT_ALLOWED");
    fs.renameSync(tmp, destination);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    throw error;
  }
}
const HELPER = ${JSON.stringify(AUTHORED_CALCULATOR_REFACTOR_HELPER)};
const ANCHORS = Object.freeze(${JSON.stringify(AUTHORED_CALCULATOR_REFACTOR_ANCHORS)});
function occurrences(source, needle) { return source.split(needle).length - 1; }
function sourceState(source = readSource()) {
  const helperCount = occurrences(source, "const readFirstOperand = ");
  const add = source.includes(ANCHORS.addAfter);
  const subtract = source.includes(ANCHORS.subtractAfter);
  const multiply = source.includes(ANCHORS.multiplyAfter);
  const divide = source.includes(ANCHORS.divideAfter);
  const duplicateBranches = [ANCHORS.addBefore, ANCHORS.subtractBefore, ANCHORS.multiplyBefore, ANCHORS.divideBefore].filter((anchor) => source.includes(anchor)).length;
  return { helper: helperCount === 1, helperCount, add, subtract, multiply, divide, duplicateBranches, complete: helperCount === 1 && add && subtract && multiply && divide && duplicateBranches === 0, partial: helperCount === 1 && add && subtract && (!multiply || !divide || duplicateBranches > 0) };
}
function replaceOnce(source, before, after) {
  if (occurrences(source, before) !== 1) reject("SOURCE_ANCHOR_MISSING");
  return source.replace(before, after);
}
function noSourcePlan(mutation) { return { mutation }; }
function sourcePlan(originalSource, nextSource, mutation) { return nextSource === originalSource ? noSourcePlan(mutation) : { mutation, originalSource, nextSource }; }
function planPartialRefactor() {
  const original = readSource();
  const state = sourceState(original);
  if (state.complete || state.partial) return noSourcePlan(state.complete ? "already-complete" : "none");
  if (occurrences(original, ANCHORS.insertion) !== 1 || occurrences(original, ANCHORS.addBefore) !== 1 || occurrences(original, ANCHORS.subtractBefore) !== 1) reject("SOURCE_ANCHOR_MISSING");
  let next = original.replace(ANCHORS.insertion, HELPER + ANCHORS.insertion);
  next = replaceOnce(next, ANCHORS.addBefore, ANCHORS.addAfter);
  next = replaceOnce(next, ANCHORS.subtractBefore, ANCHORS.subtractAfter);
  return sourcePlan(original, next, "partial-refactor");
}
function planCompleteRefactor() {
  const original = readSource();
  const state = sourceState(original);
  if (state.complete) return noSourcePlan("already-complete");
  let next = original;
  const mutation = "complete-refactor";
  if (!state.helper) {
    for (const anchor of [ANCHORS.insertion, ANCHORS.addBefore, ANCHORS.subtractBefore, ANCHORS.multiplyBefore, ANCHORS.divideBefore]) if (occurrences(original, anchor) !== 1) reject("SOURCE_ANCHOR_MISSING");
    next = next.replace(ANCHORS.insertion, HELPER + ANCHORS.insertion);
    next = replaceOnce(next, ANCHORS.addBefore, ANCHORS.addAfter);
    next = replaceOnce(next, ANCHORS.subtractBefore, ANCHORS.subtractAfter);
    next = replaceOnce(next, ANCHORS.multiplyBefore, ANCHORS.multiplyAfter);
    next = replaceOnce(next, ANCHORS.divideBefore, ANCHORS.divideAfter);
  } else {
    if (!state.add) next = replaceOnce(next, ANCHORS.addBefore, ANCHORS.addAfter);
    if (!state.subtract) next = replaceOnce(next, ANCHORS.subtractBefore, ANCHORS.subtractAfter);
    if (!state.multiply) next = replaceOnce(next, ANCHORS.multiplyBefore, ANCHORS.multiplyAfter);
    if (!state.divide) next = replaceOnce(next, ANCHORS.divideBefore, ANCHORS.divideAfter);
  }
  if (!sourceState(next).complete) reject("SOURCE_ANCHOR_MISSING");
  return sourcePlan(original, next, mutation);
}
function applyPartialRefactor() { const plan = planPartialRefactor(); if (plan.nextSource !== undefined) writeSourceAtomic(plan.nextSource); return plan.mutation; }
function applyCompleteRefactor() { const plan = planCompleteRefactor(); if (plan.nextSource !== undefined) writeSourceAtomic(plan.nextSource); return plan.mutation; }
function parseLabelledSections(prompt) {
  const header = /^=== (QUALITY BEFORE(?: \(recorded before the doer ran\))?|QUALITY NOW|TESTS(?: NOW)?|WORKING DIFF|DIFF SINCE BASELINE) ===$/gm;
  const matches = [...prompt.matchAll(header)];
  const canonical = ["QUALITY BEFORE", "QUALITY NOW", "TESTS", "WORKING DIFF"];
  const sections = new Map();
  let valid = matches.length === 4;
  let invalidReason = matches.length === 0 ? "missing" : "count";
  for (let i = 0; i < matches.length; i++) {
    const rawName = matches[i][1];
    const name = rawName.startsWith("QUALITY BEFORE") ? "QUALITY BEFORE" : rawName === "TESTS NOW" ? "TESTS" : rawName === "DIFF SINCE BASELINE" ? "WORKING DIFF" : rawName;
    const start = (matches[i].index || 0) + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index || prompt.length : prompt.length;
    const body = prompt.slice(start, end).trim();
    if (name !== canonical[i]) { valid = false; invalidReason = "order"; }
    if (sections.has(name)) { valid = false; invalidReason = "duplicate"; }
    if (body.length === 0) { valid = false; invalidReason = "empty"; }
    sections.set(name, body);
  }
  if (matches.length > 0 && matches.length !== 4) valid = false;
  if (valid) invalidReason = "";
  return { sections, valid, complete: valid, present: matches.length > 0, invalidReason };
}
function sectionMap(prompt) { return parseLabelledSections(prompt).sections; }
function currentQualityFromSource(source) {
  return sourceState(source).complete ? QUALITY_PASS : "Findings reported by: eslint.\n- " + DUPLICATION_FINDING;
}
function diffHasCompleteRefactor(diff) {
  return diff.includes("+    const readFirstOperand = (separator: \"and\" | \"from\" | \"by\"): number => {")
    && diff.includes("+      const first = readFirstOperand(\"and\");")
    && diff.includes("+      const first = readFirstOperand(\"from\");")
    && occurrences(diff, "+      const first = readFirstOperand(\"by\");") === 2
    && occurrences(diff, "-      const first = read();") >= 4
    && diff.includes("-      if (pieces[place++] !== \"and\") fail();")
    && diff.includes("-      if (pieces[place++] !== \"from\") fail();")
    && occurrences(diff, "-      if (pieces[place++] !== \"by\") fail();") >= 2;
}
function nonPassingQualityBaseline(text) {
  return /Findings reported by:/i.test(text)
    || text.includes(DUPLICATION_FINDING)
    || /duplicated operator branch parser|no duplication|duplication/i.test(text) && !text.includes(QUALITY_PASS);
}
function labelledEvidence(prompt) {
  const parsed = parseLabelledSections(prompt);
  const qualityBefore = parsed.sections.get("QUALITY BEFORE") || "";
  const qualityNow = parsed.sections.get("QUALITY NOW") || "";
  const tests = parsed.sections.get("TESTS") || "";
  const diff = parsed.sections.get("WORKING DIFF") || "";
  const currentQuality = currentQualityFromSource(readSource());
  const testsPassed = tests.includes(DETERMINISTIC_NPM_MARKER);
  const qualityPassed = qualityNow.includes(QUALITY_PASS);
  const qualityCorroborates = qualityNow.includes(currentQuality);
  const baselineReduction = nonPassingQualityBaseline(qualityBefore) && !qualityBefore.includes(QUALITY_PASS) && qualityBefore !== qualityNow;
  const diffComplete = diffHasCompleteRefactor(diff);
  return { sections: parsed.sections, qualityBefore, qualityNow, tests, diff, testsPassed, qualityPassed, qualityCorroborates, baselineReduction, diffComplete, complete: parsed.complete, present: parsed.present, valid: parsed.valid, invalidReason: parsed.invalidReason };
}
function validatorVerdict(prompt) {
  const sourceText = readSource();
  const source = sourceState(sourceText);
  if (!source.complete) return "FAIL";
  const evidence = labelledEvidence(prompt);
  const currentQuality = currentQualityFromSource(sourceText);
  const baselineOk = evidence.qualityBefore.includes(QUALITY_PASS) || evidence.baselineReduction;
  return evidence.complete && evidence.testsPassed && evidence.qualityPassed && evidence.qualityCorroborates && baselineOk && evidence.diffComplete ? "PASS" : "FAIL";
}
function baselineSummaryFromPrompt(prompt) {
  if (prompt.includes(DUPLICATION_FINDING)) return "calculator/src/index.ts duplicated operator branch parser";
  if (/Findings reported by:/i.test(prompt)) return "quality findings were supplied in the raw lesson-stage baseline";
  return "no recorded quality finding was visible in the prompt";
}
function currentQualitySummary(sourceText) {
  const quality = currentQualityFromSource(sourceText);
  return quality.includes(DUPLICATION_FINDING) ? "calculator/src/index.ts duplicated operator branch parser" : quality.trim();
}
function lessonStageValidatorText(prompt) {
  const sourceText = readSource();
  const source = sourceState(sourceText);
  const criterion = source.partial
    ? "the refactor is partial; one or more operator branches still duplicate parser work"
    : source.complete
      ? "the source now has the shared operand reader across all operator branches"
      : "the expected duplication-reduction edit is incomplete";
  return "VERDICT: FAIL\n\nEVIDENCE:\n"
    + "- Validator ran read-only over the calculator and compared the current quality result with the recorded baseline supplied in the prompt.\n"
    + "- Recorded baseline reports: " + baselineSummaryFromPrompt(prompt) + ".\n"
    + "- Current quality still reports: " + currentQualitySummary(sourceText) + ".\n"
    + "- Criterion not yet met: " + criterion + ".\n";
}
function askSummaryText() {
  return "The supplied record contains deterministic authored-eval structural events with zero recorded cost.\n\n"
    + "From the supplied record: factory/ is the factory root, refactor/ is the assembly line, and factory/refactor/run.sh is the orchestrator. "
    + "The line uses prompt/script station pairs for doer, validator, repair, and commit work, while ask.sh is a no-tools station that answers from the event record. "
    + "run.sh handles routing between stations, carries TESTS/QUALITY/DIFF evidence into validation, branches on VERDICT to repair or commit, and stopped after PASS or its failure/iteration bounds. "
    + "The operator starts the line, watches the bounded record, asks what happened, and keeps judgement over cost, regressions, and whether the result is worth it.\n";
}
function stationText(station, prompt) {
  if (station === "doer") {
    const plan = sourceState().helper ? planCompleteRefactor() : planPartialRefactor();
    return { text: "Stub doer completed a deterministic calculator refactoring.\n", mutation: plan.mutation, sourcePlan: plan };
  }
  if (station === "repair") {
    const plan = planCompleteRefactor();
    return { text: "Stub repair completed the deterministic calculator refactoring.\n", mutation: plan.mutation, sourcePlan: plan };
  }
  if (station === "validator") {
    const parsed = parseLabelledSections(prompt);
    if (!parsed.present) return { text: lessonStageValidatorText(prompt), verdict: "FAIL", mutation: "none" };
    const verdict = validatorVerdict(prompt);
    const source = sourceState();
    const evidence = labelledEvidence(prompt);
    const text = verdict === "PASS"
      ? "VERDICT: PASS\n\nFINDINGS:\n- [PASS] passes its tests: labelled TESTS evidence contains the exact deterministic npm marker.\n- [PASS] reveals intention: src/index.ts has a named readFirstOperand helper.\n- [PASS] no duplication: all four operator branches use the shared operand reader.\n- [PASS] fewest elements: WORKING DIFF demonstrates the helper and all four branch replacements.\n"
      : "VERDICT: FAIL\n\nFINDINGS:\n- [FAIL] passes its tests: exact labelled TESTS evidence and '" + QUALITY_PASS + "' are required before a final pass.\n- [" + (source.helper ? "PASS" : "FAIL") + "] reveals intention: the calculator source is inspected directly for the helper seam.\n- [FAIL] no duplication: " + (source.partial ? "one or more operator branches still duplicate parser work." : "the expected duplication-reduction edit is incomplete.") + "\n- [FAIL] fewest elements: " + (evidence.complete ? "labelled evidence is present but tests, quality, source, and diff do not corroborate one another." : "complete QUALITY/TESTS/DIFF evidence has not been handed to the validator.") + "\n";
    return { text, verdict, mutation: "none" };
  }
  if (station === "commit") return { text: "Refactor calculator operand parsing\n\nUse a shared operand reader across prefix operator branches.\n", mutation: "none" };
  return { text: askSummaryText(), mutation: "none" };
}
function assistantMessage(text) { return { role: "assistant", content: [{ type: "text", text }] }; }
function toolArgs(toolName) {
  if (toolName === "bash") return { command: "node scripts/quality.mjs" };
  if (toolName === "edit" || toolName === "write") return { path: "src/index.ts" };
  if (toolName === "grep") return { command: "grep -n readFirstOperand src/index.ts" };
  if (toolName === "find") return { path: "." };
  return { path: toolName === "ls" ? "." : "src/index.ts" };
}
function jsonEventsFor(text, tools) {
  const events = [];
  let seq = 1;
  for (const toolName of tools) events.push({ type: "tool_execution_start", toolCallId: "call_authored_stub_" + seq++, toolName, args: toolArgs(toolName) });
  const message = { role: "assistant", content: [{ type: "text", text: "authored-eval synthetic station response" }], usage: { cost: { total: 0 } } };
  events.push({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "authored-eval synthetic station response", partial: message.content[0] } });
  events.push({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: { cost: { total: 0 } } } });
  events.push({ type: "agent_end", messages: [assistantMessage(text)], willRetry: false });
  return events;
}
async function runPi() {
  const parsed = parsePiArgs(process.argv.slice(2));
  if (parsed.mode === "rpc") return runRpc(parsed);
  const prompt = await readBoundedStdin();
  const pe = promptEvidence(prompt);
  const station = classify(prompt, parsed.tools);
  const result = stationText(station, prompt);
  const eventClasses = parsed.mode === "json" ? EVIDENCE_EVENT_CLASSES.json : EVIDENCE_EVENT_CLASSES.text;
  const output = parsed.mode === "json" ? jsonEventsFor(result.text, parsed.toolList).map((event) => JSON.stringify(event)).join("\n") + "\n" : result.text;
  commitAccepted({ kind: "pi", accepted: true, cwd: parsed.cwd, mode: parsed.mode, tools: parsed.tools, station, verdict: result.verdict, mutation: result.mutation, prompt: pe, output: outputEvidence(output, eventClasses) }, result.sourcePlan);
  process.stdout.write(output);
}
function parseRpcLine(line) {
  let command;
  try { command = JSON.parse(line); } catch (_) { reject("RPC_JSON_INVALID"); }
  if (!command || typeof command !== "object" || Array.isArray(command)) reject("RPC_COMMAND_NOT_ALLOWLISTED");
  if (("id" in command) && typeof command.id !== "string") reject("RPC_COMMAND_NOT_ALLOWLISTED");
  if ((command.type !== "prompt" && command.type !== "steer") || typeof command.message !== "string") reject("RPC_COMMAND_NOT_ALLOWLISTED");
  const bytes = byteLength(command.message);
  if (bytes > config.maxPromptBytes) reject(command.type === "prompt" ? "RPC_PROMPT_TOO_LARGE" : "RPC_STEER_TOO_LARGE");
  return { id: command.id, type: command.type, message: command.message, bytes, sha256: sha256(command.message) };
}
function runRpc(parsed) {
  let buffer = "";
  let totalInputBytes = 0;
  let commandCount = 0;
  let prompt;
  const earlySteers = [];
  const lateSteers = [];
  const eventClasses = new Set();
  let emitted = "";
  let emittedBytes = 0;
  let phase = "awaiting-prompt";
  let promptAcceptedAt = 0;
  let finished = false;
  let stdinEnded = false;
  const timers = new Set();
  function setTimer(fn, ms) {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
    timers.add(timer);
    return timer;
  }
  function cancelTimers() { for (const timer of timers) clearTimeout(timer); timers.clear(); }
  function ensureCanEmit(line) {
    const bytes = byteLength(line);
    if (bytes > MAX_RPC_LINE_BYTES || emittedBytes + bytes > MAX_RPC_OUTPUT_BYTES) reject("RPC_OUTPUT_TOO_LARGE");
  }
  function jsonLine(event) {
    const line = JSON.stringify(event) + "\n";
    ensureCanEmit(line);
    emitted += line;
    emittedBytes += byteLength(line);
    if (EVIDENCE_EVENT_CLASSES.rpc.includes(event.type)) eventClasses.add(event.type);
    process.stdout.write(line);
  }
  function prepareLine(event, projectedBytes = emittedBytes) {
    const line = JSON.stringify(event) + "\n";
    const bytes = byteLength(line);
    if (bytes > MAX_RPC_LINE_BYTES || projectedBytes + bytes > MAX_RPC_OUTPUT_BYTES) reject("RPC_OUTPUT_TOO_LARGE");
    return line;
  }
  function response(command, success = true) {
    const event = { type: "response", command: command.type, success };
    if (command.id) event.id = command.id;
    jsonLine(event);
  }
  function queueUpdate(steeringCount) {
    jsonLine({ type: "queue_update", steering: Array.from({ length: steeringCount }, () => REDACTED_STEER), followUp: [] });
  }
  function receiveCommand(command) {
    if (finished) return;
    commandCount += 1;
    if (commandCount > MAX_RPC_COMMANDS) reject("RPC_COMMAND_LIMIT_EXCEEDED");
    if (command.type === "prompt") {
      if (prompt) reject("RPC_DUPLICATE_PROMPT");
      prompt = command;
      promptAcceptedAt = Date.now();
      phase = "early";
      response(command);
      setTimer(decisionPoint, config.rpcEarlySteerWindowMs);
      return;
    }
    if (!prompt) reject("RPC_STEER_BEFORE_PROMPT");
    if (earlySteers.length + lateSteers.length >= MAX_RPC_STEERS) reject("RPC_COMMAND_LIMIT_EXCEEDED");
    const elapsed = Date.now() - promptAcceptedAt;
    const timing = phase === "early" && earlySteers.length === 0 && elapsed < config.rpcEarlySteerWindowMs ? "early" : "late";
    if (timing === "early") {
      earlySteers.push(command);
      response(command);
      queueUpdate(earlySteers.length + lateSteers.length);
      return;
    }
    if (phase === "early") phase = "late";
    lateSteers.push(command);
    response(command);
    queueUpdate(earlySteers.length + lateSteers.length);
  }
  function decisionPoint() {
    if (finished || !prompt || stdinEnded) return;
    phase = "late";
    jsonLine({ type: "queue_update", steering: lateSteers.map(() => REDACTED_STEER), followUp: [] });
    jsonLine({ type: "tool_execution_start", toolCallId: "call_authored_rpc_read", toolName: "read", args: { path: "src/index.ts" } });
    jsonLine({ type: "tool_execution_start", toolCallId: "call_authored_rpc_edit", toolName: "edit", args: { path: "src/index.ts" } });
    const delta = earlySteers.length > 0 ? "authored-eval accepted early steer" : "authored-eval deterministic rpc doer";
    jsonLine({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: delta }], usage: { cost: { total: 0 } } }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: { type: "text", text: delta } } });
    setTimer(finish, config.rpcLateSteerWindowMs);
  }
  function finish() {
    if (finished || !prompt) return;
    if (stdinEnded || process.stdin.destroyed) reject("RPC_FIFO_HOLDER_REQUIRED");
    phase = "ended";
    const plan = earlySteers.length > 0 ? planCompleteRefactor() : (sourceState().helper ? planCompleteRefactor() : planPartialRefactor());
    const text = earlySteers.length > 0 ? "Stub RPC doer applied the early steer before finishing.\n" : "Stub RPC doer finished deterministically.\n";
    const finalEvents = [
      { type: "queue_update", steering: [], followUp: [] },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: { cost: { total: 0 } } } },
      { type: "agent_end", messages: [assistantMessage(text)], willRetry: false }
    ];
    let finalText = "";
    let projectedBytes = emittedBytes;
    for (const event of finalEvents) {
      const line = prepareLine(event, projectedBytes);
      finalText += line;
      projectedBytes += byteLength(line);
      if (EVIDENCE_EVENT_CLASSES.rpc.includes(event.type)) eventClasses.add(event.type);
    }
    const candidateOutput = emitted + finalText;
    const steerJoined = earlySteers.concat(lateSteers).map((steer) => steer.sha256).join("");
    commitAccepted({
      kind: "pi",
      accepted: true,
      cwd: parsed.cwd,
      mode: "rpc",
      tools: parsed.tools,
      station: "doer",
      mutation: plan.mutation,
      rpc: { commandCount: 1 + earlySteers.length + lateSteers.length, promptBytes: prompt.bytes, promptSha256: prompt.sha256, earlySteerCount: earlySteers.length, lateSteerCount: lateSteers.length, steerBytes: earlySteers.concat(lateSteers).reduce((sum, steer) => sum + steer.bytes, 0), steerSha256: sha256(steerJoined) },
      output: outputEvidence(candidateOutput, EVIDENCE_EVENT_CLASSES.rpc.filter((eventClass) => eventClasses.has(eventClass)))
    }, plan);
    emitted = candidateOutput;
    emittedBytes = byteLength(candidateOutput);
    finished = true;
    process.stdout.write(finalText);
  }
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    totalInputBytes += Buffer.byteLength(chunk, "utf8");
    if (totalInputBytes > Math.min(config.maxPromptBytes * 8, MAX_RPC_LINE_BYTES * MAX_RPC_COMMANDS)) reject("RPC_INPUT_TOO_LARGE");
    buffer += chunk;
    if (byteLength(buffer) > MAX_RPC_LINE_BYTES) reject("RPC_LINE_TOO_LARGE");
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, newline);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      buffer = buffer.slice(newline + 1);
      if (line.length === 0) continue;
      if (byteLength(line) > MAX_RPC_LINE_BYTES) reject("RPC_LINE_TOO_LARGE");
      receiveCommand(parseRpcLine(line));
    }
  });
  process.stdin.on("end", () => {
    stdinEnded = true;
    if (buffer.length > 0) receiveCommand(parseRpcLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer));
    if (!prompt) reject("RPC_PROMPT_REQUIRED");
    if (!finished) {
      cancelTimers();
      reject("RPC_FIFO_HOLDER_REQUIRED");
    }
  });
}
function runNpm() {
  const cwd = requireCwdUnder(["calculator"]);
  const argv = process.argv.slice(2);
  const allowed = argv.length === 1 && argv[0] === "test";
  const allowedRun = argv.length === 2 && argv[0] === "run" && argv[1] === "test";
  if (!allowed && !allowedRun) reject("NPM_COMMAND_NOT_ALLOWLISTED");
  const output = "> calculator@0.1.0 test\n> vitest run --run\n\nTests: PASS\n" + DETERMINISTIC_NPM_MARKER + "\n";
  appendEvidence({ kind: "npm", accepted: true, cwd, output: outputEvidence(output, ["text"]) });
  process.stdout.write(output);
}
(async () => {
  if (executable === "pi") await runPi();
  else if (executable === "npm") runNpm();
  else reject("EXECUTABLE_NOT_ALLOWLISTED", 78);
})().catch((error) => {
  const code = error && error.stubRejectionCode ? error.stubRejectionCode : "UNHANDLED_STUB_ERROR";
  try { localReject(code); } catch (_) { process.stderr.write("authored-eval command stub rejected: " + code + "\n"); process.exit(1); }
});
`;
}
