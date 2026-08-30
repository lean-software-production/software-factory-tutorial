#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rootCommandContract } from "./local-test-command-contract.mjs";

export const LOCAL_TEST_PROFILES = Object.freeze([
  "test",
  "test:fast",
  "test:engine",
  "test:workbook",
  "test:workbook:fast"
]);

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SIGNAL_EXIT_CODES = Object.freeze({ SIGINT: 130, SIGTERM: 143 });

export class LocalTestUsageError extends Error {}

export function parseLocalTestOrchestratorArgs(argv) {
  if (argv.length !== 1 || !LOCAL_TEST_PROFILES.includes(argv[0])) {
    throw new LocalTestUsageError(`Usage: node scripts/run-local-tests.mjs <${LOCAL_TEST_PROFILES.join("|")}>`);
  }
  return argv[0];
}

export function commandInvocationForStep(step, { cwd = repositoryRoot, env = process.env } = {}) {
  const parts = step.shell.split(" ").filter((part) => part.length > 0);
  const command = parts.shift();
  if (!command) throw new Error(`Local test step ${step.command} has no command to run.`);
  return Object.freeze({
    command,
    args: Object.freeze(parts),
    cwd,
    env,
    stdio: "inherit",
    shell: false
  });
}

export function createReportInspector({ cwd = repositoryRoot, filesystem = defaultReportFilesystem } = {}) {
  return Object.freeze({
    snapshot: (reportTarget) => snapshotReportTarget(reportTarget, { cwd, filesystem }),
    changedReports: (snapshot) => changedReportPathsSince(snapshot, { cwd, filesystem })
  });
}

export async function snapshotReportTarget(reportTarget, { cwd = repositoryRoot, filesystem = defaultReportFilesystem } = {}) {
  if (!reportTarget) return freezeReportSnapshot(reportTarget, []);
  const files = await reportTargetFiles(reportTarget, { cwd, filesystem });
  const entries = await Promise.all(files.map(async (relativePath) => [relativePath, await fileSignature(resolve(cwd, relativePath), filesystem)]));
  return freezeReportSnapshot(reportTarget, entries.filter(([, signature]) => signature));
}

export async function changedReportPathsSince(snapshot, { cwd = repositoryRoot, filesystem = defaultReportFilesystem } = {}) {
  if (!snapshot?.reportTarget) return Object.freeze([]);
  const before = new Map(snapshot.entries);
  const files = await reportTargetFiles(snapshot.reportTarget, { cwd, filesystem });
  const changed = [];
  for (const relativePath of files) {
    const after = await fileSignature(resolve(cwd, relativePath), filesystem);
    if (!after) continue;
    const previous = before.get(relativePath);
    if (!previous || !sameFileSignature(previous, after)) changed.push(relativePath);
  }
  return Object.freeze(changed.sort());
}

const defaultReportFilesystem = Object.freeze({ readdir, readFile, stat });

export function reportTargetKind(reportTarget) {
  if (!reportTarget) return "none";
  if (reportTarget.endsWith("/*.received.png") && basename(reportTarget) === "*.received.png") return "visual-received-glob";
  return "exact-file";
}

async function reportTargetFiles(reportTarget, { cwd, filesystem }) {
  const kind = reportTargetKind(reportTarget);
  if (kind === "none") return [];
  if (kind === "visual-received-glob") {
    const directory = dirname(reportTarget);
    let entries;
    try {
      entries = await filesystem.readdir(resolve(cwd, directory));
    } catch (error) {
      if (isMissingPathError(error)) return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.endsWith(".received.png"))
      .map((entry) => relativeReportPath(resolve(cwd, directory, entry), cwd))
      .sort();
  }
  const signature = await fileSignature(resolve(cwd, reportTarget), filesystem);
  return signature ? [relativeReportPath(resolve(cwd, reportTarget), cwd)] : [];
}

async function fileSignature(path, filesystem) {
  let details;
  try {
    details = await filesystem.stat(path);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
  if (!details.isFile()) return undefined;
  const content = await filesystem.readFile(path);
  return Object.freeze({
    identity: `${details.dev}:${details.ino}`,
    size: details.size,
    mtimeMs: details.mtimeMs,
    hash: createHash("sha256").update(content).digest("hex")
  });
}

function freezeReportSnapshot(reportTarget, entries) {
  return Object.freeze({ reportTarget, entries: Object.freeze(entries.map(([path, signature]) => Object.freeze([path, signature]))) });
}

function sameFileSignature(left, right) {
  return left.identity === right.identity && left.size === right.size && left.mtimeMs === right.mtimeMs && left.hash === right.hash;
}

function relativeReportPath(path, cwd) {
  return relative(cwd, path).split("/").join("/");
}

function isMissingPathError(error) {
  return error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

export function createCliSignalState({ install = true } = {}) {
  const abort = new AbortController();
  let signalName;
  const setInterrupted = (next) => {
    signalName = next;
    abort.abort();
  };
  if (!install) {
    return { signal: abort.signal, signalName: () => signalName, code: () => signalExitCode(signalName), cleanup: () => undefined, interrupt: setInterrupted };
  }
  const onSigint = () => setInterrupted("SIGINT");
  const onSigterm = () => setInterrupted("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  return {
    signal: abort.signal,
    signalName: () => signalName,
    code: () => signalExitCode(signalName),
    cleanup: () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    },
    interrupt: setInterrupted
  };
}

export function defaultLocalTestRunner(invocation, { signal, signalName = () => undefined } = {}) {
  if (signal?.aborted) return Promise.resolve({ status: undefined, signal: signalName() ?? "SIGTERM" });
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: invocation.stdio,
      shell: invocation.shell
    });
    const killChild = () => child.kill(signalName() ?? "SIGTERM");
    signal?.addEventListener("abort", killChild, { once: true });
    child.once("error", (error) => {
      signal?.removeEventListener("abort", killChild);
      rejectResult(error);
    });
    child.once("close", (status, childSignal) => {
      signal?.removeEventListener("abort", killChild);
      resolveResult({ status: status ?? undefined, signal: childSignal ?? undefined });
    });
  });
}

