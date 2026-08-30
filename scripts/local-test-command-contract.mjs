const ENGINE_WORKSPACE = "tutorial-engine";
const CALCULATOR_WORKSPACE = "tutorial/workspaces/refactor-line/calculator";
const WORKBOOK_EVAL_MODULE = "evals/workbook/run.ts";

const WIRING_PLANNED = "planned";
const WIRING_WIRED = "wired";
const ROOT_PACKAGE = "root";

export const ROOT_TEST_COMMAND_ORDER = Object.freeze([
  "test",
  "test:fast",
  "test:engine",
  "test:engine:fast",
  "test:workbook",
  "test:workbook:fast",
  "eval:engine",
  "eval:workbook"
]);

function freezeStep({
  command,
  workspace,
  script,
  shell,
  report,
  releaseArgs = [],
  forwardsArguments = false,
  implementation = "package-script",
  module,
  requiresDocker = false,
  requiresCanonicalDevcontainer = false,
  visual = false
}) {
  return Object.freeze({
    command,
    workspace,
    script,
    shell,
    report,
    releaseArgs: Object.freeze([...releaseArgs]),
    forwardsArguments,
    implementation,
    module,
    requiresDocker,
    requiresCanonicalDevcontainer,
    visual
  });
}

const engineWorkspaceStep = ({ command, script, shell, report, releaseArgs = [], forwardsArguments = false, requiresDocker = false, requiresCanonicalDevcontainer = false, visual = false }) => freezeStep({
  command,
  workspace: ENGINE_WORKSPACE,
  script,
  shell,
  report,
  releaseArgs,
  forwardsArguments,
  implementation: "workspace-package-script",
  requiresDocker,
  requiresCanonicalDevcontainer,
  visual
});

const rootStep = ({ command, script, shell, report, releaseArgs = [], forwardsArguments = false, requiresDocker = false, requiresCanonicalDevcontainer = false, visual = false }) => freezeStep({
  command,
  workspace: undefined,
  script,
  shell,
  report,
  releaseArgs,
  forwardsArguments,
  implementation: "root-package-script",
  requiresDocker,
  requiresCanonicalDevcontainer,
  visual
});

const rootModuleStep = ({ command, module, shell, report, releaseArgs = [], forwardsArguments = false, requiresDocker = false }) => freezeStep({
  command,
  workspace: undefined,
  script: undefined,
  shell,
  report,
  releaseArgs,
  forwardsArguments,
  implementation: "root-module-command",
  module,
  requiresDocker,
  requiresCanonicalDevcontainer: false,
  visual: false
});

function packageScript({ packageName = ROOT_PACKAGE, workspace, script, status, command, notes = [] }) {
  return Object.freeze({
    packageName,
    workspace,
    script,
    status,
    command,
    notes: Object.freeze([...notes])
  });
}

function commandContract({
  name,
  owner,
  purpose,
  deterministic,
  modelFree,
  spendsTokens,
  requiresDocker,
  requiresCanonicalDevcontainer = false,
  packageScript: packageScriptExpectation,
  execution = Object.freeze({ mode: "ordered-short-circuit" }),
  steps,
  notes = []
}) {
  return Object.freeze({
    name,
    owner,
    purpose,
    deterministic,
    modelFree,
    spendsTokens,
    requiresDocker,
    requiresCanonicalDevcontainer,
    packageScript: packageScriptExpectation,
    execution,
    steps: Object.freeze(steps),
    notes: Object.freeze(notes)
  });
}

const liveEvalCostNote = "Live eval costs spend model tokens for Main Tutor, Practice Coach, and Judge.";
const notYetWiredNote = "Specified for a later package-script wiring task; current package manifests must not be treated as implementing this command yet.";

