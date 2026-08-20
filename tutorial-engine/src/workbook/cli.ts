#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { browserCommand } from "../browser-open.js";
import { ArgumentError, parseArguments, USAGE } from "../cli-arguments.js";
import { createTutorialLogger, defaultTutorialLogPath, type TutorialLogger } from "../runtime-log.js";
import { startWorkbookServer, type StartedWorkbookServer, type WorkbookServerOptions } from "./server.js";

type BrowserCommand = (url: string) => { command: string; args: string[] };
type BrowserSpawner = typeof spawn;
type SignalInstaller = Pick<NodeJS.Process, "once">;

export interface WorkbookCliDependencies {
  startServer?: (options: WorkbookServerOptions) => Promise<StartedWorkbookServer>;
  browserCommand?: BrowserCommand;
  spawnBrowser?: BrowserSpawner;
  packageDirectory?: string;
  logger?: TutorialLogger;
  writeLine?: (message: string) => void;
  signalTarget?: SignalInstaller;
  installSignalHandlers?: boolean;
  exit?: (code?: number) => never | void;
}

export async function runWorkbookCli(argv: readonly string[], dependencies: WorkbookCliDependencies = {}): Promise<StartedWorkbookServer | undefined> {
  const parsed = parseArguments(argv);
  if (parsed.kind === "help") { (dependencies.writeLine ?? console.log)(USAGE.replace("tutorial-engine", "tutorial-workbook")); return undefined; }
  const log = dependencies.logger ?? createTutorialLogger({ filePath: defaultTutorialLogPath().replace("tutorial-engine", "workbook-tutor") });
  const packageDirectory = dependencies.packageDirectory ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const startServer = dependencies.startServer ?? startWorkbookServer;
  const server = await startServer({ target: parsed.options.target, port: parsed.options.port, host: parsed.options.host, webRoot: resolve(packageDirectory, "dist/web-workbook"), logger: log, embeddedTerminal: true });
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
  main().catch((error) => { console.error(error instanceof ArgumentError ? `${error.message}\n${USAGE}` : error); process.exitCode = 1; });
}
