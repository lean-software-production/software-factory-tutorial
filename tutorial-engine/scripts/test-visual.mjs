#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

export const CANONICAL_DEVCONTAINER_ENV = "SOFTWARE_FACTORY_TUTORIAL_DEVCONTAINER";
export const CANONICAL_PI_AGENT_DIR = "/home/vscode/.tutorial-state/pi-agent";

export function repositoryRoot(scriptDirectory = dirname(fileURLToPath(import.meta.url))) {
  return resolve(scriptDirectory, "../..");
}

export function devcontainerState({
  platform = process.platform,
  env = process.env,
  dockerMarkerExists = existsSync("/.dockerenv"),
  otherContainerMarkerExists = existsSync("/run/.containerenv") || Boolean(env.container || env.CONTAINER),
} = {}) {
  const inContainer = platform === "linux" && (dockerMarkerExists || otherContainerMarkerExists);
  const canonical = platform === "linux"
    && dockerMarkerExists
    && env[CANONICAL_DEVCONTAINER_ENV] === "1"
    && env.PI_CODING_AGENT_DIR === CANONICAL_PI_AGENT_DIR;
  return { inContainer, canonical };
}

export function assertNoVisualArgs(args) {
  if (args.length > 0) throw new Error("test:visual does not accept arguments; approval is separate and deliberate.");
}

export function visualTestPlan({ repositoryRoot, state = devcontainerState() }) {
  if (state.canonical) {
    return {
      kind: "direct",
      commands: [
        { command: "npm", args: ["run", "--workspace=tutorial-engine", "build:web:workbook"] },
        { command: "npm", args: ["exec", "--workspace=tutorial-engine", "--", "tsx", "test/visual-affordances.mts"] },
      ],
    };
  }
  if (state.inContainer) {
    return {
      kind: "refuse",
      message: "Refusing to run visual validation inside a noncanonical container.",
      commands: [],
    };
  }
  return {
    kind: "devcontainer",
    commands: [
      { command: "devcontainer", args: ["up", "--workspace-folder", repositoryRoot] },
      {
        command: "devcontainer",
        args: [
          "exec",
          "--workspace-folder",
          repositoryRoot,
          "npm",
          "run",
          "--workspace=tutorial-engine",
          "test:visual",
        ],
      },
    ],
  };
}

function run(command, cwd) {
  const result = spawnSync(command.command, command.args, { cwd, stdio: "inherit", shell: false });
  if (result.error) {
    const detail = result.error.code === "ENOENT" ? `${command.command} was not found` : result.error.message;
    throw new Error(`Cannot run visual validation: ${detail}.`);
  }
  if (typeof result.status === "number") return result.status;
  throw new Error(`Visual validation stopped after signal ${result.signal}.`);
}

export function runVisualTest({ args = process.argv.slice(2), root = repositoryRoot(), state = devcontainerState() } = {}) {
  assertNoVisualArgs(args);
  const plan = visualTestPlan({ repositoryRoot: root, state });
  if (plan.kind === "refuse") throw new Error(plan.message);
  for (const command of plan.commands) {
    const status = run(command, root);
    if (status !== 0) return status;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = runVisualTest();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
