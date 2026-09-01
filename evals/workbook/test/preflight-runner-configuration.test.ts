import { beforeEach, describe, expect, it, vi } from "vitest";

const constructed = vi.hoisted(() => ({
  tutors: [] as any[]
}));

vi.mock("../../../tutorial-engine/src/workbook/tutor.js", () => {
  class DefaultMainWorkbookTutor {
    constructor(options: any) { constructed.tutors.push(options); }
  }
  return { DefaultMainWorkbookTutor };
});

import {
  EVAL_JUDGE_COMMAND_ENV,
  OPENCODE_API_KEY_ENV,
  createAuthoredWorkbookRunnerModelConfiguration,
  validateAuthoredWorkbookEvalPreflightRequest
} from "../preflight.js";

const secret = "sk-secret-runner-config";
const privatePath = "/private/tmp/runner-config-secret";

beforeEach(() => {
  constructed.tutors.splice(0);
});

describe("authored workbook runner model configuration", () => {
  it("exposes only the Main Tutor factory while it closes over a frozen least-privilege role environment", () => {
    const request = validateAuthoredWorkbookEvalPreflightRequest({
      scenarioIds: ["primer-validation-misconception"],
      models: {
        mainTutor: "anthropic/requested-main:high",
        judge: "google/requested-judge"
      },
      costBudget: { maxPaidModelCalls: 18, maxEstimatedTokens: 36_000, estimatedTokensPerPaidCall: 2_000 },
      environment: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TUTOR_MODEL: "anthropic/ambient-main",
        EVAL_JUDGE_MODEL: "google/ambient-judge",
        [OPENCODE_API_KEY_ENV]: secret,
        [EVAL_JUDGE_COMMAND_ENV]: `${privatePath}/judge.sh`,
        EXTRA_SECRET: "must-not-copy"
      },
      repositoryRoot: process.cwd()
    });
    const summary = {
      scenarioIds: request.scenarios.map((scenario) => scenario.id),
      repeat: request.repeat,
      configuredModelIdentities: [
        { role: "Main Tutor" as const, provider: request.models.mainTutor.provider, id: request.models.mainTutor.id },
        { role: "Judge" as const, provider: request.models.judge!.provider, id: request.models.judge!.id }
      ]
    };

    const configuration = createAuthoredWorkbookRunnerModelConfiguration(request, summary);

    expect(Object.isFrozen(configuration)).toBe(true);
    expect(Reflect.ownKeys(configuration).sort()).toEqual(["createMainTutor"]);
    expect(Object.hasOwn(configuration, "environment")).toBe(false);
    expect(JSON.stringify(configuration)).toBe("{}");
    expect(JSON.stringify(configuration)).not.toContain(secret);
    expect(JSON.stringify(configuration)).not.toContain(OPENCODE_API_KEY_ENV);
    expect(JSON.stringify(configuration)).not.toContain("EXTRA_SECRET");

    configuration.createMainTutor({ workspace: "/tmp/main", log: { info() {}, error() {} } });

    expect(constructed.tutors).toHaveLength(1);
    const roleEnvironment = constructed.tutors[0].environment;
    expect(Object.isFrozen(roleEnvironment)).toBe(true);
    expect(roleEnvironment).toEqual({
      TUTOR_MODEL: "anthropic/requested-main:high"
    });
    expect(Reflect.ownKeys(roleEnvironment).sort()).toEqual(["TUTOR_MODEL"].sort());
    expect(roleEnvironment).not.toHaveProperty(OPENCODE_API_KEY_ENV);
    expect(roleEnvironment).not.toHaveProperty(EVAL_JUDGE_COMMAND_ENV);
    expect(roleEnvironment).not.toHaveProperty("EVAL_JUDGE_MODEL");
    expect(roleEnvironment).not.toHaveProperty("EXTRA_SECRET");
    expect(roleEnvironment).not.toHaveProperty("PATH");
    expect(roleEnvironment).not.toHaveProperty("HOME");
  });
});
