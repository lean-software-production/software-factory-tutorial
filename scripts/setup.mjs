#!/usr/bin/env node
import { access, chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { assertSupportedNodeVersion } from "./local-env.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const secretFile = resolve(repositoryRoot, ".local/secrets.envrc");

export async function writeSecretFile(file, key) {
  const directory = dirname(file);
  const temporaryFile = resolve(directory, `.secrets.${process.pid}.${Date.now()}.tmp`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(temporaryFile, `export OPENCODE_API_KEY=${JSON.stringify(key)}\n`, { mode: 0o600 });
  await chmod(temporaryFile, 0o600);
  await rename(temporaryFile, file);
  await chmod(file, 0o600);
}

function askSecret(question) {
  return new Promise((resolvePromise, reject) => {
    let value = "";
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = (error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdout.write("\n");
      if (error) reject(error);
      else resolvePromise(value);
    };
    const onData = (input) => {
      for (const character of input) {
        if (character === "\u0003") return done(new Error("Setup cancelled."));
        if (character === "\r" || character === "\n") return done();
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") value += character;
      }
    };
    stdin.on("data", onData);
  });
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  assertSupportedNodeVersion();
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("Setup needs an interactive terminal. Export OPENCODE_API_KEY instead for non-interactive use.");

  if (await fileExists(secretFile)) {
    const prompt = createInterface({ input: stdin, output: stdout });
    const answer = await prompt.question(`${secretFile} already exists. Replace it? [y/N] `);
    prompt.close();
    if (!/^y(?:es)?$/i.test(answer.trim())) {
      stdout.write("Setup unchanged.\n");
      return;
    }
  }

  const key = await askSecret("OpenCode API key: ");
  if (!key.trim()) throw new Error("OPENCODE_API_KEY cannot be empty.");
  await writeSecretFile(secretFile, key);
  stdout.write(`Saved OPENCODE_API_KEY to ${secretFile}.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
