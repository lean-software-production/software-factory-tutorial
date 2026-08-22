import { afterEach, describe, expect, it, vi } from "vitest";

const createAgentSession = vi.fn();
const resolveCliModel = vi.fn();
const hasConfiguredAuth = vi.fn();

vi.mock("@earendil-works/pi-coding-agent", () => {
  class DefaultResourceLoader { async reload() {} }
  const subscribers = new Set<(event: any) => void>();
  const session = {
    subscribe(callback: (event: any) => void) { subscribers.add(callback); return () => subscribers.delete(callback); },
    async prompt() {
      for (const callback of subscribers) callback({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Model-backed reply." }] } });
      return "Model-backed reply.";
    },
    async compact() { return { summary: "Summary." }; },
    dispose() {}
  };
  createAgentSession.mockResolvedValue({ session });
  resolveCliModel.mockReturnValue({ model: { provider: "provider", id: "main-model" }, thinkingLevel: "high" });
  hasConfiguredAuth.mockReturnValue(true);
  return {
    DefaultResourceLoader,
    ModelRuntime: { create: vi.fn(async () => ({ hasConfiguredAuth })) },
    SessionManager: { inMemory: vi.fn(() => ({ appendCustomMessageEntry: vi.fn(), appendMessage: vi.fn() })) },
    SettingsManager: { inMemory: vi.fn((settings) => settings) },
    createAgentSession,
    defineTool: vi.fn((tool) => tool),
    getAgentDir: vi.fn(() => "/tmp/pi-agent"),
    resolveCliModel
  };
});

const originalTutorModel = process.env.TUTOR_MODEL;

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

    expect(resolveCliModel).toHaveBeenCalledWith({ cliModel: "provider/main-model:high", modelRuntime: expect.anything() });
    expect(hasConfiguredAuth).toHaveBeenCalledWith("provider");
    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      model: { provider: "provider", id: "main-model" },
      thinkingLevel: "high"
    }));
  });
});
