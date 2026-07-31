import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSupportedNodeVersion, requireOpencodeApiKey } from "./local-env.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const secretFile = resolve(repositoryRoot, ".local/secrets.envrc");

export async function runWithTutorialEnvironment(command, args) {
  assertSupportedNodeVersion();
  const key = await requireOpencodeApiKey(secretFile);
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    env: { ...process.env, OPENCODE_API_KEY: key },
    stdio: "inherit"
  });
  return new Promise((resolvePromise, reject) => {
    child.once("error", (error) => reject(error));
    child.once("exit", (code, signal) => {
      if (signal) resolvePromise(1);
      else resolvePromise(code ?? 1);
    });
  });
}

export const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
