import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pi = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  resolveCliModel: vi.fn(),
  hasConfiguredAuth: vi.fn(),
  loaders: [] as any[],
  settings: [] as any[],
  sessionManagers: [] as string[],
}));

vi.mock("@earendil-works/pi-coding-agent", () => {
  class DefaultResourceLoader {
    constructor(readonly options: any) { pi.loaders.push(options); }
    async reload() {}
  }
  return {
    DefaultResourceLoader,
    ModelRuntime: { create: vi.fn(async () => ({ hasConfiguredAuth: pi.hasConfiguredAuth })) },
    SessionManager: { inMemory: vi.fn((cwd: string) => { pi.sessionManagers.push(cwd); return { cwd }; }) },
    SettingsManager: { inMemory: vi.fn((settings: any) => { pi.settings.push(settings); return { settings }; }) },
    createAgentSession: pi.createAgentSession,
    getAgentDir: vi.fn(() => "/tmp/pi-agent"),
    resolveCliModel: pi.resolveCliModel
  };
});

type Deferred<T> = Promise<T> & { resolve(value: T): void; reject(reason: unknown): void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }) as Deferred<T>;
  promise.resolve = resolve;
  promise.reject = reject;
  return promise;
}

function logger() { return { info: vi.fn(), error: vi.fn() }; }

