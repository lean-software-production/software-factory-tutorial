#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { browserCommand } from "./browser-open.js";
import { ArgumentError, parseArguments, USAGE } from "./cli-arguments.js";
import { createTutorialLogger, defaultTutorialLogPath, type TutorialLogger } from "./runtime-log.js";
import { SessionWorkspaceError, SessionWorkspaceManager, type TutorialSessionPaths } from "../session-workspace.js";
import { startWorkbookServer, type StartedWorkbookServer, type WorkbookServerOptions } from "./server.js";
import { trustRuntimeProvision, type RuntimeProvisionProfile, type TrustedRuntimeProvision } from "./runtime-provision.js";
import { initializeLessonJump, LessonJumpError, loadAndResolveLessonJump } from "./lesson-jump.js";
import { WorkbookModelPreflightError, preflightWorkbookModels, type WorkbookModelPreflightOptions } from "./model-preflight.js";

type BrowserCommand = (url: string) => { command: string; args: string[] };
type BrowserSpawner = typeof spawn;
type SignalInstaller = Pick<NodeJS.Process, "once">;
type WorkbookModelPreflight = (options: WorkbookModelPreflightOptions) => Promise<unknown>;

export interface WorkbookCliDependencies {
  startServer?: (options: WorkbookServerOptions) => Promise<StartedWorkbookServer>;
  resolveSession?: (target: string, sessionId?: string, runtimeProvision?: TrustedRuntimeProvision) => Promise<TutorialSessionPaths>;
  createLessonJumpSession?: (target: string, lesson: string, runtimeProvision?: TrustedRuntimeProvision) => Promise<TutorialSessionPaths>;
  browserCommand?: BrowserCommand;
  spawnBrowser?: BrowserSpawner;
  packageDirectory?: string;
  runtimeProvision?: RuntimeProvisionProfile;
  logger?: TutorialLogger;
  preflightModels?: WorkbookModelPreflight;
  writeLine?: (message: string) => void;
  signalTarget?: SignalInstaller;
  installSignalHandlers?: boolean;
  exit?: (code?: number) => never | void;
}

async function resolveWorkbookSession(target: string, sessionId?: string, runtimeProvision?: TrustedRuntimeProvision): Promise<TutorialSessionPaths> {
  const manager = await SessionWorkspaceManager.create(target);
  if (!sessionId) return manager.createSession(runtimeProvision ? { runtimeProvision } : undefined);
  const paths = await manager.reopenSession(sessionId);
  return runtimeProvision && runtimeProvision.workspaceMountTargets.length ? { ...paths, runtimeProvision } : paths;
}

async function createLessonJumpSession(target: string, selector: string, runtimeProvision?: TrustedRuntimeProvision): Promise<TutorialSessionPaths> {
  const manager = await SessionWorkspaceManager.create(target);
  const jump = await loadAndResolveLessonJump(manager.contentRoot, selector);
  const session = await manager.createSession(runtimeProvision ? { runtimeProvision } : undefined);
  try { await initializeLessonJump(session.sessionRoot, jump.loaded, jump.target); }
  catch (error) {
    // A partially initialized jump must never look reopenable as an ordinary learner session.
    const { rm } = await import("node:fs/promises");
    await rm(session.sessionRoot, { recursive: true, force: true });
    throw error;
  }
  return session;
}

function sessionLaunchLines(session: TutorialSessionPaths, reopened: boolean, lesson?: string): string[] {
  const action = reopened ? "Reopened workbook session" : "Created workbook session";
  return [
    `${action}: ${session.sessionId}`,
    ...(lesson ? [`Lesson jump: ${lesson} (prior blocks are marked completed).`] : []),
    `Session state: ${session.sessionRoot}`,
    `Learner workspaces: ${Object.entries(session.workspaceRoots).map(([id, root]) => `${id}=${root}`).join(", ") || "none declared"}`,
    `Reopen with the same workbook target and --session ${session.sessionId}`,
  ];
}

export async function runWorkbookCli(argv: readonly string[], dependencies: WorkbookCliDependencies = {}): Promise<StartedWorkbookServer | undefined> {
  const parsed = parseArguments(argv);
  const writeLine = dependencies.writeLine ?? console.log;
  if (parsed.kind === "help") { writeLine(USAGE.replace("tutorial-engine", "tutorial-workbook")); return undefined; }
  const log = dependencies.logger ?? createTutorialLogger({ filePath: defaultTutorialLogPath().replace("tutorial-engine", "workbook-tutor") });
  const packageDirectory = dependencies.packageDirectory ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const startServer = dependencies.startServer ?? startWorkbookServer;
  const runtimeProvision = dependencies.runtimeProvision ? trustRuntimeProvision(dependencies.runtimeProvision) : undefined;
  const resolveSession = dependencies.resolveSession ?? resolveWorkbookSession;
  const createJump = dependencies.createLessonJumpSession ?? createLessonJumpSession;
  const session = parsed.options.lesson
    ? (runtimeProvision ? await createJump(parsed.options.target, parsed.options.lesson, runtimeProvision) : await createJump(parsed.options.target, parsed.options.lesson))
    : (runtimeProvision ? await resolveSession(parsed.options.target, parsed.options.session, runtimeProvision) : await resolveSession(parsed.options.target, parsed.options.session));
  const preflightModels = dependencies.preflightModels ?? preflightWorkbookModels;
  await preflightModels({ contentRoot: session.contentRoot, workspaceRoot: session.sessionRoot, logger: log });
  for (const line of sessionLaunchLines(session, parsed.options.session !== undefined, parsed.options.lesson)) writeLine(line);
  const server = await startServer({ target: session.contentRoot, session, port: parsed.options.port, host: parsed.options.host, webRoot: resolve(packageDirectory, "dist/web-workbook"), logger: log, embeddedTerminal: true, watchContent: parsed.options.watch });
  if (!parsed.options.noOpen) {
    const open = dependencies.browserCommand ?? browserCommand;
    const spawnProcess = dependencies.spawnBrowser ?? spawn;
    const { command, args } = open(server.url);
    const child = spawnProcess(command, args, { detached: true, stdio: "ignore" });
    child.once("error", () => log.info(`Open ${server.url} in your browser.`));
    child.unref();
  }
  if (dependencies.installSignalHandlers !== false) {
    const exit = dependencies.exit ?? process.exit;
    const shutdown = async () => { await server.close(); exit(0); };
    const signals = dependencies.signalTarget ?? process;
    signals.once("SIGINT", () => void shutdown()); signals.once("SIGTERM", () => void shutdown());
  }
  return server;
}

async function main(): Promise<void> { await runWorkbookCli(process.argv.slice(2)); }

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath && resolve(fileURLToPath(import.meta.url)) === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof ArgumentError || error instanceof SessionWorkspaceError || error instanceof LessonJumpError ? `${error.message}\n${USAGE.replace("tutorial-engine", "tutorial-workbook")}` : error instanceof WorkbookModelPreflightError ? error.message : error);
    process.exitCode = 1;
  });
}