export const PACKAGE_SCRIPT_WIRING_CONTRACT = Object.freeze([
  packageScript({ script: "test", status: WIRING_PLANNED, notes: ["Will use an orchestrator so release lanes continue and aggregate independent reports instead of relying on &&."] }),
  packageScript({ script: "test:fast", status: WIRING_PLANNED }),
  packageScript({ script: "test:engine", status: WIRING_PLANNED }),
  packageScript({ script: "test:engine:fast", status: WIRING_PLANNED, command: "npm run --workspace=tutorial-engine test:fast --" }),
  packageScript({ script: "test:workbook", status: WIRING_PLANNED }),
  packageScript({ script: "test:workbook:fast", status: WIRING_PLANNED }),
  packageScript({ script: "check:eval:workbook", status: WIRING_WIRED, command: "tsc -p evals/workbook/tsconfig.json" }),
  packageScript({ script: "test:eval:workbook", status: WIRING_WIRED, command: "vitest run evals/workbook/test/*.test.ts" }),
  packageScript({ script: "eval:engine", status: WIRING_WIRED, command: "npm run --workspace=tutorial-engine eval --" }),
  packageScript({ script: "eval:workbook", status: WIRING_WIRED, command: `tsx ${WORKBOOK_EVAL_MODULE}` }),
  packageScript({ packageName: "tutorial-engine", workspace: ENGINE_WORKSPACE, script: "test:fast", status: WIRING_PLANNED })
]);

const packageScriptByKey = new Map(PACKAGE_SCRIPT_WIRING_CONTRACT.map((entry) => [`${entry.packageName}:${entry.script}`, entry]));
const rootPackageScript = (script) => packageScriptByKey.get(`${ROOT_PACKAGE}:${script}`);

