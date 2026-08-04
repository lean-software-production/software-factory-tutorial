#!/usr/bin/env node
import { ModelRuntime, SettingsManager, resolveCliModel } from "@earendil-works/pi-coding-agent";
import { stderr, stdout } from "node:process";

export async function checkPiAuthentication(getAvailable) {
  const models = await getAvailable();
  return { ready: models.length > 0 };
}

/**
 * The tutorial runs two agents on purpose, and they want opposite things.
 *
 * The tutor teaches, so it wants the largest model available; TUTOR_MODEL names
 * it. The doer the lessons drive with `pi -p` wants to be cheap and fast, and
 * its mistakes are teaching material, so it follows Pi's ordinary `/model`
 * default. Neither should silently become the other.
 *
 * tutorial-engine/src/agent/pi-adapter.ts resolves TUTOR_MODEL for real; this
 * mirrors it so `npm run setup` can report what the tutor will do.
 */
export const TUTOR_MODEL_ENV = "TUTOR_MODEL";

export function describeDoerModel({ defaultProvider, defaultModel, available }) {
  const choices = available.length;
  if (!defaultProvider || !defaultModel) return { pinned: false, reason: "no-default", choices };
  const saved = `${defaultProvider}/${defaultModel}`;
  const authenticated = available.some((model) => model.provider === defaultProvider && model.id === defaultModel);
  return authenticated ? { pinned: true, model: saved } : { pinned: false, reason: "not-authenticated", saved, choices };
}

export function describeTutorModel({ requested, resolve }) {
  const wanted = requested?.trim();
  if (!wanted) return { pinned: false, reason: "no-default" };
  const resolved = resolve(wanted);
  if (!resolved.model) return { pinned: false, reason: "no-match", requested: wanted };
  if (!resolved.authenticated) {
    return { pinned: false, reason: "not-authenticated", requested: wanted, saved: `${resolved.model.provider}/${resolved.model.id}` };
  }
  return { pinned: true, model: `${resolved.model.provider}/${resolved.model.id}` };
}

function doerLine(description) {
  if (description.pinned) return description.model;
  if (description.reason === "not-authenticated") {
    return `Pi chooses from the ${description.choices} authenticated models; its saved default ${description.saved} is not one of them`;
  }
  return `Pi chooses from the ${description.choices} authenticated models, because no default is saved`;
}

function tutorLine(description) {
  if (description.pinned) return `${description.model} (${TUTOR_MODEL_ENV})`;
  if (description.reason === "no-match") {
    return `Pi chooses; ${TUTOR_MODEL_ENV}="${description.requested}" matches no model`;
  }
  if (description.reason === "not-authenticated") {
    return `Pi chooses; ${TUTOR_MODEL_ENV}="${description.requested}" matches ${description.saved}, which is not authenticated`;
  }
  return `Pi chooses, because ${TUTOR_MODEL_ENV} is unset`;
}

export function modelReport(tutor, doer) {
  return [
    `Tutor model: ${tutorLine(tutor)}`,
    `Doer model:  ${doerLine(doer)}`,
    "",
    `Give the tutor a capable model by exporting ${TUTOR_MODEL_ENV}=<provider>/<model>; 'pi --list-models' lists what you can name.`,
    "Choose the doer's model with 'pi', then '/model'. A small, fast one is the point: the lessons teach you to catch its mistakes."
  ];
}

async function main() {
  const runtime = await ModelRuntime.create();
  const available = await runtime.getAvailable();
  const result = await checkPiAuthentication(() => available);
  if (!result.ready) {
    stderr.write("Pi has no authenticated model. Run 'pi', then enter '/login' and choose a provider.\n");
    process.exitCode = 1;
    return;
  }
  stdout.write("Pi is authenticated and ready for the tutorial.\n");
  const settings = SettingsManager.create(process.cwd()).getGlobalSettings();
  const report = modelReport(
    describeTutorModel({
      requested: process.env[TUTOR_MODEL_ENV],
      resolve: (cliModel) => {
        const { model } = resolveCliModel({ cliModel, modelRuntime: runtime });
        return { model, authenticated: model ? runtime.hasConfiguredAuth(model.provider) : false };
      }
    }),
    describeDoerModel({
      defaultProvider: settings.defaultProvider,
      defaultModel: settings.defaultModel,
      available
    })
  );
  stdout.write(`${report.join("\n")}\n`);
}

if (import.meta.main) {
  main().catch((error) => {
    stderr.write(`Unable to check Pi authentication: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
