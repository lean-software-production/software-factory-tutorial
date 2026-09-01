import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPiAuthentication, describeDoerModel, describeTutorModel, modelReport } from "../scripts/setup.mjs";
import { trustedNodeRuntimeProvision, tutorialWorkbookArguments } from "../scripts/tutorial-workbook.mjs";
import {
  LOCAL_TEST_COMMAND_CONTRACT,
  packageScriptWiringReport,
  rootCommandContract,
  rootCommandNames,
  rootTestReleaseReports,
  validatePackageScriptWiring,
  workspaceDelegationCommand
} from "../scripts/local-test-command-contract.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tutorialRoot = resolve(repositoryRoot, "tutorial");

async function readPackageManifest() {
  return JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
}

async function readEnginePackageManifest() {
  return JSON.parse(await readFile(resolve(repositoryRoot, "tutorial-engine/package.json"), "utf8"));
}

async function readDevcontainerConfigSource() {
  return readFile(resolve(repositoryRoot, ".devcontainer/devcontainer.json"), "utf8");
}

const workspaceDependencyDirectories = [
  "node_modules",
  "tutorial-engine/node_modules",
  "tutorial/workspaces/refactor-line/calculator/node_modules"
];

const dependencyVolumeMounts = [
  { volume: "node_modules", target: "node_modules" },
  { volume: "tutorial-engine-node_modules", target: "tutorial-engine/node_modules" },
  {
    volume: "tutorial-refactor-line-calculator-node_modules",
    target: "tutorial/workspaces/refactor-line/calculator/node_modules"
  }
];

describe("tutorial launcher", () => {
  it("starts the workbook from npm start and keeps onboarding tests broad enough for root orchestration", async () => {
    const manifest = await readPackageManifest();
    assert.equal(manifest.scripts.start, "npm run tutorial:workbook");
    assert.equal(manifest.scripts["test:onboarding"], "node --test test/*.test.mjs");
  });

  it("keeps the calculator workspace under the tutorial workspace", async () => {
    const manifest = await readPackageManifest();
    assert.deepEqual(manifest.workspaces, ["tutorial/workspaces/refactor-line/calculator", "tutorial-engine"]);
  });

  it("launches the workbook with a trusted root node_modules runtime profile", () => {
    assert.deepEqual(tutorialWorkbookArguments(["--port", "4310", "--no-open"]), [
      tutorialRoot, "--port", "4310", "--no-open"
    ]);
    assert.deepEqual(trustedNodeRuntimeProvision(repositoryRoot), {
      mounts: [
        { source: resolve(repositoryRoot, "node_modules"), target: "node_modules", readonly: true }
      ]
    });
  });
});

describe("devcontainer dependency isolation", () => {
  it("masks every npm dependency directory with per-devcontainer Linux volumes", async () => {
    const manifest = await readPackageManifest();
    const configSource = await readDevcontainerConfigSource();
    assert.deepEqual(workspaceDependencyDirectories, [
      "node_modules",
      ...manifest.workspaces.map((workspace) => `${workspace}/node_modules`).sort()
    ]);

    assert.match(configSource, /"SOFTWARE_FACTORY_TUTORIAL_DEVCONTAINER"\s*:\s*"1"/);

    for (const { volume, target } of dependencyVolumeMounts) {
      assert.match(
        configSource,
        new RegExp(`"source=\\$\\{devcontainerId\\}-${volume},target=\\$\\{containerWorkspaceFolder\\}/${target},type=volume"`)
      );
    }
    assert.doesNotMatch(configSource, /\/workspaces\/software-factory-tutorial\/.*node_modules/);
  });

  it("makes mounted dependency volumes writable before installing from the lockfile", async () => {
    const postCreate = await readFile(resolve(repositoryRoot, ".devcontainer/post-create.sh"), "utf8");

    for (const dependencyDirectory of workspaceDependencyDirectories) {
      assert.match(postCreate, new RegExp(`^  ${dependencyDirectory}$`, "m"));
    }
    assert.match(postCreate, /sudo chown -R "\$\(id -u\):\$\(id -g\)" "\$\{dependency_directory\}"/);
    assert.ok(postCreate.indexOf("sudo chown") < postCreate.indexOf("npm ci --include=optional"));
    assert.match(postCreate, /npm ci --include=optional/);
    assert.doesNotMatch(postCreate, /^npm install(?:\s|$)/m);
  });
});