export const LOCAL_TEST_COMMAND_CONTRACT = Object.freeze({
  version: 1,
  engineWorkspace: ENGINE_WORKSPACE,
  wiringStatuses: Object.freeze({ planned: WIRING_PLANNED, wired: WIRING_WIRED }),
  rootCommands: Object.freeze({
    test: commandContract({
      name: "test",
      owner: "root",
      purpose: "Complete local release gate: deterministic fast checks, canonical visual validation, then separately reported live engine and authored-workbook evals.",
      deterministic: false,
      modelFree: false,
      spendsTokens: true,
      requiresDocker: true,
      requiresCanonicalDevcontainer: true,
      packageScript: rootPackageScript("test"),
      execution: Object.freeze({
        mode: "continue-and-aggregate-independent-lanes",
        plainAndChainSafe: false,
        reports: Object.freeze(["deterministic-fast", "canonical-visual", "live-engine-eval", "authored-workbook-eval"])
      }),
      steps: [
        rootStep({ command: "test:fast", script: "test:fast", shell: "npm run test:fast", report: "deterministic-fast" }),
        engineWorkspaceStep({ command: "test:visual", script: "test:visual", shell: "npm run --workspace=tutorial-engine test:visual", report: "canonical-visual", requiresDocker: true, requiresCanonicalDevcontainer: true, visual: true }),
        rootStep({ command: "eval:engine", script: "eval:engine", shell: "npm run eval:engine -- --release", report: "live-engine-eval", releaseArgs: ["--release"], requiresDocker: true }),
        rootStep({ command: "eval:workbook", script: "eval:workbook", shell: "npm run eval:workbook -- --release", report: "authored-workbook-eval", releaseArgs: ["--release"], requiresDocker: true })
      ],
      notes: [
        "The visual lane is canonical, engine-owned, and requires the canonical repository devcontainer in addition to Docker.",
        "The release gate must continue all independent lanes and aggregate their named reports; it is not implementable as a plain && chain.",
        liveEvalCostNote
      ]
    }),

    "test:fast": commandContract({
      name: "test:fast",
      owner: "root",
      purpose: "Fast deterministic developer loop for engine mechanics, authored workbook checks, authored evaluator foundations, and calculator exercises.",
      deterministic: true,
      modelFree: true,
      spendsTokens: false,
      requiresDocker: false,
      packageScript: rootPackageScript("test:fast"),
      steps: [
        rootStep({ command: "test:engine:fast", script: "test:engine:fast", shell: "npm run test:engine:fast" }),
        rootStep({ command: "test:workbook:fast", script: "test:workbook:fast", shell: "npm run test:workbook:fast" })
      ],
      notes: ["This command must stay deterministic, model-free, and Docker-free.", notYetWiredNote]
    }),

    "test:engine": commandContract({
      name: "test:engine",
      owner: "root-delegates-to-engine",
      purpose: "Engine release lane: deterministic engine checks, canonical visual validation, and the bounded live engine eval.",
      deterministic: false,
      modelFree: false,
      spendsTokens: true,
      requiresDocker: true,
      requiresCanonicalDevcontainer: true,
      packageScript: rootPackageScript("test:engine"),
      steps: [
        engineWorkspaceStep({ command: "test:fast", script: "test:fast", shell: "npm run --workspace=tutorial-engine test:fast", report: "engine-fast" }),
        engineWorkspaceStep({ command: "test:visual", script: "test:visual", shell: "npm run --workspace=tutorial-engine test:visual", report: "canonical-visual", requiresDocker: true, requiresCanonicalDevcontainer: true, visual: true }),
        engineWorkspaceStep({ command: "eval", script: "eval", shell: "npm run --workspace=tutorial-engine eval -- --release", report: "live-engine-eval", releaseArgs: ["--release"], requiresDocker: true })
      ],
      notes: [liveEvalCostNote, notYetWiredNote]
    }),

    "test:engine:fast": commandContract({
      name: "test:engine:fast",
      owner: "root-delegates-to-engine",
      purpose: "Deterministic model-free engine checks owned by tutorial-engine.",
      deterministic: true,
      modelFree: true,
      spendsTokens: false,
      requiresDocker: false,
      packageScript: rootPackageScript("test:engine:fast"),
      steps: [
        engineWorkspaceStep({ command: "test:fast", script: "test:fast", shell: "npm run --workspace=tutorial-engine test:fast --", forwardsArguments: true })
      ],
      notes: ["Root package wiring must use --workspace=tutorial-engine for this command.", "The target tutorial-engine test:fast script is specified but intentionally not wired yet."]
    }),

    "test:workbook": commandContract({
      name: "test:workbook",
      owner: "root",
      purpose: "Authored-workbook release lane: deterministic workbook checks plus the bounded authored-workbook live eval.",
      deterministic: false,
      modelFree: false,
      spendsTokens: true,
      requiresDocker: true,
      packageScript: rootPackageScript("test:workbook"),
      steps: [
        rootStep({ command: "test:workbook:fast", script: "test:workbook:fast", shell: "npm run test:workbook:fast", report: "workbook-fast" }),
        rootStep({ command: "eval:workbook", script: "eval:workbook", shell: "npm run eval:workbook -- --release", report: "authored-workbook-eval", releaseArgs: ["--release"], requiresDocker: true })
      ],
      notes: [liveEvalCostNote, "This release lane requires Docker for the live authored-workbook eval but does not require the canonical visual devcontainer.", notYetWiredNote]
    }),

    "test:workbook:fast": commandContract({
      name: "test:workbook:fast",
      owner: "root",
      purpose: "Deterministic authored-workbook structure, launcher, evaluator-foundation, and learner-workspace checks.",
      deterministic: true,
      modelFree: true,
      spendsTokens: false,
      requiresDocker: false,
      packageScript: rootPackageScript("test:workbook:fast"),
      steps: [
        rootStep({ command: "test:onboarding", script: "test:onboarding", shell: "npm run test:onboarding" }),
        rootStep({ command: "check:eval:workbook", script: "check:eval:workbook", shell: "npm run check:eval:workbook" }),
        rootStep({ command: "test:eval:workbook", script: "test:eval:workbook", shell: "npm run test:eval:workbook" }),
        engineWorkspaceStep({ command: "check:workbook", script: "check:workbook", shell: "npm run --workspace=tutorial-engine check:workbook" }),
        freezeStep({
          command: "calculator:test",
          workspace: CALCULATOR_WORKSPACE,
          script: "test",
          shell: "npm run --workspace=tutorial/workspaces/refactor-line/calculator test",
          report: undefined,
          releaseArgs: [],
          forwardsArguments: false,
          implementation: "workspace-package-script"
        })
      ],
      notes: ["This command must stay deterministic, model-free, and Docker-free while covering all authored workbook and authored evaluator foundations.", notYetWiredNote]
    }),

    "eval:engine": commandContract({
      name: "eval:engine",
      owner: "root-delegates-to-engine",
      purpose: "Live synthetic engine eval; forwards all arguments to the tutorial-engine evaluator.",
      deterministic: false,
      modelFree: false,
      spendsTokens: true,
      requiresDocker: true,
      packageScript: rootPackageScript("eval:engine"),
      steps: [
        engineWorkspaceStep({ command: "eval", script: "eval", shell: "npm run --workspace=tutorial-engine eval --", forwardsArguments: true, requiresDocker: true })
      ],
      notes: [liveEvalCostNote, "This root package script is currently wired and forwards through --workspace=tutorial-engine."]
    }),

    "eval:workbook": commandContract({
      name: "eval:workbook",
      owner: "root",
      purpose: "Live authored-workbook eval for learner curriculum outcomes; forwards arguments to the authored-workbook evaluator module.",
      deterministic: false,
      modelFree: false,
      spendsTokens: true,
      requiresDocker: true,
      packageScript: rootPackageScript("eval:workbook"),
      steps: [
        rootModuleStep({ command: "eval:workbook", module: WORKBOOK_EVAL_MODULE, shell: `tsx ${WORKBOOK_EVAL_MODULE}`, forwardsArguments: true, requiresDocker: true })
      ],
      notes: [liveEvalCostNote, `Package implementation is a direct root module command (tsx ${WORKBOOK_EVAL_MODULE}), not npm run eval:workbook as a self-delegating step.`]
    })
  }),
  compatibility: Object.freeze({
    check: Object.freeze({
      command: "check",
      delegatesTo: "test:fast",
      policy: "compatibility-alias",
      deterministic: true,
      modelFree: true,
      spendsTokens: false,
      requiresDocker: false,
      requiresCanonicalDevcontainer: false,
      notes: Object.freeze([
        "Keep npm run check supported for existing docs and developer muscle memory.",
        "Do not add eval:engine, eval:workbook, tutor, or judge calls to npm run check.",
        "After root test wiring lands, package.json should make check a direct alias of test:fast."
      ])
    })
  })
});

