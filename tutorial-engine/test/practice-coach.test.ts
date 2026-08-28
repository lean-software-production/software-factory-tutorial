import { afterEach, describe, expect, it } from "vitest";
import {
  FastPracticeCoach,
  PRACTICE_COACH_REPORT_DESCRIPTION,
  practiceCoachSystemPrompt
} from "../src/workbook/practice-coach.js";

const originalPromptLogging = process.env.PRACTICE_COACH_LOG_PROMPT;

afterEach(() => {
  if (originalPromptLogging === undefined) delete process.env.PRACTICE_COACH_LOG_PROMPT;
  else process.env.PRACTICE_COACH_LOG_PROMPT = originalPromptLogging;
});

describe("Practice Coach learner-facing instructions", () => {
  it("requires concise direct second-person feedback without internal mechanics", () => {
    const prompt = practiceCoachSystemPrompt();

    expect(prompt).toContain("address them as you");
    expect(prompt).toContain("never say “the learner”");
    expect(prompt).toContain("never mention the Coach, Tutor, rubric, model, assessment, handoff, or other internal mechanics");
    expect(PRACTICE_COACH_REPORT_DESCRIPTION).toContain("address them as you");
    expect(PRACTICE_COACH_REPORT_DESCRIPTION).toContain("never say ‘the learner’");
    expect(PRACTICE_COACH_REPORT_DESCRIPTION).toContain("never mention the Coach, Tutor, rubric, model, assessment, handoff, or other internal mechanics");
  });

  it("does not log private Practice Coach evidence by default", async () => {
    delete process.env.PRACTICE_COACH_LOG_PROMPT;
    const messages: string[] = [];
    const coach = new FastPracticeCoach({
      workspace: "/tmp/workbook",
      log: { info(message) { messages.push(message); }, error() {} },
      sessionFactory: async ({ customTools }) => ({
        async prompt() {
          await customTools[0]!.execute("report", { outcome: "working" }, undefined as never, undefined as never, undefined as never);
          return "";
        },
        dispose() { messages.push("disposed"); }
      })
    });

    await expect(coach.assess({
      attempt: {
        id: "attempt", lessonId: "001", blockId: "block", version: 1, status: "reviewing",
        evidence: { kind: "terminal", transcript: "private terminal transcript", terminalHtml: "<pre>private command</pre>" }
      },
      rubric: "private rubric"
    })).resolves.toEqual({ outcome: "working" });

    expect(messages).toEqual(["disposed"]);
  });

  it("logs the exact secret-bearing Practice Coach prompt before dispatch when explicitly enabled", async () => {
    process.env.PRACTICE_COACH_LOG_PROMPT = "1";
    const secretBearingSentinel = "Authorization: Bearer test-only-coach-token";
    const events: string[] = [];
    const coach = new FastPracticeCoach({
      workspace: "/tmp/workbook",
      log: { info(message) { events.push(`log:${message}`); }, error() {} },
      sessionFactory: async ({ customTools }) => ({
        async prompt(value) {
          events.push(`prompt:${value}`);
          await customTools[0]!.execute("report", { outcome: "ready", text: "Ready to confirm." }, undefined as never, undefined as never, undefined as never);
          return "";
        },
        dispose() { events.push("disposed"); }
      })
    });

    await expect(coach.assess({
      attempt: {
        id: "attempt", lessonId: "001", blockId: "block", version: 1, status: "reviewing",
        evidence: { kind: "terminal", transcript: `private terminal transcript\n${secretBearingSentinel}`, terminalHtml: "<pre>private command</pre>" }
      },
      rubric: "private rubric"
    })).resolves.toEqual({ outcome: "ready", text: "Ready to confirm." });

    const dispatched = events.find((event) => event.startsWith("prompt:"))!.slice("prompt:".length);
    const logged = events[0]!.slice("log:Practice Coach prompt begin\n".length, -"\nPractice Coach prompt end".length);
    expect(logged).toBe(dispatched);
    expect(logged).toContain(secretBearingSentinel);
    expect(events).toEqual([
      `log:Practice Coach prompt begin\n${dispatched}\nPractice Coach prompt end`,
      `prompt:${dispatched}`,
      "disposed"
    ]);
  });
});