describe("local test command contract", () => {
  it("defines the exact root command matrix consumed by package-script wiring and the orchestrator", () => {
    const expected = [
      "test",
      "test:fast",
      "test:engine",
      "test:engine:fast",
      "test:workbook",
      "test:workbook:fast",
      "eval:engine",
      "eval:workbook"
    ];

    assert.deepEqual(rootCommandNames(), expected);
    assert.deepEqual(Object.keys(LOCAL_TEST_COMMAND_CONTRACT.rootCommands), expected);
  });

  it("keeps the fast loop deterministic, model-free, Docker-free, and complete", () => {
    const command = rootCommandContract("test:fast");

    assert.equal(command.deterministic, true);
    assert.equal(command.modelFree, true);
    assert.equal(command.spendsTokens, false);
    assert.equal(command.requiresDocker, false);
    assert.equal(command.requiresCanonicalDevcontainer, false);
    assert.deepEqual(command.steps.map((step) => step.command), ["test:engine:fast", "test:workbook:fast"]);

    for (const fastCommandName of ["test:fast", "test:engine:fast", "test:workbook:fast"]) {
      assert.equal(rootCommandContract(fastCommandName).requiresDocker, false, `${fastCommandName} should stay Docker-free`);
      assert.equal(rootCommandContract(fastCommandName).requiresCanonicalDevcontainer, false, `${fastCommandName} should stay devcontainer-free`);
    }
  });

  it("spells out all deterministic authored-workbook and evaluator foundations", () => {
    const command = rootCommandContract("test:workbook:fast");

    assert.equal(command.deterministic, true);
    assert.equal(command.modelFree, true);
    assert.equal(command.spendsTokens, false);
    assert.equal(command.requiresDocker, false);
    assert.deepEqual(
      command.steps.map((step) => ({ command: step.command, workspace: step.workspace, shell: step.shell })),
      [
        { command: "test:onboarding", workspace: undefined, shell: "npm run test:onboarding" },
        { command: "check:eval:workbook", workspace: undefined, shell: "npm run check:eval:workbook" },
        { command: "test:eval:workbook", workspace: undefined, shell: "npm run test:eval:workbook" },
        { command: "check:workbook", workspace: "tutorial-engine", shell: "npm run --workspace=tutorial-engine check:workbook" },
        {
          command: "calculator:test",
          workspace: "tutorial/workspaces/refactor-line/calculator",
          shell: "npm run --workspace=tutorial/workspaces/refactor-line/calculator test"
        }
      ]
    );
    assert.ok(command.steps.find((step) => step.command === "check:eval:workbook"));
    assert.ok(command.steps.findIndex((step) => step.command === "check:eval:workbook") < command.steps.findIndex((step) => step.command === "test:eval:workbook"));
  });

  it("delegates every root engine command through the tutorial-engine workspace", () => {
    assert.equal(workspaceDelegationCommand("test:engine:fast"), "npm run --workspace=tutorial-engine test:fast --");
    assert.equal(workspaceDelegationCommand("eval:engine"), "npm run --workspace=tutorial-engine eval --");

    for (const commandName of ["test:engine", "test:engine:fast", "eval:engine"]) {
      const command = rootCommandContract(commandName);
      assert.ok(command.steps.length > 0, `${commandName} should have engine workspace steps`);
      for (const step of command.steps) {
        assert.equal(step.workspace, "tutorial-engine");
        assert.match(step.shell, /npm run --workspace=tutorial-engine /);
      }
    }
  });

  it("makes full npm test an aggregate release gate with independent visual and live eval reports", () => {
    const command = rootCommandContract("test");

    assert.equal(command.deterministic, false);
    assert.equal(command.modelFree, false);
    assert.equal(command.spendsTokens, true);
    assert.equal(command.requiresDocker, true);
    assert.equal(command.requiresCanonicalDevcontainer, true);
    assert.deepEqual(command.execution, {
      mode: "continue-and-aggregate-independent-lanes",
      plainAndChainSafe: false,
      reports: ["deterministic-fast", "canonical-visual", "live-engine-eval", "authored-workbook-eval"]
    });
    assert.deepEqual(rootTestReleaseReports(), ["deterministic-fast", "canonical-visual", "live-engine-eval", "authored-workbook-eval"]);
    assert.deepEqual(
      command.steps.map((step) => ({ command: step.command, shell: step.shell, report: step.report, reportTarget: step.reportTarget })),
      [
        { command: "test:fast", shell: "npm run test:fast", report: "deterministic-fast", reportTarget: undefined },
        {
          command: "test:visual",
          shell: "npm run --workspace=tutorial-engine test:visual",
          report: "canonical-visual",
          reportTarget: "tutorial-engine/test/visual/*.received.png"
        },
        { command: "eval:engine", shell: "npm run eval:engine -- --release", report: "live-engine-eval", reportTarget: "tutorial-engine/evals/reports/latest.json" },
        { command: "eval:workbook", shell: "npm run eval:workbook -- --release", report: "authored-workbook-eval", reportTarget: "evals/workbook/reports/latest.json" }
      ]
    );
  });

  it("keeps canonical devcontainer requirements separate from generic Docker", () => {
    assert.equal(rootCommandContract("test").requiresCanonicalDevcontainer, true);
    assert.equal(rootCommandContract("test:engine").requiresCanonicalDevcontainer, true);

    for (const commandName of ["test:workbook", "eval:engine", "eval:workbook"]) {
      const command = rootCommandContract(commandName);
      assert.equal(command.requiresDocker, true, `${commandName} needs Docker`);
      assert.equal(command.requiresCanonicalDevcontainer, false, `${commandName} must not require the visual devcontainer`);
    }

    for (const commandName of ["test", "test:engine"]) {
      const visualSteps = rootCommandContract(commandName).steps.filter((step) => step.visual);
      assert.equal(visualSteps.length, 1);
      assert.equal(visualSteps[0].requiresDocker, true);
      assert.equal(visualSteps[0].requiresCanonicalDevcontainer, true);
      assert.equal(visualSteps[0].report, "canonical-visual");
    }
  });

  it("identifies token-spending and Docker-requiring root commands explicitly", () => {
    const tokenSpenders = Object.values(LOCAL_TEST_COMMAND_CONTRACT.rootCommands)
      .filter((command) => command.spendsTokens)
      .map((command) => command.name);
    const dockerUsers = Object.values(LOCAL_TEST_COMMAND_CONTRACT.rootCommands)
      .filter((command) => command.requiresDocker)
      .map((command) => command.name);

    assert.deepEqual(tokenSpenders, ["test", "test:engine", "test:workbook", "eval:engine", "eval:workbook"]);
    assert.deepEqual(dockerUsers, tokenSpenders);

    for (const commandName of tokenSpenders) {
      const notes = rootCommandContract(commandName).notes.join("\n");
      assert.match(notes, /Main Tutor/);
      assert.match(notes, /Judge/);
    }
  });

  it("models eval:workbook as a wired direct module command, not a recursive package alias", () => {
    const command = rootCommandContract("eval:workbook");

    assert.equal(command.packageScript.status, "wired");
    assert.equal(command.packageScript.command, "tsx evals/workbook/run.ts");
    assert.deepEqual(
      command.steps.map((step) => ({ implementation: step.implementation, module: step.module, shell: step.shell, forwardsArguments: step.forwardsArguments })),
      [{ implementation: "root-module-command", module: "evals/workbook/run.ts", shell: "tsx evals/workbook/run.ts", forwardsArguments: true }]
    );
    assert.doesNotMatch(command.steps[0].shell, /npm run eval:workbook/);
  });

  it("records all planned package-script entries as wired to the exact local commands", async () => {
    const root = await readPackageManifest();
    const engine = await readEnginePackageManifest();
    const validation = validatePackageScriptWiring({ root, engine });

    assert.equal(validation.ok, true);
    assert.deepEqual(validation.failures, []);

    const report = packageScriptWiringReport({ root, engine });
    assert.deepEqual(report.filter((entry) => entry.status !== "wired"), []);
    const evalEngine = report.find((entry) => entry.packageName === "root" && entry.script === "eval:engine");
    assert.deepEqual(evalEngine, {
      packageName: "root",
      workspace: undefined,
      script: "eval:engine",
      status: "wired",
      expectedCommand: "npm run --workspace=tutorial-engine eval --",
      actual: "npm run --workspace=tutorial-engine eval --",
      present: true,
      matchesExpectedCommand: true,
      aligned: true
    });

    for (const [script, command] of [
      ["check:eval:workbook", "tsc -p evals/workbook/tsconfig.json"],
      ["test:eval:workbook", "vitest run evals/workbook/test/*.test.ts"]
    ]) {
      const entry = report.find((candidate) => candidate.packageName === "root" && candidate.script === script);
      assert.equal(entry.status, "wired");
      assert.equal(entry.expectedCommand, command);
      assert.equal(entry.actual, command);
      assert.equal(entry.aligned, true);
    }

    for (const [script, command] of [
      ["test", "node scripts/run-local-tests.mjs test"],
      ["test:fast", "node scripts/run-local-tests.mjs test:fast"],
      ["test:engine", "node scripts/run-local-tests.mjs test:engine"],
      ["test:engine:fast", "npm run --workspace=tutorial-engine test:fast --"],
      ["test:workbook", "node scripts/run-local-tests.mjs test:workbook"],
      ["test:workbook:fast", "node scripts/run-local-tests.mjs test:workbook:fast"]
    ]) {
      const entry = report.find((candidate) => candidate.packageName === "root" && candidate.script === script);
      assert.equal(entry.status, "wired", `${script} should be wired`);
      assert.equal(entry.expectedCommand, command);
      assert.equal(entry.actual, command);
      assert.equal(entry.aligned, true);
    }

    const evalWorkbook = report.find((entry) => entry.packageName === "root" && entry.script === "eval:workbook");
    assert.equal(evalWorkbook.status, "wired");
    assert.equal(evalWorkbook.expectedCommand, "tsx evals/workbook/run.ts");
    assert.equal(evalWorkbook.actual, "tsx evals/workbook/run.ts");
    assert.equal(evalWorkbook.aligned, true);

    for (const [script, command] of [
      ["build:typescript", "rm -rf dist && tsc -p tsconfig.json"],
      ["build", "npm run build:typescript && npm run build:web:workbook"],
      ["test:fast", "npm run lint && tsc -p tsconfig.check.json && npm run check:eval && npm run test && npm run build:web:workbook && npm run browser:smoke"],
      ["check", "npm run build:typescript && npm run test:fast && npm run check:workbook-terminal-image"],
      ["prepublishOnly", "npm run check"]
    ]) {
      const entry = report.find((candidate) => candidate.packageName === "tutorial-engine" && candidate.script === script);
      assert.equal(entry.status, "wired", `tutorial-engine ${script} should be wired`);
      assert.equal(entry.expectedCommand, command);
      assert.equal(entry.actual, command);
      assert.equal(entry.aligned, true);
    }
  });

  it("preserves npm run check as a compatibility command for the deterministic fast loop", () => {
    assert.deepEqual(LOCAL_TEST_COMMAND_CONTRACT.compatibility.check, {
      command: "check",
      delegatesTo: "test:fast",
      policy: "compatibility-alias",
      deterministic: true,
      modelFree: true,
      spendsTokens: false,
      requiresDocker: false,
      requiresCanonicalDevcontainer: false,
      notes: [
        "Keep npm run check supported for existing docs and developer muscle memory.",
        "Do not add eval:engine, eval:workbook, tutor, or judge calls to npm run check.",
        "package.json makes check a direct alias of test:fast."
      ]
    });
  });
});

