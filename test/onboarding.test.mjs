import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadOpencodeApiKey } from "../scripts/local-env.mjs";
import { writeSecretFile } from "../scripts/setup.mjs";
import { tutorialArguments } from "../scripts/tutorial.mjs";

const directories = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "validation-loops-onboarding-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true }))));
});

describe("tutorial launcher", () => {
  it("forwards engine options after the tutorial workspace target", () => {
    assert.deepEqual(tutorialArguments(["--port", "4310", "--no-open"]), [
      "run", "--workspace=tutorial-engine", "dev", "--", ".", "--port", "4310", "--no-open"
    ]);
  });
});

describe("local OpenCode credentials", () => {
  it("prefers an exported key over the local credential file", async () => {
    const directory = await temporaryDirectory();
    const file = join(directory, "secrets.envrc");
    await writeFile(file, 'export OPENCODE_API_KEY="saved-key"\n');

    assert.equal(await loadOpencodeApiKey(file, { OPENCODE_API_KEY: "shell-key" }), "shell-key");
  });

  it("reads the key produced by setup without evaluating other shell content", async () => {
    const directory = await temporaryDirectory();
    const file = join(directory, "secrets.envrc");
    await writeFile(file, 'export UNRELATED="ignored"\nexport OPENCODE_API_KEY="saved-key"\n');

    assert.equal(await loadOpencodeApiKey(file, {}), "saved-key");
  });

  it("rejects malformed key definitions", async () => {
    const directory = await temporaryDirectory();
    const file = join(directory, "secrets.envrc");
    await writeFile(file, "export OPENCODE_API_KEY=\"unterminated\n");

    await assert.rejects(loadOpencodeApiKey(file, {}), /malformed/);
  });

  it("writes an owner-only, direnv-compatible local secret file", async () => {
    const directory = await temporaryDirectory();
    const file = join(directory, "nested", "secrets.envrc");

    await writeSecretFile(file, "saved-key");

    assert.equal(await readFile(file, "utf8"), 'export OPENCODE_API_KEY="saved-key"\n');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  });
});
