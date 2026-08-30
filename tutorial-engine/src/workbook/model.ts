import { resolveCliModel, type ModelRuntime, type ScopedModel } from "@earendil-works/pi-coding-agent";

export const TUTOR_MODEL_ENV = "TUTOR_MODEL";

export type WorkbookModelEnvironment = Readonly<Record<string, string | undefined>>;

/** Copy caller-provided model environment once so concurrent tutor/coach instances do not share mutable ambient state. */
export function snapshotWorkbookModelEnvironment(environment: WorkbookModelEnvironment): WorkbookModelEnvironment {
  const snapshot: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) if (typeof value === "string") snapshot[key] = value;
  return Object.freeze(snapshot);
}

/** Pi chooses its configured default when no usable tutor model is requested. */
export interface TutorModelChoice extends Partial<ScopedModel> {
  /** The configured model that matched the environment request, even when not usable for selection. */
  requestedModel?: ScopedModel["model"];
  warning?: string;
}

function resolveConfiguredTutorModel(modelRuntime: ModelRuntime, requested: string | undefined, envName: string): TutorModelChoice {
  const wanted = requested?.trim();
  if (!wanted) return {};
  const resolved = resolveCliModel({ cliModel: wanted, modelRuntime });
  if (!resolved.model) return { warning: `${envName}="${wanted}" did not match a model (${resolved.error ?? "no match"}); letting Pi choose.` };
  if (!modelRuntime.hasConfiguredAuth(resolved.model.provider)) {
    return { requestedModel: resolved.model, warning: `${envName}="${wanted}" matched ${resolved.model.provider}/${resolved.model.id}, which has no configured auth; letting Pi choose.` };
  }
  return { model: resolved.model, requestedModel: resolved.model, thinkingLevel: resolved.thinkingLevel, warning: resolved.warning };
}

export function resolveTutorModel(modelRuntime: ModelRuntime, requested: string | undefined): TutorModelChoice {
  return resolveConfiguredTutorModel(modelRuntime, requested, TUTOR_MODEL_ENV);
}
