import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkbookTimelineRecord } from "../src/workbook/timeline.js";

const pi = vi.hoisted(() => {
  const appendMessage = vi.fn();
  const appendCustomMessageEntry = vi.fn();
  const sessionManager = {
    appendMessage,
    appendCustomMessageEntry,
    buildSessionContext: vi.fn(() => ({ messages: appendMessage.mock.calls.map(([message]) => message) }))
  };
  const selectedDefaultModel = { api: "anthropic-messages", provider: "default-provider", id: "default-model" };
  return {
    appendMessage,
    appendCustomMessageEntry,
    sessionManager,
    selectedDefaultModel,
    createAgentSession: vi.fn(),
    resolveCliModel: vi.fn(),
    hasConfiguredAuth: vi.fn()
  };
});

vi.mock("@earendil-works/pi-coding-agent", () => {
  class DefaultResourceLoader { async reload() {} }
  const subscribers = new Set<(event: any) => void>();
  const session = {
    state: { model: pi.selectedDefaultModel },
    agent: { state: { messages: [] as any[] } },
    subscribe(callback: (event: any) => void) { subscribers.add(callback); return () => subscribers.delete(callback); },
    async prompt() {
      for (const callback of subscribers) callback({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Model-backed reply." }] } });
      return "Model-backed reply.";
    },
    async compact() { return { summary: "Summary." }; },
    dispose() {}
  };
  pi.createAgentSession.mockImplementation(async (options: { model?: typeof pi.selectedDefaultModel } = {}) => {
    session.state.model = options.model ?? pi.selectedDefaultModel;
    return { session };
  });
  return {
    DefaultResourceLoader,
    ModelRuntime: { create: vi.fn(async () => ({ hasConfiguredAuth: pi.hasConfiguredAuth })) },
    SessionManager: { inMemory: vi.fn(() => pi.sessionManager) },
    SettingsManager: { inMemory: vi.fn((settings) => settings) },
    createAgentSession: pi.createAgentSession,
    defineTool: vi.fn((tool) => tool),
    getAgentDir: vi.fn(() => "/tmp/pi-agent"),
    resolveCliModel: pi.resolveCliModel
  };
});

const originalTutorModel = process.env.TUTOR_MODEL;
const resolvedMainModel = { api: "openai-completions", provider: "provider", id: "main-model" };

function timestamp(second: number): string {
  return `2026-08-22T00:00:${String(second).padStart(2, "0")}.000Z`;
}

function record<T extends Omit<WorkbookTimelineRecord, "id" | "sequence" | "at">>(id: string, sequence: number, value: T): WorkbookTimelineRecord {
  return { ...value, id, sequence, at: timestamp(sequence) } as WorkbookTimelineRecord;
}

beforeEach(() => {
  pi.resolveCliModel.mockReturnValue({ model: resolvedMainModel, thinkingLevel: "high" });
  pi.hasConfiguredAuth.mockReturnValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
  if (originalTutorModel === undefined) delete process.env.TUTOR_MODEL;
  else process.env.TUTOR_MODEL = originalTutorModel;
});

describe("MainWorkbookTutor model selection", () => {
  it("resolves TUTOR_MODEL and passes model and thinking level to the Pi session", async () => {
    process.env.TUTOR_MODEL = "provider/main-model:high";
    const { MainWorkbookTutor } = await import("../src/workbook/tutor.js");
    const tutor = new MainWorkbookTutor({ workspace: "/tmp/workbook", log: { info() {}, error() {} } });

    await expect(tutor.reply({ records: [], learnerMessage: { type: "message", id: "learner", sequence: 1, at: "2026-08-22T00:00:00.000Z", lessonId: "lesson", blockId: "block", role: "user", source: "learner", presentation: "chat", text: "Which model?" } as any })).resolves.toBe("Model-backed reply.");

    expect(pi.resolveCliModel).toHaveBeenCalledWith({ cliModel: "provider/main-model:high", modelRuntime: expect.anything() });
    expect(pi.hasConfiguredAuth).toHaveBeenCalledWith("provider");
    expect(pi.createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      model: resolvedMainModel,
      thinkingLevel: "high"
    }));
  });

  it("reconstructs assistant history with Pi's selected default model when TUTOR_MODEL is unset", async () => {
    delete process.env.TUTOR_MODEL;
    const { MainWorkbookTutor } = await import("../src/workbook/tutor.js");
    const tutor = new MainWorkbookTutor({ workspace: "/tmp/workbook", log: { info() {}, error() {} } });
    const records: WorkbookTimelineRecord[] = [
      record("active-authored", 1, { type: "message", lessonId: "lesson", blockId: "one", role: "assistant", source: "authored", presentation: "course", text: "## Active block" }),
    ];

    await expect(tutor.reply({ records, learnerMessage: record("learner-new", 2, { type: "message", lessonId: "lesson", blockId: "one", role: "user", source: "learner", presentation: "chat", text: "Can you help?" }) })).resolves.toBe("Model-backed reply.");

    expect(pi.resolveCliModel).not.toHaveBeenCalled();
    expect(pi.createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      model: undefined,
      thinkingLevel: undefined
    }));
    expect(pi.appendMessage).toHaveBeenCalledWith(expect.objectContaining({
      role: "assistant",
      api: "anthropic-messages",
      provider: "default-provider",
      model: "default-model"
    }));
  });

  it("reconstructs assistant history with Pi's selected default model when TUTOR_MODEL is invalid", async () => {
    process.env.TUTOR_MODEL = "provider/missing-model";
    pi.resolveCliModel.mockReturnValueOnce({ error: "no match" });
    const { MainWorkbookTutor } = await import("../src/workbook/tutor.js");
    const tutor = new MainWorkbookTutor({ workspace: "/tmp/workbook", log: { info() {}, error() {} } });
    const records: WorkbookTimelineRecord[] = [
      record("active-authored", 1, { type: "message", lessonId: "lesson", blockId: "one", role: "assistant", source: "authored", presentation: "course", text: "## Active block" }),
    ];

    await expect(tutor.reply({ records, learnerMessage: record("learner-new", 2, { type: "message", lessonId: "lesson", blockId: "one", role: "user", source: "learner", presentation: "chat", text: "Can you help?" }) })).resolves.toBe("Model-backed reply.");

    expect(pi.createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      model: undefined,
      thinkingLevel: undefined
    }));
    expect(pi.appendMessage).toHaveBeenCalledWith(expect.objectContaining({
      role: "assistant",
      api: "anthropic-messages",
      provider: "default-provider",
      model: "default-model"
    }));
  });

  it("reconstructs projected workbook history as native Pi messages with assistant metadata", async () => {
    process.env.TUTOR_MODEL = "provider/main-model:high";
    const { MainWorkbookTutor } = await import("../src/workbook/tutor.js");
    const tutor = new MainWorkbookTutor({ workspace: "/tmp/workbook", log: { info() {}, error() {} } });
    const records: WorkbookTimelineRecord[] = [
      record("block-one-start", 1, { type: "message", lessonId: "lesson", blockId: "one", role: "assistant", source: "authored", presentation: "course", text: "Completed block text." }),
      record("block-one-end", 2, { type: "message", lessonId: "lesson", blockId: "one", role: "user", source: "learner", presentation: "chat", text: "I finished block one." }),
      record("block-one-summary", 3, { type: "block_summarized", lessonId: "lesson", blockId: "one", text: "Block one summary.", coveredThroughId: "block-one-end" }),
      record("active-authored", 4, { type: "message", lessonId: "lesson", blockId: "two", role: "assistant", source: "authored", presentation: "course", text: "## Active block" }),
      record("active-learner", 5, { type: "message", lessonId: "lesson", blockId: "two", role: "user", source: "learner", presentation: "chat", text: "What next?" }),
      record("active-main", 6, { type: "message", lessonId: "lesson", blockId: "two", role: "assistant", source: "main_tutor", presentation: "chat", text: "Try the next concrete step." }),
    ];

    await expect(tutor.reply({ records, learnerMessage: record("learner-new", 7, { type: "message", lessonId: "lesson", blockId: "two", role: "user", source: "learner", presentation: "chat", text: "Can you help?" }) })).resolves.toBe("Model-backed reply.");

    const zeroUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    };
    expect(pi.appendMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      role: "assistant",
      api: "openai-completions",
      provider: "provider",
      model: "main-model",
      stopReason: "stop",
      usage: zeroUsage,
      timestamp: Date.parse("2026-08-22T00:00:04.000Z")
    }));
    expect(pi.appendMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      role: "user",
      timestamp: Date.parse("2026-08-22T00:00:05.000Z")
    }));
    expect(pi.appendMessage).toHaveBeenNthCalledWith(3, expect.objectContaining({
      role: "assistant",
      api: "openai-completions",
      provider: "provider",
      model: "main-model",
      stopReason: "stop",
      usage: zeroUsage,
      timestamp: Date.parse("2026-08-22T00:00:06.000Z")
    }));
    expect(pi.appendCustomMessageEntry).toHaveBeenCalledWith(
      "workbook-context-block-summary",
      expect.stringContaining("Block one summary"),
      false,
      expect.objectContaining({ sourceEventId: "block-one-summary", coveredThroughId: "block-one-end" })
    );
    const assistantHistoryMessages = pi.appendMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message.role === "assistant");
    expect(assistantHistoryMessages).not.toHaveLength(0);
    for (const message of assistantHistoryMessages) {
      expect(message).toEqual(expect.objectContaining({ usage: zeroUsage, api: "openai-completions", provider: "provider", model: "main-model" }));
    }
  });
});