function assistantSession(text: string, selectedModel = { provider: "actual-provider", id: "actual-model" }) {
  const subscribers = new Set<(event: any) => void>();
  const prompts: string[] = [];
  return {
    state: { model: selectedModel },
    prompts,
    dispose: vi.fn(),
    subscribe(listener: (event: any) => void) { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
    async prompt(prompt: string) {
      prompts.push(prompt);
      for (const subscriber of subscribers) subscriber({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
    }
  };
}

const originalTutorModel = process.env.TUTOR_MODEL;
const originalPracticeCoachModel = process.env.PRACTICE_COACH_MODEL;

beforeEach(() => {
  pi.createAgentSession.mockReset();
  pi.resolveCliModel.mockReset();
  pi.hasConfiguredAuth.mockReset();
  pi.loaders.splice(0);
  pi.settings.splice(0);
  pi.sessionManagers.splice(0);
  pi.resolveCliModel.mockReturnValue({ model: { provider: "requested-provider", id: "requested-model" } });
  pi.hasConfiguredAuth.mockReturnValue(true);
});

afterEach(() => {
  if (originalTutorModel === undefined) delete process.env.TUTOR_MODEL;
  else process.env.TUTOR_MODEL = originalTutorModel;
  if (originalPracticeCoachModel === undefined) delete process.env.PRACTICE_COACH_MODEL;
  else process.env.PRACTICE_COACH_MODEL = originalPracticeCoachModel;
});

describe("workbook model preflight coordinator", () => {
  it("starts both role probes before either settles and waits for both successes", async () => {
    const main = deferred<any>();
    const coach = deferred<any>();
    const events: string[] = [];
    const { preflightWorkbookModels } = await import("../src/workbook/model-preflight.js");

    const preflight = preflightWorkbookModels({
      contentRoot: "/content",
      workspaceRoot: "/workspace",
      logger: logger(),
      probeRole: (request) => {
        events.push(`start:${request.role}`);
        return request.role === "Main Tutor" ? main : coach;
      }
    });
    let completed = false;
    void preflight.then(() => { completed = true; });
    await Promise.resolve();

    expect(events).toEqual(["start:Main Tutor", "start:Practice Coach"]);
    main.resolve({ role: "Main Tutor", envVar: "TUTOR_MODEL", selectedModel: { provider: "same", id: "model" } });
    await Promise.resolve();
    expect(completed).toBe(false);

    coach.resolve({ role: "Practice Coach", envVar: "PRACTICE_COACH_MODEL", selectedModel: { provider: "same", id: "model" } });
    await expect(preflight).resolves.toHaveLength(2);
    expect(completed).toBe(true);
  });

  it("rejects on the first known role failure before the unresolved sibling settles", async () => {
    const main = deferred<any>();
    const coach = deferred<any>();
    const { preflightWorkbookModels, WorkbookModelPreflightError } = await import("../src/workbook/model-preflight.js");
    const preflight = preflightWorkbookModels({
      contentRoot: "/content",
      workspaceRoot: "/workspace",
      logger: logger(),
      probeRole: (request) => request.role === "Main Tutor" ? main : coach
    });
    await Promise.resolve();

    main.reject(new Error("usage limit reached"));

    await expect(preflight).rejects.toMatchObject({
      role: "Main Tutor",
      envVar: "TUTOR_MODEL",
      message: expect.stringContaining("usage limit reached")
    });
    await expect(preflight).rejects.toBeInstanceOf(WorkbookModelPreflightError);

    coach.reject(new Error("late sibling failure is observed by Promise.all"));
    await Promise.resolve();
  });

  it("does not deduplicate identical configured model identities", async () => {
    const starts: string[] = [];
    const { preflightWorkbookModels } = await import("../src/workbook/model-preflight.js");

    await preflightWorkbookModels({
      contentRoot: "/content",
      workspaceRoot: "/workspace",
      logger: logger(),
      environment: { TUTOR_MODEL: "provider/model", PRACTICE_COACH_MODEL: "provider/model" } as any,
      probeRole: async (request) => {
        starts.push(`${request.role}:${request.environment[request.envVar]}`);
        return { role: request.role, envVar: request.envVar, requested: request.environment[request.envVar], selectedModel: { provider: "provider", id: "model" } };
      }
    });

    expect(starts).toEqual(["Main Tutor:provider/model", "Practice Coach:provider/model"]);
  });

  it("includes the role, environment variable, actual model, and provider reason in diagnostics", async () => {
    const { WorkbookModelPreflightError } = await import("../src/workbook/model-preflight.js");

    const error = new WorkbookModelPreflightError({
      role: "Practice Coach",
      envVar: "PRACTICE_COACH_MODEL",
      requested: "anthropic/claude-sonnet",
      requestedModel: { provider: "anthropic", id: "claude-sonnet" },
      selectedModel: { provider: "anthropic", id: "claude-sonnet-4-5" },
      cause: new Error("usage limit exceeded")
    });

    expect(error.message).toContain("Practice Coach");
    expect(error.message).toContain("PRACTICE_COACH_MODEL=\"anthropic/claude-sonnet\"");
    expect(error.message).toContain("selected anthropic/claude-sonnet-4-5");
    expect(error.message).toContain("usage limit exceeded");
  });
});

describe("Pi-backed workbook model role probe", () => {
  it("uses a bare one-attempt session, requires non-empty assistant text, reports the selected model, and disposes", async () => {
    process.env.TUTOR_MODEL = "requested-provider/requested-model";
    const session = assistantSession("ok", { provider: "selected-provider", id: "selected-model" });
    pi.createAgentSession.mockResolvedValueOnce({ session });
    const { probePiWorkbookRoleModel } = await import("../src/workbook/model-preflight.js");

    await expect(probePiWorkbookRoleModel({
      role: "Main Tutor",
      envVar: "TUTOR_MODEL",
      contentRoot: "/content",
      workspaceRoot: "/workspace",
      logger: logger(),
      environment: process.env
    })).resolves.toMatchObject({
      role: "Main Tutor",
      envVar: "TUTOR_MODEL",
      requested: "requested-provider/requested-model",
      requestedModel: { provider: "requested-provider", id: "requested-model" },
      selectedModel: { provider: "selected-provider", id: "selected-model" }
    });

    expect(session.prompts).toHaveLength(1);
    expect(session.prompts[0]).not.toContain("requested-provider/requested-model");
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(pi.createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/workspace",
      customTools: [],
      tools: [],
      noTools: "all",
      sessionManager: expect.anything(),
      settingsManager: expect.anything()
    }));
    expect(pi.loaders[0]).toEqual(expect.objectContaining({
      cwd: "/workspace",
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: []
    }));
    expect(pi.settings[0]).toEqual(expect.objectContaining({
      compaction: { enabled: false },
      retry: { enabled: false },
      packages: [],
      extensions: [],
      skills: [],
      prompts: [],
      themes: []
    }));
  });

  it("rejects empty assistant completions and still disposes the probe session", async () => {
    const session = assistantSession("   ", { provider: "selected", id: "model" });
    pi.createAgentSession.mockResolvedValueOnce({ session });
    const { probePiWorkbookRoleModel, WorkbookModelPreflightError } = await import("../src/workbook/model-preflight.js");

    const promise = probePiWorkbookRoleModel({
      role: "Practice Coach",
      envVar: "PRACTICE_COACH_MODEL",
      contentRoot: "/content",
      workspaceRoot: "/workspace",
      logger: logger(),
      environment: process.env
    });

    await expect(promise).rejects.toMatchObject({
      role: "Practice Coach",
      envVar: "PRACTICE_COACH_MODEL",
      selectedModel: { provider: "selected", id: "model" },
      message: expect.stringContaining("empty assistant completion")
    });
    await expect(promise).rejects.toBeInstanceOf(WorkbookModelPreflightError);
    expect(session.dispose).toHaveBeenCalledOnce();
  });
});
