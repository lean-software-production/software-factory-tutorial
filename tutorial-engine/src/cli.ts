#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadLesson } from "./lesson/load.js";
import { createTutorialLogger, defaultTutorialLogPath } from "./runtime-log.js";
import { LOOPBACK_HOST, startLocalServer } from "./server/local-server.js";

function usage(): never {
  console.error("Usage: tutorial-engine <tutorial-directory> [--port 4310] [--host 0.0.0.0] [--no-open]");
  process.exit(1);
}

async function main(): Promise<void> {
  const log = createTutorialLogger({ filePath: defaultTutorialLogPath() });
  log.info(`Writing diagnostics to ${log.filePath}.`);
  const args = process.argv.slice(2);
  const target = args.find((arg) => !arg.startsWith("-"));
  if (!target) usage();
  const portIndex = args.indexOf("--port");
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) usage();
  const hostIndex = args.indexOf("--host");
  const host = hostIndex >= 0 ? args[hostIndex + 1] : undefined;
  if (hostIndex >= 0 && (!host || host.startsWith("-"))) usage();
  const noOpen = args.includes("--no-open");

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
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const child = spawn(opener, process.platform === "win32" ? ["/c", "start", server.url] : [server.url], { detached: true, stdio: "ignore" });
    // A machine without a browser opener is common on servers; keep serving and say so.
    child.once("error", (error: NodeJS.ErrnoException) => {
      log.info(`Could not open a browser automatically (${opener}: ${error.code ?? error.message}). Open ${server.url} yourself.`);
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
  createTutorialLogger().error("Tutorial server could not start", error);
  process.exitCode = 1;
});
