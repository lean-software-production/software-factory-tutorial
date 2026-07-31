import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkPiAuthentication } from "../scripts/setup.mjs";
import { tutorialArguments } from "../scripts/tutorial.mjs";

describe("tutorial launcher", () => {
  it("forwards engine options after the tutorial workspace target", () => {
    assert.deepEqual(tutorialArguments(["--port", "4310", "--no-open"]), [
      "run", "--workspace=tutorial-engine", "dev", "--", ".", "--port", "4310", "--no-open"
    ]);
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
