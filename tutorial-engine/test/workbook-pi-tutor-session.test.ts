import { expect, test, vi } from "vitest";
import {
  createResilientTutorSession,
  type PiTutorSession,
  type PiTutorSessionEvent
} from "../src/workbook/pi-tutor-session.js";
import { TutorInfrastructureError } from "../src/workbook/tutor-infrastructure.js";

type AssistantTerminal = Extract<PiTutorSessionEvent, { type: "message_end" }>;
type FakeOutcome = AssistantTerminal | { rejection: unknown };

function assistantError(errorMessage: string): AssistantTerminal {
  return {
    type: "message_end",
    message: { role: "assistant", content: [], errorMessage }
  };
}

function assistantText(text: string): AssistantTerminal {
  return {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] }
  };
}

function fakeSession(events: FakeOutcome[]): PiTutorSession & { prompts: string[] } {
  const listeners = new Set<(event: PiTutorSessionEvent) => void>();
  const prompts: string[] = [];
  return {
    state: { model: { provider: "anthropic", id: "claude" } },
    prompts,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async prompt(prompt) {
      prompts.push(prompt);
      const outcome = events.shift();
      if (!outcome) throw new Error("No terminal event configured.");
      if ("rejection" in outcome) throw outcome.rejection;
      listeners.forEach((listener) => listener(outcome));
    },
    dispose() {}
  };
}

function logger() {
  const infos: string[] = [];
  const errors: string[] = [];
  return { infos, errors, log: { info(message: string) { infos.push(message); }, error(message: string) { errors.push(message); } } };
}

test("retries an assistant terminal provider error twice, then returns its next text response", async () => {
  const session = fakeSession([
    assistantError("fetch failed"),
    assistantError("fetch failed"),
    assistantText("Recovered reply")
  ]);
  const logs = logger();
  const waits: number[] = [];

  await expect(createResilientTutorSession(session, logs.log, "Workbook tutor", {
    wait: async (milliseconds) => { waits.push(milliseconds); }
  }).prompt("private learner prompt")).resolves.toBe("Recovered reply");

  expect(session.prompts).toEqual(["private learner prompt", "private learner prompt", "private learner prompt"]);
  expect(waits).toEqual([250, 500]);
  expect(logs.errors[0]).toMatch(/Workbook tutor prompt failed \(attempt 1\/3; durationMs=\d+; anthropic\/claude\): fetch failed/);
  expect(logs.infos).toContainEqual(expect.stringMatching(/Workbook tutor prompt completed \(attempt 3\/3; durationMs=\d+; outcome=success\)\./));
  expect(logs.errors.join("\n")).not.toContain("private learner prompt");
});

test("recovers when the first provider attempt fails", async () => {
  const session = fakeSession([assistantError("fetch failed"), assistantText("Recovered reply")]);
  const logs = logger();
  const waits: number[] = [];

  await expect(createResilientTutorSession(session, logs.log, "Workbook tutor", {
    wait: async (milliseconds) => { waits.push(milliseconds); }
  }).prompt("message")).resolves.toBe("Recovered reply");

  expect(session.prompts).toHaveLength(2);
  expect(waits).toEqual([250]);
  expect(logs.infos).toContainEqual(expect.stringMatching(/Workbook tutor prompt completed \(attempt 2\/3; durationMs=\d+; outcome=success\)\./));
});

test("rejects with a typed infrastructure error after the third failed attempt", async () => {
  const finalCause = new Error("fetch failed on third");
  const session = fakeSession([assistantError("fetch failed once"), assistantError("fetch failed twice"), { rejection: finalCause }]);
  const logs = logger();

  await expect(createResilientTutorSession(session, logs.log, "Workbook tutor", { wait: async () => {} }).prompt("message"))
    .rejects.toMatchObject({ name: "TutorInfrastructureError", cause: finalCause });
  await expect(createResilientTutorSession(fakeSession([assistantError("a"), assistantError("b"), assistantError("c")]), logs.log, "Workbook tutor", { wait: async () => {} }).prompt("message"))
    .rejects.toBeInstanceOf(TutorInfrastructureError);
  expect(session.prompts).toHaveLength(3);
  expect(logs.errors).toContainEqual(expect.stringMatching(/Workbook tutor prompt exhausted \(attempts=3; durationMs=\d+; outcome=infrastructure_failure\)\./));
});

test("uses exactly three attempts for privacy-sensitive generic logging", async () => {
  const session = fakeSession([
    assistantError("usage limit for private terminal transcript"),
    assistantError("usage limit for private terminal transcript"),
    assistantError("usage limit for private terminal transcript")
  ]);
  const logs = logger();
  const wait = vi.fn(async () => {});

  await expect(createResilientTutorSession(session, logs.log, "Workbook tutor", { wait }).prompt("private terminal transcript", { failureLog: "generic" }))
    .rejects.toBeInstanceOf(TutorInfrastructureError);

  expect(session.prompts).toEqual(["private terminal transcript", "private terminal transcript", "private terminal transcript"]);
  expect(wait).toHaveBeenCalledTimes(2);
  expect(logs.errors.slice(0, 3)).toEqual([
    expect.stringMatching(/Workbook tutor prompt failed \(attempt 1\/3; durationMs=\d+\)\./),
    expect.stringMatching(/Workbook tutor prompt failed \(attempt 2\/3; durationMs=\d+\)\./),
    expect.stringMatching(/Workbook tutor prompt failed \(attempt 3\/3; durationMs=\d+\)\./),
  ]);
  expect(logs.errors.join("\n")).not.toMatch(/anthropic|claude|usage limit|private terminal transcript/);
});

test("redacts a learner prompt echoed by rejected provider errors from logs but preserves it in the final error", async () => {
  const privatePrompt = "private learner prompt: My salary is $123,456";
  const providerReason = `transport down while sending: ${privatePrompt}`;
  const session = fakeSession([
    { rejection: providerReason },
    { rejection: providerReason },
    { rejection: providerReason }
  ]);
  const logs = logger();

  await expect(createResilientTutorSession(session, logs.log, "Workbook tutor", { wait: async () => {} }).prompt(privatePrompt))
    .rejects.toMatchObject({ name: "TutorInfrastructureError", cause: providerReason });
  expect(session.prompts).toHaveLength(3);
  expect(logs.errors.join("\n")).not.toContain(privatePrompt);
});

test("returns an empty assistant terminal message so tool-only review turns can be interpreted by callers", async () => {
  const session = fakeSession([assistantText("   ")]);
  const logs = logger();

  await expect(createResilientTutorSession(session, logs.log, "Workbook tutor", { wait: async () => {} }).prompt("message"))
    .resolves.toBe("   ");
  expect(session.prompts).toHaveLength(1);
  expect(logs.errors).toEqual([]);
});
