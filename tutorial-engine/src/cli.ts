#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadLesson } from "./lesson/load.js";
import { startLocalServer } from "./server/local-server.js";

function usage(): never {
  console.error("Usage: tutorial-engine <tutorial-directory> [--port 4310] [--no-open]");
  process.exit(1);
}

const args = process.argv.slice(2);
const target = args.find((arg) => !arg.startsWith("-"));
if (!target) usage();
const portIndex = args.indexOf("--port");
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : undefined;
if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) usage();
const noOpen = args.includes("--no-open");

const loaded = await loadLesson(target);
const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const server = await startLocalServer({ lesson: loaded.definition, workspace: loaded.workspace, webRoot: resolve(packageDirectory, "dist/web"), progress: loaded.progress, port });
console.log(`Tutorial: ${loaded.definition.title}`);
console.log(`Listening only on ${server.url}`);
if (!noOpen) spawn(process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open", process.platform === "win32" ? ["/c", "start", server.url] : [server.url], { detached: true, stdio: "ignore" }).unref();

const shutdown = async () => { await server.close(); process.exit(0); };
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
