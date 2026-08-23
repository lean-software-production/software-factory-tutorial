import { expect, test } from "vitest";
import {
  createResilientTutorSession,
  type PiTutorSession,
  type PiTutorSessionEvent
} from "../src/workbook/pi-tutor-session.js";

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
  const errors: string[] = [];
  return { errors, log: { info() {}, error(message: string) { errors.push(message); } } };
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
  expect(logs.errors).toContain("Workbook tutor prompt failed (attempt 1/3; anthropic/claude): fetch failed");
  expect(logs.errors.join("\n")).not.toContain("private learner prompt");
});

test("rejects with the terminal error after the third failed attempt", async () => {
  const session = fakeSession([assistantError("fetch failed"), assistantError("fetch failed"), assistantError("fetch failed")]);
  const logs = logger();

  await expect(createResilientTutorSession(session, logs.log, "Workbook tutor", { wait: async () => {} }).prompt("message"))
    .rejects.toThrow("fetch failed");
  expect(session.prompts).toHaveLength(3);
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
    .rejects.toMatchObject({ message: providerReason });
  expect(session.prompts).toHaveLength(3);
  expect(logs.errors.join("\n")).not.toContain(privatePrompt);
});

test("retries an empty assistant terminal message and identifies it in the log", async () => {
  const session = fakeSession([assistantText("   "), assistantText("Useful reply")]);
  const logs = logger();

  await expect(createResilientTutorSession(session, logs.log, "Workbook tutor", { wait: async () => {} }).prompt("message"))
    .resolves.toBe("Useful reply");
  expect(logs.errors[0]).toContain("assistant returned no text");
});