describe("Pi preflight", () => {
  it("reports ready when Pi has an authenticated model", async () => {
    const result = await checkPiAuthentication(async () => [{ provider: "anthropic", id: "claude" }]);
    assert.deepEqual(result, { ready: true });
  });

  it("reports setup guidance when Pi has no authenticated models", async () => {
    const result = await checkPiAuthentication(async () => []);
    assert.deepEqual(result, { ready: false });
  });
});

describe("doer model", () => {
  const available = [
    { provider: "opencode", id: "kimi-k2.6" },
    { provider: "opencode-go", id: "deepseek-v4-flash" }
  ];

  it("names Pi's saved default when it is authenticated", () => {
    const description = describeDoerModel({ defaultProvider: "opencode-go", defaultModel: "deepseek-v4-flash", available });
    assert.deepEqual(description, { pinned: true, model: "opencode-go/deepseek-v4-flash" });
    assert.match(modelReport({ pinned: false, reason: "no-default" }, description)[1], /opencode-go\/deepseek-v4-flash/);
  });

  it("says Pi chooses when no default is saved", () => {
    const description = describeDoerModel({ defaultProvider: undefined, defaultModel: undefined, available });
    assert.deepEqual(description, { pinned: false, reason: "no-default", choices: 2 });
  });

  it("does not name a saved default Pi cannot authenticate", () => {
    const description = describeDoerModel({ defaultProvider: "anthropic", defaultModel: "claude-opus-4-8", available });
    assert.deepEqual(description, { pinned: false, reason: "not-authenticated", saved: "anthropic/claude-opus-4-8", choices: 2 });
  });
});

