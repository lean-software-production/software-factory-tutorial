#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { browserCommand } from "./browser-open.js";
import { ArgumentError, parseArguments, USAGE } from "./cli-arguments.js";
import { resetFactoryArtifacts } from "./lesson/factory-artifacts.js";
import { loadLesson } from "./lesson/load.js";
import { createTutorialLogger, defaultTutorialLogPath } from "./runtime-log.js";
import { LOOPBACK_HOST, startLocalServer } from "./server/local-server.js";

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.kind === "help") {
    console.log(USAGE);
    return;
  }
  const { target, port, host, noOpen } = parsed.options;
  const log = createTutorialLogger({ filePath: defaultTutorialLogPath() });
  log.info(`Writing diagnostics to ${log.filePath}.`);

  log.info(`Starting tutorial server for ${resolve(target)}.`);
  log.info("Loading tutorial definition and progress.");
  const loaded = await loadLesson(target);
  log.info(`Loaded “${loaded.definition.title}” from ${loaded.workspace}.`);
  const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const server = await startLocalServer({
    lesson: loaded.definition,
    workspace: loaded.workspace,
    webRoot: resolve(packageDirectory, "dist/web"),
    progress: loaded.progress,
    resetLearnerArtifacts: () => resetFactoryArtifacts(loaded.workspace),
    port,
    host,
    logger: log
  });
  log.info(server.host === LOOPBACK_HOST
    ? `Listening only on ${server.url}.`
    : `Listening on ${server.url} — reachable from other machines on ${server.host}:${server.port}.`);
  if (noOpen) log.info("Browser launch disabled by --no-open.");
  else {
    log.info("Opening the tutorial in your default browser.");
    const { command, args } = browserCommand(server.url);
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    // A machine without a browser opener is common on servers; keep serving and say so.
    child.once("error", (error: NodeJS.ErrnoException) => {
      log.info(`Could not open a browser automatically (${command}: ${error.code ?? error.message}). Open ${server.url} yourself.`);
    });
    child.unref();
  }
  const shutdown = async (signal: string) => {
    log.info(`Received ${signal}; stopping tutorial server.`);
    await server.close();
    log.info("Tutorial server stopped.");
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  if (error instanceof ArgumentError) {
    console.error(`${error.message}\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  createTutorialLogger().error("Tutorial server could not start", error);
  process.exitCode = 1;
});
