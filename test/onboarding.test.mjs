import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPiAuthentication, describeBlockTutorModel, describeDoerModel, describeTutorModel, modelReport } from "../scripts/setup.mjs";
import { tutorialArguments } from "../scripts/tutorial.mjs";
import { trustedNodeRuntimeProvision, tutorialWorkbookArguments } from "../scripts/tutorial-workbook.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tutorialRoot = resolve(repositoryRoot, "tutorial");

describe("tutorial launcher", () => {
  it("starts the workbook from npm start", async () => {
    const manifest = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
    assert.equal(manifest.scripts.start, "npm run tutorial");
  });

  it("keeps the calculator workspace under the tutorial workspace", async () => {
    const manifest = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
    assert.deepEqual(manifest.workspaces, ["tutorial/calculator", "tutorial-engine"]);
  });

  it("forwards engine options after the tutorial content target", () => {
    assert.deepEqual(tutorialArguments(["--port", "4310", "--no-open"]), [
      "run", "--workspace=tutorial-engine", "dev:workbook", "--", tutorialRoot, "--port", "4310", "--no-open"
    ]);
    assert.deepEqual(tutorialArguments(["--session", "lesson-007"]), [
      "run", "--workspace=tutorial-engine", "dev:workbook", "--", tutorialRoot, "--session", "lesson-007"
    ]);
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

describe("block tutor model", () => {
  const fast = { provider: "openai", id: "gpt-5.1-mini" };
  const resolveTo = (model, authenticated = true) => () => ({ model, authenticated });

  it("names the model BLOCK_TUTOR_MODEL resolves to", () => {
    const description = describeBlockTutorModel({ requested: "openai/gpt-5.1-mini", resolve: resolveTo(fast) });
    assert.deepEqual(description, { pinned: true, model: "openai/gpt-5.1-mini" });
  });

  it("leaves the choice to Pi when BLOCK_TUTOR_MODEL is unset or blank", () => {
    for (const requested of [undefined, "", "   "]) {
      assert.deepEqual(describeBlockTutorModel({ requested, resolve: () => assert.fail("must not resolve") }), { pinned: false, reason: "no-default" });
    }
  });

  it("falls back to Pi's default selection when BLOCK_TUTOR_MODEL is invalid or unconfigured", () => {
    assert.deepEqual(
      describeBlockTutorModel({ requested: "no-such/model", resolve: resolveTo(undefined) }),
      { pinned: false, reason: "no-match", requested: "no-such/model" }
    );
    assert.deepEqual(
      describeBlockTutorModel({ requested: "fast", resolve: resolveTo(fast, false) }),
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
    assert.match(report[1], /^Block tutor model: +openai\/gpt-5.1-mini \(BLOCK_TUTOR_MODEL\)$/);
    assert.match(report[2], /^Doer model: +opencode-go\/deepseek-v4-flash$/);
    assert.match(report.join("\n"), /TUTOR_MODEL=/);
    assert.match(report.join("\n"), /BLOCK_TUTOR_MODEL=/);
    assert.match(report.join("\n"), /'\/model'/);
  });

  it("explains both knobs even when Pi is choosing both models", () => {
    const report = modelReport(
      { pinned: false, reason: "no-default" },
      { pinned: false, reason: "no-default" },
      { pinned: false, reason: "no-default", choices: 2 }
    );
    assert.match(report[0], /TUTOR_MODEL is unset/);
    assert.match(report[1], /BLOCK_TUTOR_MODEL is unset/);
    assert.match(report[2], /no default is saved/);
    assert.match(report.join("\n"), /TUTOR_MODEL=/);
    assert.match(report.join("\n"), /BLOCK_TUTOR_MODEL=/);
    assert.match(report.join("\n"), /'\/model'/);
  });
});