describe("tutor model", () => {
  const opus = { provider: "anthropic", id: "claude-opus-4-8" };
  const resolveTo = (model, authenticated = true) => () => ({ model, authenticated });

  it("names the model TUTOR_MODEL resolves to", () => {
    const description = describeTutorModel({ requested: "anthropic/claude-opus-4-8", resolve: resolveTo(opus) });
    assert.deepEqual(description, { pinned: true, model: "anthropic/claude-opus-4-8" });
  });

  it("ignores surrounding whitespace", () => {
    assert.deepEqual(
      describeTutorModel({ requested: "  anthropic/claude-opus-4-8\n", resolve: resolveTo(opus) }),
      { pinned: true, model: "anthropic/claude-opus-4-8" }
    );
  });

  it("leaves the choice to Pi when TUTOR_MODEL is unset or blank", () => {
    for (const requested of [undefined, "", "   "]) {
      assert.deepEqual(describeTutorModel({ requested, resolve: () => assert.fail("must not resolve") }), { pinned: false, reason: "no-default" });
    }
  });

  it("reports a TUTOR_MODEL that matches nothing", () => {
    const description = describeTutorModel({ requested: "no-such/model", resolve: resolveTo(undefined) });
    assert.deepEqual(description, { pinned: false, reason: "no-match", requested: "no-such/model" });
  });

  it("reports a TUTOR_MODEL that matches an unauthenticated provider", () => {
    const description = describeTutorModel({ requested: "opus", resolve: resolveTo(opus, false) });
    assert.deepEqual(description, { pinned: false, reason: "not-authenticated", requested: "opus", saved: "anthropic/claude-opus-4-8" });
  });
});

describe("model report", () => {
  it("keeps the tutor and doer model roles on separate lines and explains each knob", () => {
    const report = modelReport(
      { pinned: true, model: "anthropic/claude-opus-4-8" },
      { pinned: true, model: "opencode-go/deepseek-v4-flash" }
    );
    assert.match(report[0], /^Main tutor model: +anthropic\/claude-opus-4-8 \(TUTOR_MODEL\)$/);
    assert.match(report[1], /^Doer model: +opencode-go\/deepseek-v4-flash$/);
    assert.match(report.join("\n"), /TUTOR_MODEL=/);
    assert.match(report.join("\n"), /'\/model'/);
  });

  it("explains both knobs even when Pi is choosing both models", () => {
    const report = modelReport(
      { pinned: false, reason: "no-default" },
      { pinned: false, reason: "no-default", choices: 2 }
    );
    assert.match(report[0], /TUTOR_MODEL is unset/);
    assert.match(report[1], /no default is saved/);
    assert.match(report.join("\n"), /TUTOR_MODEL=/);
    assert.match(report.join("\n"), /'\/model'/);
  });
});
