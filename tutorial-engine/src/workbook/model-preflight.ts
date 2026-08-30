import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir
} from "@earendil-works/pi-coding-agent";
import { TUTOR_MODEL_ENV, resolveTutorModel, snapshotWorkbookModelEnvironment, type WorkbookModelEnvironment } from "./model.js";
import { createResilientTutorSession, type PiTutorSession, type ResilientTutorSession } from "./pi-tutor-session.js";
import { isTutorInfrastructureError } from "./tutor-infrastructure.js";
import type { TutorialLogger } from "./runtime-log.js";

export type WorkbookModelBackedRole = "Main Tutor";

export interface WorkbookModelIdentity {
  provider: string;
  id: string;
}

export interface WorkbookModelPreflightResult {
  role: WorkbookModelBackedRole;
  envVar: typeof TUTOR_MODEL_ENV;
  requested?: string;
  requestedModel?: WorkbookModelIdentity;
  selectedModel?: WorkbookModelIdentity;
}

export interface WorkbookModelPreflightErrorDetails extends WorkbookModelPreflightResult {
  cause: unknown;
}

function reason(cause: unknown): string {
  if (isTutorInfrastructureError(cause) && cause.cause instanceof Error) return cause.cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}

function modelLabel(model: WorkbookModelIdentity | undefined): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

function formatPreflightMessage(details: WorkbookModelPreflightErrorDetails): string {
  const requestedEnv = details.requested?.trim()
    ? `${details.envVar}="${details.requested.trim()}"`
    : `${details.envVar} unset (Pi default)`;
  const requested = modelLabel(details.requestedModel);
  const selected = modelLabel(details.selectedModel);
  const modelBits = [
    requested ? `requested ${requested}` : undefined,
    selected ? `selected ${selected}` : undefined
  ].filter((bit): bit is string => Boolean(bit));
  const modelText = modelBits.length ? ` (${modelBits.join(", ")})` : "";
  return `${details.role} model preflight failed for ${requestedEnv}${modelText}: ${reason(details.cause)}`;
}

export class WorkbookModelPreflightError extends Error implements WorkbookModelPreflightResult {
  readonly role: WorkbookModelBackedRole;
  readonly envVar: typeof TUTOR_MODEL_ENV;
  readonly requested?: string;
  readonly requestedModel?: WorkbookModelIdentity;
  readonly selectedModel?: WorkbookModelIdentity;
  override readonly cause: unknown;

  constructor(details: WorkbookModelPreflightErrorDetails) {
    super(formatPreflightMessage(details), { cause: details.cause });
    this.name = "WorkbookModelPreflightError";
    this.role = details.role;
    this.envVar = details.envVar;
    this.requested = details.requested;
    this.requestedModel = details.requestedModel;
    this.selectedModel = details.selectedModel;
    this.cause = details.cause;
  }
}

export interface WorkbookRolePreflightRequest {
  role: WorkbookModelBackedRole;
  envVar: typeof TUTOR_MODEL_ENV;
  contentRoot: string;
  workspaceRoot: string;
  logger: TutorialLogger;
  environment: WorkbookModelEnvironment;
  signal?: AbortSignal;
}

export type WorkbookRolePreflightProbe = (request: WorkbookRolePreflightRequest) => Promise<WorkbookModelPreflightResult>;

export interface WorkbookModelPreflightOptions {
  contentRoot: string;
  workspaceRoot: string;
  logger: TutorialLogger;
  environment?: WorkbookModelEnvironment;
  probeRole?: WorkbookRolePreflightProbe;
}

const PREFLIGHT_PROMPT = "Connectivity check for workbook startup. Reply with a short non-empty acknowledgement. Do not use tools.";
export const WORKBOOK_MODEL_PREFLIGHT_TIMEOUT_MS = 60_000;
const WORKBOOK_MODEL_PREFLIGHT_TIMEOUT_MESSAGE = "Workbook model preflight timed out before returning a bounded assistant completion.";

interface PiModelLike { provider: string; id: string }

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Workbook model preflight was cancelled.");
}

function identity(model: PiModelLike | undefined): WorkbookModelIdentity | undefined {
  return model ? { provider: model.provider, id: model.id } : undefined;
}

