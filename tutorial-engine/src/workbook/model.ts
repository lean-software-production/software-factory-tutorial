import { resolveCliModel, type ModelRuntime, type ScopedModel } from "@earendil-works/pi-coding-agent";

export const TUTOR_MODEL_ENV = "TUTOR_MODEL";
export const BLOCK_TUTOR_MODEL_ENV = "BLOCK_TUTOR_MODEL";

/** Pi chooses its configured default when no usable tutor model is requested. */
export interface TutorModelChoice extends Partial<ScopedModel> {
  warning?: string;
}

function resolveConfiguredTutorModel(modelRuntime: ModelRuntime, requested: string | undefined, envName: string): TutorModelChoice {
  const wanted = requested?.trim();
  if (!wanted) return {};
  const resolved = resolveCliModel({ cliModel: wanted, modelRuntime });
  if (!resolved.model) return { warning: `${envName}="${wanted}" did not match a model (${resolved.error ?? "no match"}); letting Pi choose.` };
  if (!modelRuntime.hasConfiguredAuth(resolved.model.provider)) {
    return { warning: `${envName}="${wanted}" matched ${resolved.model.provider}/${resolved.model.id}, which has no configured auth; letting Pi choose.` };
  }
  return { model: resolved.model, thinkingLevel: resolved.thinkingLevel, warning: resolved.warning };
}

export function resolveTutorModel(modelRuntime: ModelRuntime, requested: string | undefined): TutorModelChoice {
  return resolveConfiguredTutorModel(modelRuntime, requested, TUTOR_MODEL_ENV);
}

export function resolveBlockTutorModel(modelRuntime: ModelRuntime, requested: string | undefined): TutorModelChoice {
  const wanted = requested?.trim();
  if (!wanted) throw new Error(`${BLOCK_TUTOR_MODEL_ENV} must be set to enable the fast block tutor.`);
  const resolved = resolveCliModel({ cliModel: wanted, modelRuntime });
  if (!resolved.model) throw new Error(`${BLOCK_TUTOR_MODEL_ENV}="${wanted}" did not match a model (${resolved.error ?? "no match"}); fast block tutor disabled.`);
  if (!modelRuntime.hasConfiguredAuth(resolved.model.provider)) throw new Error(`${BLOCK_TUTOR_MODEL_ENV}="${wanted}" matched ${resolved.model.provider}/${resolved.model.id}, which has no configured auth; fast block tutor disabled.`);
  return { model: resolved.model, thinkingLevel: resolved.thinkingLevel, warning: resolved.warning };
}