export async function runLocalTests(profile, options = {}) {
  const contract = options.contract ?? rootCommandContract(profile);
  const mode = contract.execution?.mode ?? "ordered-short-circuit";
  const aggregate = mode === "continue-and-aggregate-independent-lanes";
  const cwd = options.cwd ?? repositoryRoot;
  const env = options.env ?? process.env;
  const runner = options.runner ?? defaultLocalTestRunner;
  const reportInspector = options.reportInspector ?? createReportInspector({ cwd });
  const log = options.log ?? ((line) => console.log(line));
  const errorLog = options.error ?? ((line) => console.error(line));
  const signal = options.signal;
  const signalName = options.signalName ?? (() => undefined);
  const signalCode = options.signalCode ?? (() => signalExitCode(signalName()));
  const results = [];
  let interrupted = false;
  let stopped = false;

  for (const step of contract.steps) {
    if (interrupted || stopped || signal?.aborted) {
      interrupted = interrupted || signal?.aborted === true;
      results.push(resultFor(step, "SKIPPED"));
      continue;
    }
    const invocation = commandInvocationForStep(step, { cwd, env });
    const reportSnapshot = await reportInspector.snapshot(step.reportTarget);
    try {
      const raw = await runner(invocation, { step, signal, signalName });
      const mapped = await withChangedReports(resultFromRunnerResult(step, raw, signalName), reportSnapshot, reportInspector);
      results.push(mapped);
      if (mapped.status === "INTERRUPTED") {
        interrupted = true;
      } else if (mapped.status === "FAIL" && !aggregate) {
        stopped = true;
      }
    } catch (caught) {
      results.push(await withChangedReports(resultFor(step, "FAIL", { detail: spawnErrorDetail(caught) }), reportSnapshot, reportInspector));
      if (!aggregate) stopped = true;
    }
  }

  writeSummary({ profile, results, log, errorLog });
  const interruptedResult = results.find((result) => result.status === "INTERRUPTED");
  if (interrupted || interruptedResult) return interruptedResult?.exitCode ?? signalCode();
  return results.some((result) => result.status === "FAIL") ? 1 : 0;
}

function resultFromRunnerResult(step, raw, signalName) {
  if (raw?.signal) return resultFor(step, "INTERRUPTED", { signal: raw.signal, exitCode: signalExitCode(raw.signal) });
  if (raw?.status === 0) return resultFor(step, "PASS");
  const status = typeof raw?.status === "number" ? raw.status : 1;
  if (status === 130 || status === 143) return resultFor(step, "INTERRUPTED", { exitCode: status, signal: signalName() });
  return resultFor(step, "FAIL", { exitCode: status });
}

async function withChangedReports(result, reportSnapshot, reportInspector) {
  if (result.status !== "PASS" && result.status !== "FAIL") return result;
  const reportPaths = await reportInspector.changedReports(reportSnapshot);
  return Object.freeze({ ...result, reportPaths });
}

function resultFor(step, status, extras = {}) {
  return Object.freeze({
    name: step.report ?? step.command,
    status,
    reportTarget: step.reportTarget,
    reportPaths: Object.freeze([]),
    ...extras
  });
}

function writeSummary({ profile, results, log, errorLog }) {
  const writer = results.some((result) => result.status === "FAIL" || result.status === "INTERRUPTED") ? errorLog : log;
  writer(`Local test summary (${profile}):`);
  for (const result of results) {
    const reports = result.reportPaths?.length ? result.reportPaths.map((path) => ` report: ${path}`).join("") : "";
    writer(`- ${result.name}: ${result.status}${reports}`);
  }
}

function spawnErrorDetail(error) {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "command not found";
  return "spawn failed";
}

function signalExitCode(signal) {
  if (signal && signal in SIGNAL_EXIT_CODES) return SIGNAL_EXIT_CODES[signal];
  return 130;
}

export async function invokeLocalTestOrchestrator(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const signalState = options.signalState ?? createCliSignalState({ install: options.installSignalHandlers ?? true });
  try {
    const profile = parseLocalTestOrchestratorArgs(argv);
    return await runLocalTests(profile, { ...options, signal: signalState.signal, signalName: signalState.signalName, signalCode: signalState.code });
  } catch (caught) {
    if (caught instanceof LocalTestUsageError) {
      (options.error ?? ((line) => console.error(line)))(caught.message);
      return 2;
    }
    (options.error ?? ((line) => console.error(line)))(caught instanceof Error ? caught.message : "Local test orchestration failed.");
    return signalState.signal.aborted ? signalState.code() : 1;
  } finally {
    signalState.cleanup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  invokeLocalTestOrchestrator().then((code) => { process.exitCode = code; }, () => { process.exitCode = 1; });
}
