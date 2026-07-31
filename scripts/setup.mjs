#!/usr/bin/env node
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { stderr, stdout } from "node:process";

export async function checkPiAuthentication(getAvailable) {
  const models = await getAvailable();
  return { ready: models.length > 0 };
}

async function main() {
  const runtime = await ModelRuntime.create();
  const result = await checkPiAuthentication(() => runtime.getAvailable());
  if (result.ready) {
    stdout.write("Pi is authenticated and ready for the tutorial.\n");
    return;
  }
  stderr.write("Pi has no authenticated model. Run 'npx pi', then enter '/login' and choose a provider.\n");
  process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error) => {
    stderr.write(`Unable to check Pi authentication: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
