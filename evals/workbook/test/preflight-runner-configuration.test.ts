import { beforeEach, describe, expect, it, vi } from "vitest";

const constructed = vi.hoisted(() => ({
  tutors: [] as any[],
  coaches: [] as any[]
}));

vi.mock("../../../tutorial-engine/src/workbook/tutor.js", () => {
  class DefaultMainWorkbookTutor {
    constructor(options: any) { constructed.tutors.push(options); }
  }
  return { DefaultMainWorkbookTutor };
});

vi.mock("../../../tutorial-engine/src/workbook/practice-coach.js", () => {
  class FastPracticeCoach {
    constructor(options: any) { constructed.coaches.push(options); }
  }
  return { FastPracticeCoach, PRACTICE_COACH_LOG_PROMPT_ENV: "PRACTICE_COACH_LOG_PROMPT" };
});

import {
  EVAL_JUDGE_COMMAND_ENV,
  OPENCODE_API_KEY_ENV,
  PRACTICE_COACH_LOG_PROMPT_ENV,
  createAuthoredWorkbookRunnerModelConfiguration,
  validateAuthoredWorkbookEvalPreflightRequest
} from "../preflight.js";

const secret = "sk-secret-runner-config";
const privatePath = "/private/tmp/runner-config-secret";

beforeEach(() => {
  constructed.tutors.splice(0);
  constructed.coaches.splice(0);
});

describe("authored workbook runner model configuration", () => {
  it("exposes only factories while factories close over a frozen least-privilege role environment", () => {
    const request = validateAuthoredWorkbookEvalPreflightRequest({
      scenarioIds: ["primer-validation-misconception"],
      models: {
        mainTutor: "anthropic/requested-main:high",
        practiceCoach: "openai/requested-coach",
        judge: "google/requested-judge"
      },
      costBudget: { maxPaidModelCalls: 18, maxEstimatedTokens: 36_000, estimatedTokensPerPaidCall: 2_000 },
      environment: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TUTOR_MODEL: "anthropic/ambient-main",
        PRACTICE_COACH_MODEL: "openai/ambient-coach",
        EVAL_JUDGE_MODEL: "google/ambient-judge",
        [OPENCODE_API_KEY_ENV]: secret,
        [EVAL_JUDGE_COMMAND_ENV]: `${privatePath}/judge.sh`,
        [PRACTICE_COACH_LOG_PROMPT_ENV]: "0",
        EXTRA_SECRET: "must-not-copy"
      },
      repositoryRoot: process.cwd()
    });
    const summary = {
      scenarioIds: request.scenarios.map((scenario) => scenario.id),
      repeat: request.repeat,
      configuredModelIdentities: [
        { role: "Main Tutor" as const, provider: request.models.mainTutor.provider, id: request.models.mainTutor.id },
        { role: "Practice Coach" as const, provider: request.models.practiceCoach.provider, id: request.models.practiceCoach.id },
        { role: "Judge" as const, provider: request.models.judge.provider, id: request.models.judge.id }
      ]
    };

    const configuration = createAuthoredWorkbookRunnerModelConfiguration(request, summary);

    expect(Object.isFrozen(configuration)).toBe(true);
    expect(Reflect.ownKeys(configuration).sort()).toEqual(["createMainTutor", "createPracticeCoach"]);
    expect(Object.hasOwn(configuration, "environment")).toBe(false);
    expect(JSON.stringify(configuration)).toBe("{}");
    expect(JSON.stringify(configuration)).not.toContain(secret);
    expect(JSON.stringify(configuration)).not.toContain(OPENCODE_API_KEY_ENV);
    expect(JSON.stringify(configuration)).not.toContain("EXTRA_SECRET");

    configuration.createMainTutor({ workspace: "/tmp/main", log: { info() {}, error() {} } });
    configuration.createPracticeCoach({ workspace: "/tmp/coach", log: { info() {}, error() {} } });

    expect(constructed.tutors).toHaveLength(1);
    expect(constructed.coaches).toHaveLength(1);
    const roleEnvironment = constructed.tutors[0].environment;
    expect(constructed.coaches[0].environment).toBe(roleEnvironment);
    expect(Object.isFrozen(roleEnvironment)).toBe(true);
    expect(roleEnvironment).toEqual({
      TUTOR_MODEL: "anthropic/requested-main:high",
      PRACTICE_COACH_MODEL: "openai/requested-coach",
      [PRACTICE_COACH_LOG_PROMPT_ENV]: "0"
    });
    expect(Reflect.ownKeys(roleEnvironment).sort()).toEqual([PRACTICE_COACH_LOG_PROMPT_ENV, "PRACTICE_COACH_MODEL", "TUTOR_MODEL"].sort());
    expect(roleEnvironment).not.toHaveProperty(OPENCODE_API_KEY_ENV);
    expect(roleEnvironment).not.toHaveProperty(EVAL_JUDGE_COMMAND_ENV);
    expect(roleEnvironment).not.toHaveProperty("EVAL_JUDGE_MODEL");
    expect(roleEnvironment).not.toHaveProperty("EXTRA_SECRET");
    expect(roleEnvironment).not.toHaveProperty("PATH");
    expect(roleEnvironment).not.toHaveProperty("HOME");
  });
});
