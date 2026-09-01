const ENGINE_WORKSPACE = "tutorial-engine";

const WIRING_PLANNED = "planned";
const WIRING_WIRED = "wired";
const ROOT_PACKAGE = "root";

export const ROOT_TEST_COMMAND_ORDER = Object.freeze([
  "test",
  "test:fast",
  "test:engine",
  "test:engine:fast",
  "test:workbook:fast",
  "check:workbook",
  "eval:engine"
]);

function freezeStep({
  command,
  workspace,
  script,
  shell,
  report,
  reportTarget,
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
    reportTarget,
    releaseArgs: Object.freeze([...releaseArgs]),
    forwardsArguments,
    implementation,
    module,
    requiresDocker,
    requiresCanonicalDevcontainer,
    visual
  });
}

const engineWorkspaceStep = ({ command, script, shell, report, reportTarget, releaseArgs = [], forwardsArguments = false, requiresDocker = false, requiresCanonicalDevcontainer = false, visual = false }) => freezeStep({
  command,
  workspace: ENGINE_WORKSPACE,
  script,
  shell,
  report,
  reportTarget,
  releaseArgs,
  forwardsArguments,
  implementation: "workspace-package-script",
  requiresDocker,
  requiresCanonicalDevcontainer,
  visual
});

const rootStep = ({ command, script, shell, report, reportTarget, releaseArgs = [], forwardsArguments = false, requiresDocker = false, requiresCanonicalDevcontainer = false, visual = false }) => freezeStep({
  command,
  workspace: undefined,
  script,
  shell,
  report,
  reportTarget,
  releaseArgs,
  forwardsArguments,
  implementation: "root-package-script",
  requiresDocker,
  requiresCanonicalDevcontainer,
  visual
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

const liveEngineEvalCostNote = "Live engine evals spend model tokens for the selected engine tutor and judge roles.";

export const PACKAGE_SCRIPT_WIRING_CONTRACT = Object.freeze([
  packageScript({ script: "test", status: WIRING_WIRED, command: "node scripts/run-local-tests.mjs test", notes: ["Uses the root orchestrator so release lanes continue and aggregate independent reports instead of relying on &&."] }),
  packageScript({ script: "test:fast", status: WIRING_WIRED, command: "node scripts/run-local-tests.mjs test:fast" }),
  packageScript({ script: "test:engine", status: WIRING_WIRED, command: "node scripts/run-local-tests.mjs test:engine" }),
  packageScript({ script: "test:engine:fast", status: WIRING_WIRED, command: "npm run --workspace=tutorial-engine test:fast --" }),
  packageScript({ script: "test:workbook:fast", status: WIRING_WIRED, command: "node scripts/run-local-tests.mjs test:workbook:fast" }),
  packageScript({ script: "check:workbook", status: WIRING_WIRED, command: "npm run --workspace=tutorial-engine check:workbook -- ../tutorial" }),
  packageScript({ script: "eval:engine", status: WIRING_WIRED, command: "npm run --workspace=tutorial-engine eval --" }),
  packageScript({ packageName: "tutorial-engine", workspace: ENGINE_WORKSPACE, script: "build:typescript", status: WIRING_WIRED, command: "rm -rf dist && tsc -p tsconfig.json" }),
  packageScript({ packageName: "tutorial-engine", workspace: ENGINE_WORKSPACE, script: "build", status: WIRING_WIRED, command: "npm run build:typescript && npm run build:web:workbook" }),
  packageScript({ packageName: "tutorial-engine", workspace: ENGINE_WORKSPACE, script: "test:fast", status: WIRING_WIRED, command: "npm run lint && tsc -p tsconfig.check.json && npm run check:eval && npm run test && npm run build:web:workbook && npm run browser:smoke" }),
  packageScript({ packageName: "tutorial-engine", workspace: ENGINE_WORKSPACE, script: "check", status: WIRING_WIRED, command: "npm run build:typescript && npm run test:fast && npm run check:workbook-terminal-image" }),
  packageScript({ packageName: "tutorial-engine", workspace: ENGINE_WORKSPACE, script: "prepublishOnly", status: WIRING_WIRED, command: "npm run check" })
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
      purpose: "Complete local release gate: deterministic fast checks, canonical visual validation, then the synthetic engine live eval.",
      deterministic: false,
      modelFree: false,
      spendsTokens: true,
      requiresDocker: true,
      requiresCanonicalDevcontainer: true,
      packageScript: rootPackageScript("test"),
      execution: Object.freeze({
        mode: "continue-and-aggregate-independent-lanes",
        plainAndChainSafe: false,
        reports: Object.freeze(["deterministic-fast", "canonical-visual", "live-engine-eval"])
      }),
      steps: [
        rootStep({ command: "test:fast", script: "test:fast", shell: "npm run test:fast", report: "deterministic-fast" }),
        engineWorkspaceStep({ command: "test:visual", script: "test:visual", shell: "npm run --workspace=tutorial-engine test:visual", report: "canonical-visual", reportTarget: "tutorial-engine/test/visual/*.received.png", requiresDocker: true, requiresCanonicalDevcontainer: true, visual: true }),
        rootStep({ command: "eval:engine", script: "eval:engine", shell: "npm run eval:engine -- --release", report: "live-engine-eval", reportTarget: "tutorial-engine/evals/reports/latest.json", releaseArgs: ["--release"], requiresDocker: true })
      ],
      notes: [
        "The visual lane is canonical, engine-owned, and requires the canonical repository devcontainer in addition to Docker.",
        "The release gate must continue all independent lanes and aggregate their named reports; it is not implementable as a plain && chain.",
        "Authored tutorial content is not a deterministic or paid release-eval lane.",
        liveEngineEvalCostNote
      ]
    }),

    "test:fast": commandContract({
      name: "test:fast",
      owner: "root",
      purpose: "Fast deterministic developer loop for engine mechanics and generic workbook loading/infrastructure checks.",
      deterministic: true,
      modelFree: true,
      spendsTokens: false,
      requiresDocker: false,
      packageScript: rootPackageScript("test:fast"),
      steps: [
        rootStep({ command: "test:engine:fast", script: "test:engine:fast", shell: "npm run test:engine:fast" }),
        rootStep({ command: "test:workbook:fast", script: "test:workbook:fast", shell: "npm run test:workbook:fast" })
      ],
      notes: ["This command must stay deterministic, model-free, and Docker-free."]
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
        engineWorkspaceStep({ command: "test:visual", script: "test:visual", shell: "npm run --workspace=tutorial-engine test:visual", report: "canonical-visual", reportTarget: "tutorial-engine/test/visual/*.received.png", requiresDocker: true, requiresCanonicalDevcontainer: true, visual: true }),
        engineWorkspaceStep({ command: "eval", script: "eval", shell: "npm run --workspace=tutorial-engine eval -- --release", report: "live-engine-eval", reportTarget: "tutorial-engine/evals/reports/latest.json", releaseArgs: ["--release"], requiresDocker: true })
      ],
      notes: [liveEngineEvalCostNote]
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
      notes: ["Root package wiring must use --workspace=tutorial-engine for this command.", "The target tutorial-engine test:fast script is wired, deterministic, model-free, and Docker-free."]
    }),

    "test:workbook:fast": commandContract({
      name: "test:workbook:fast",
      owner: "root",
      purpose: "Deterministic root onboarding/infrastructure checks plus generic workbook load/schema integrity.",
      deterministic: true,
      modelFree: true,
      spendsTokens: false,
      requiresDocker: false,
      packageScript: rootPackageScript("test:workbook:fast"),
      steps: [
        rootStep({ command: "test:onboarding", script: "test:onboarding", shell: "npm run test:onboarding" }),
        rootStep({ command: "check:workbook", script: "check:workbook", shell: "npm run check:workbook" })
      ],
      notes: ["This command must stay deterministic, model-free, Docker-free, and independent of tutorial prose, scenario catalogs, learner-specific behavior, and calculator workspace tests."]
    }),

    "check:workbook": commandContract({
      name: "check:workbook",
      owner: "root-delegates-to-engine",
      purpose: "Load the authored tutorial through the generic engine checker without asserting lesson prose or learner behavior.",
      deterministic: true,
      modelFree: true,
      spendsTokens: false,
      requiresDocker: false,
      packageScript: rootPackageScript("check:workbook"),
      steps: [
        engineWorkspaceStep({ command: "check:workbook", script: "check:workbook", shell: "npm run --workspace=tutorial-engine check:workbook -- ../tutorial" })
      ],
      notes: ["The explicit ../tutorial argument is intentional: npm runs the workspace script from tutorial-engine, and tutorial/ is manually authored content."]
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
      notes: [liveEngineEvalCostNote, "This root package script is wired and forwards through --workspace=tutorial-engine."]
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
        "Do not add eval:engine, tutor, judge, Docker, visual, or tutorial-content assertions to npm run check.",
        "package.json makes check a direct alias of test:fast."
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
