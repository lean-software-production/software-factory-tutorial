import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPiAuthentication, describePracticeCoachModel, describeDoerModel, describeTutorModel, modelReport } from "../scripts/setup.mjs";
import { trustedNodeRuntimeProvision, tutorialWorkbookArguments } from "../scripts/tutorial-workbook.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tutorialRoot = resolve(repositoryRoot, "tutorial");

async function readPackageManifest() {
  return JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
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
  it("starts the workbook from npm start", async () => {
    const manifest = await readPackageManifest();
    assert.equal(manifest.scripts.start, "npm run tutorial:workbook");
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
    assert.match(modelReport({ pinned: false, reason: "no-default" }, { pinned: false, reason: "no-default" }, description)[2], /opencode-go\/deepseek-v4-flash/);
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

describe("Practice Coach model", () => {
  const fast = { provider: "openai", id: "gpt-5.1-mini" };
  const resolveTo = (model, authenticated = true) => () => ({ model, authenticated });

  it("names the model PRACTICE_COACH_MODEL resolves to", () => {
    const description = describePracticeCoachModel({ requested: "openai/gpt-5.1-mini", resolve: resolveTo(fast) });
    assert.deepEqual(description, { pinned: true, model: "openai/gpt-5.1-mini" });
  });

  it("leaves the choice to Pi when PRACTICE_COACH_MODEL is unset or blank", () => {
    for (const requested of [undefined, "", "   "]) {
      assert.deepEqual(describePracticeCoachModel({ requested, resolve: () => assert.fail("must not resolve") }), { pinned: false, reason: "no-default" });
    }
  });

  it("falls back to Pi's default selection when PRACTICE_COACH_MODEL is invalid or unconfigured", () => {
    assert.deepEqual(
      describePracticeCoachModel({ requested: "no-such/model", resolve: resolveTo(undefined) }),
      { pinned: false, reason: "no-match", requested: "no-such/model" }
    );
    assert.deepEqual(
      describePracticeCoachModel({ requested: "fast", resolve: resolveTo(fast, false) }),
      { pinned: false, reason: "not-authenticated", requested: "fast", saved: "openai/gpt-5.1-mini" }
    );
  });
});

describe("model report", () => {
  it("keeps the three model roles on separate lines and explains each knob", () => {
    const report = modelReport(
      { pinned: true, model: "anthropic/claude-opus-4-8" },
      { pinned: true, model: "openai/gpt-5.1-mini" },
      { pinned: true, model: "opencode-go/deepseek-v4-flash" }
    );
    assert.match(report[0], /^Main tutor model: +anthropic\/claude-opus-4-8 \(TUTOR_MODEL\)$/);
    assert.match(report[1], /^Practice Coach model: +openai\/gpt-5.1-mini \(PRACTICE_COACH_MODEL\)$/);
    assert.match(report[2], /^Doer model: +opencode-go\/deepseek-v4-flash$/);
    assert.match(report.join("\n"), /TUTOR_MODEL=/);
    assert.match(report.join("\n"), /PRACTICE_COACH_MODEL=/);
    assert.match(report.join("\n"), /'\/model'/);
  });

  it("explains both knobs even when Pi is choosing both models", () => {
    const report = modelReport(
      { pinned: false, reason: "no-default" },
      { pinned: false, reason: "no-default" },
      { pinned: false, reason: "no-default", choices: 2 }
    );
    assert.match(report[0], /TUTOR_MODEL is unset/);
    assert.match(report[1], /PRACTICE_COACH_MODEL is unset/);
    assert.match(report[2], /no default is saved/);
    assert.match(report.join("\n"), /TUTOR_MODEL=/);
    assert.match(report.join("\n"), /PRACTICE_COACH_MODEL=/);
    assert.match(report.join("\n"), /'\/model'/);
  });
});