export function rootCommandNames() {
  return [...ROOT_TEST_COMMAND_ORDER];
}

export function rootCommandContract(name) {
  const command = LOCAL_TEST_COMMAND_CONTRACT.rootCommands[name];
  if (!command) {
    throw new Error(`Unknown local test command: ${name}`);
  }
  return command;
}

export function rootTestReleaseReports() {
  return rootCommandContract("test").steps.map((step) => step.report).filter(Boolean);
}

export function workspaceDelegationCommand(name) {
  const command = rootCommandContract(name);
  const workspaceStep = command.steps.find((step) => step.workspace === ENGINE_WORKSPACE);
  if (!workspaceStep) {
    throw new Error(`${name} does not delegate to ${ENGINE_WORKSPACE}`);
  }
  return workspaceStep.shell;
}

function manifestScriptsFor(entry, manifests) {
  if (entry.workspace === ENGINE_WORKSPACE || entry.packageName === "tutorial-engine") return manifests.engine?.scripts ?? {};
  return manifests.root?.scripts ?? {};
}

export function packageScriptWiringReport(manifests) {
  return PACKAGE_SCRIPT_WIRING_CONTRACT.map((entry) => {
    const actual = manifestScriptsFor(entry, manifests)[entry.script];
    const present = typeof actual === "string";
    const matchesExpectedCommand = typeof entry.command === "string" && actual === entry.command;
    const aligned = entry.status === WIRING_WIRED ? matchesExpectedCommand : !present;
    return Object.freeze({
      packageName: entry.packageName,
      workspace: entry.workspace,
      script: entry.script,
      status: entry.status,
      expectedCommand: entry.command,
      actual,
      present,
      matchesExpectedCommand,
      aligned
    });
  });
}

export function validatePackageScriptWiring(manifests) {
  const report = packageScriptWiringReport(manifests);
  const failures = report.filter((entry) => !entry.aligned);
  return Object.freeze({ ok: failures.length === 0, failures: Object.freeze(failures), report: Object.freeze(report) });
}