async function withModelPreflightTimeout<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleanupAbort = () => undefined as void;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new Error(WORKBOOK_MODEL_PREFLIGHT_TIMEOUT_MESSAGE)); }, WORKBOOK_MODEL_PREFLIGHT_TIMEOUT_MS);
    timer.unref?.();
  });
  const abort = new Promise<T>((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(new Error("Workbook model preflight was cancelled."));
      return;
    }
    const listener = () => reject(new Error("Workbook model preflight was cancelled."));
    signal.addEventListener("abort", listener, { once: true });
    cleanupAbort = () => signal.removeEventListener("abort", listener);
  });
  try { return await Promise.race([operation, timeout, abort]); }
  finally { cleanupAbort(); if (timer) clearTimeout(timer); }
}

export async function probePiWorkbookRoleModel(request: WorkbookRolePreflightRequest): Promise<WorkbookModelPreflightResult> {
  const requested = request.environment[request.envVar];
  let requestedModel: WorkbookModelIdentity | undefined;
  let selectedModel: WorkbookModelIdentity | undefined;
  let session: PiTutorSession | undefined;
  let resilient: ResilientTutorSession | undefined;
  try {
    throwIfAborted(request.signal);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      packages: [],
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
      enableSkillCommands: false
    });
    const loader = new DefaultResourceLoader({
      cwd: request.workspaceRoot,
      agentDir: getAgentDir(),
      settingsManager,
      systemPromptOverride: () => "You are a workbook startup connectivity probe. Answer only the user's connectivity check.",
      appendSystemPromptOverride: () => [],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      skillsOverride: () => ({ skills: [], diagnostics: [] }),
      promptsOverride: () => ({ prompts: [], diagnostics: [] }),
      themesOverride: () => ({ themes: [], diagnostics: [] }),
      extensionFactories: []
    });
    await loader.reload();
    throwIfAborted(request.signal);
    const modelRuntime = await ModelRuntime.create();
    throwIfAborted(request.signal);
    const choice = resolveTutorModel(modelRuntime, requested);
    requestedModel = identity(choice.requestedModel ?? choice.model);
    if (choice.warning) request.logger.info(choice.warning);
    throwIfAborted(request.signal);
    const created = await createAgentSession({
      cwd: request.workspaceRoot,
      resourceLoader: loader,
      customTools: [],
      tools: [],
      noTools: "all",
      modelRuntime,
      model: choice.model,
      thinkingLevel: choice.thinkingLevel,
      sessionManager: SessionManager.inMemory(request.workspaceRoot),
      settingsManager
    });
    const createdSession = created.session;
    session = createdSession;
    if (request.signal?.aborted) {
      createdSession.dispose();
      session = undefined;
      throwIfAborted(request.signal);
    }
    selectedModel = identity(createdSession.state.model ?? choice.model);
    resilient = createResilientTutorSession(createdSession, request.logger, `${request.role} preflight`);
    const response = await withModelPreflightTimeout(resilient.prompt(PREFLIGHT_PROMPT), request.signal);
    throwIfAborted(request.signal);
    if (!response.trim()) throw new Error(`${request.role} preflight returned an empty assistant completion.`);
    return { role: request.role, envVar: request.envVar, requested, requestedModel, selectedModel };
  } catch (cause) {
    throw new WorkbookModelPreflightError({ role: request.role, envVar: request.envVar, requested, requestedModel, selectedModel, cause });
  } finally {
    (resilient ?? session)?.dispose();
  }
}

function roleRequests(options: Required<Pick<WorkbookModelPreflightOptions, "contentRoot" | "workspaceRoot" | "logger">> & { environment: WorkbookModelEnvironment }): WorkbookRolePreflightRequest[] {
  return [
    { role: "Main Tutor", envVar: TUTOR_MODEL_ENV, contentRoot: options.contentRoot, workspaceRoot: options.workspaceRoot, logger: options.logger, environment: options.environment }
  ];
}

export async function preflightWorkbookModels(options: WorkbookModelPreflightOptions): Promise<WorkbookModelPreflightResult[]> {
  const environment = options.environment === undefined ? process.env : snapshotWorkbookModelEnvironment(options.environment);
  const probeRole = options.probeRole ?? probePiWorkbookRoleModel;
  const probes = roleRequests({ contentRoot: options.contentRoot, workspaceRoot: options.workspaceRoot, logger: options.logger, environment })
    .map(async (request) => {
      try {
        return await probeRole(request);
      } catch (cause) {
        if (cause instanceof WorkbookModelPreflightError) throw cause;
        throw new WorkbookModelPreflightError({ role: request.role, envVar: request.envVar, requested: environment[request.envVar], cause });
      }
    });
  return Promise.all(probes);
}
