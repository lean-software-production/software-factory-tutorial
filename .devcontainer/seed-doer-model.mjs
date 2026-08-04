#!/usr/bin/env node
//
// Give the container a default doer model.
//
// The `pi -p` doer the lessons drive takes its model from Pi's saved `/model`
// default, which lives in the state volume rather than this repository — so
// unlike TUTOR_MODEL, the container cannot set it with an environment variable.
// Seed it here instead, on the empty volume a fresh container starts with.
//
// This only ever fills a gap. A participant who has chosen with `/model`, on
// this volume or a rebuild of it, keeps that choice.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stdout } from "node:process";

const PROVIDER = "opencode";
const MODEL = "big-pickle";

const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir) {
  stdout.write("PI_CODING_AGENT_DIR is unset; leaving the doer model to Pi.\n");
  process.exit(0);
}

const settingsPath = join(agentDir, "settings.json");
let settings = {};
try {
  settings = JSON.parse(readFileSync(settingsPath, "utf8"));
} catch (error) {
  // A missing file is the fresh-volume case this script exists for. Anything
  // else is the participant's file: report it and change nothing, because a
  // container that cannot start is worse than one that picks its own model.
  if (error.code !== "ENOENT") {
    stdout.write(`Leaving ${settingsPath} alone (${error.message}).\n`);
    process.exit(0);
  }
}

if (settings.defaultProvider && settings.defaultModel) {
  stdout.write(`Doer model already set to ${settings.defaultProvider}/${settings.defaultModel}; leaving it.\n`);
  process.exit(0);
}

writeFileSync(settingsPath, `${JSON.stringify({ ...settings, defaultProvider: PROVIDER, defaultModel: MODEL }, null, 2)}\n`, "utf8");
stdout.write(`Doer model defaulted to ${PROVIDER}/${MODEL}. Change it with 'pi', then '/model'.\n`);
