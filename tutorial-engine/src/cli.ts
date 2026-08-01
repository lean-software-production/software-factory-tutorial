#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadLesson } from "./lesson/load.js";
import { createTutorialLogger } from "./runtime-log.js";
import { startLocalServer } from "./server/local-server.js";

function usage(): never {
  console.error("Usage: tutorial-engine <tutorial-directory> [--port 4310] [--no-open]");
  process.exit(1);
}

async function main(): Promise<void> {
  const log = createTutorialLogger();
  const args = process.argv.slice(2);
  const target = args.find((arg) => !arg.startsWith("-"));
  if (!target) usage();
  const portIndex = args.indexOf("--port");
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) usage();
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
    logger: log
  });
  log.info(`Listening only on ${server.url}.`);
  if (noOpen) log.info("Browser launch disabled by --no-open.");
  else {
    log.info("Opening the tutorial in your default browser.");
    spawn(process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open", process.platform === "win32" ? ["/c", "start", server.url] : [server.url], { detached: true, stdio: "ignore" }).unref();
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
