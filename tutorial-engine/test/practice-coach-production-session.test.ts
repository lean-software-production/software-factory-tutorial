import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pi = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  resolveCliModel: vi.fn(),
  reloads: 0,
  loaders: [] as any[],
  sessionManagers: [] as string[],
  settings: [] as any[],
}));

vi.mock("@earendil-works/pi-coding-agent", () => {
  class DefaultResourceLoader {
    constructor(readonly options: any) { pi.loaders.push(options); }
    async reload() { pi.reloads += 1; }
  }
  return {
    DefaultResourceLoader,
    ModelRuntime: { create: vi.fn(async () => ({ hasConfiguredAuth: vi.fn(() => true) })) },
    SessionManager: { inMemory: vi.fn((cwd: string) => { pi.sessionManagers.push(cwd); return { cwd }; }) },
    SettingsManager: { inMemory: vi.fn((settings: any) => { pi.settings.push(settings); return { settings }; }) },
    createAgentSession: pi.createAgentSession,
    defineTool: vi.fn((definition: any) => definition),
    getAgentDir: vi.fn(() => "/tmp/pi-agent"),
    resolveCliModel: pi.resolveCliModel,
  };
});

function providerErrorSession(errorMessage: string) {
  const subscribers = new Set<(event: any) => void>();
  const prompts: string[] = [];
  return {
    state: { model: { provider: "anthropic", id: "claude" } },
    prompts,
    dispose: vi.fn(),
    subscribe(listener: (event: any) => void) {
      subscribers.add(listener);
      return () => { subscribers.delete(listener); };
    },
    async prompt(prompt: string) {
      prompts.push(prompt);
      for (const subscriber of subscribers) {
        subscriber({ type: "message_end", message: { role: "assistant", content: [], errorMessage } });
      }
    },
  };
}

function logger() { return { info: vi.fn(), error: vi.fn() }; }

const originalPracticeCoachModel = process.env.PRACTICE_COACH_MODEL;

beforeEach(() => {
  pi.createAgentSession.mockReset();
  pi.resolveCliModel.mockReset();
  pi.reloads = 0;
  pi.loaders.splice(0);
  pi.sessionManagers.splice(0);
  pi.settings.splice(0);
  delete process.env.PRACTICE_COACH_MODEL;
});

afterEach(() => {
  if (originalPracticeCoachModel === undefined) delete process.env.PRACTICE_COACH_MODEL;
  else process.env.PRACTICE_COACH_MODEL = originalPracticeCoachModel;
});

describe("Practice Coach production session factory", () => {
  it("uses one low-level Pi prompt for a runtime provider terminal error and disposes", async () => {
    const session = providerErrorSession("usage limit reached");
    pi.createAgentSession.mockResolvedValueOnce({ session });
    const log = logger();
    const { FastPracticeCoach } = await import("../src/workbook/practice-coach.js");

    const coach = new FastPracticeCoach({ workspace: "/tmp/workbook", log });

    await expect(coach.assess({
      attempt: {
        id: "attempt",
        lessonId: "001",
        blockId: "block",
        version: 1,
        status: "reviewing",
        evidence: { kind: "terminal", transcript: "private terminal transcript", terminalHtml: "<pre>private command</pre>" },
      },
      rubric: "private rubric",
    })).rejects.toThrow("usage limit reached");

    expect(pi.reloads).toBe(1);
    expect(pi.createAgentSession).toHaveBeenCalledOnce();
    expect(session.prompts).toHaveLength(1);
    expect(session.prompts[0]).toContain("PRIVATE RUBRIC:\nprivate rubric");
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("Practice Coach prompt failed (attempt 1/1; anthropic/claude): usage limit reached"));
    expect(pi.loaders[0]).toEqual(expect.objectContaining({
      cwd: "/tmp/workbook",
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [],
    }));
    expect(pi.sessionManagers).toEqual(["/tmp/workbook"]);
    expect(pi.settings[0]).toEqual(expect.objectContaining({ compaction: { enabled: false }, retry: { enabled: false } }));
  });
});
