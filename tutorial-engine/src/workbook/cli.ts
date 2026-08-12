#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { browserCommand } from "../browser-open.js";
import { ArgumentError, parseArguments, USAGE } from "../cli-arguments.js";
import { createTutorialLogger, defaultTutorialLogPath } from "../runtime-log.js";
import { startWorkbookServer } from "./server.js";

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.kind === "help") { console.log(USAGE.replace("tutorial-engine", "tutorial-workbook")); return; }
  const log = createTutorialLogger({ filePath: defaultTutorialLogPath().replace("tutorial-engine", "workbook-tutor") });
  const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const server = await startWorkbookServer({ target: parsed.options.target, port: parsed.options.port, host: parsed.options.host, webRoot: resolve(packageDirectory, "dist/web-workbook"), logger: log });
  if (!parsed.options.noOpen) {
    const { command, args } = browserCommand(server.url);
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", () => log.info(`Open ${server.url} in your browser.`));
    child.unref();
  }
  const shutdown = async () => { await server.close(); process.exit(0); };
  process.once("SIGINT", () => void shutdown()); process.once("SIGTERM", () => void shutdown());
}
main().catch((error) => { console.error(error instanceof ArgumentError ? `${error.message}\n${USAGE}` : error); process.exitCode = 1; });
