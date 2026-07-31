# Native npm onboarding design

## Goal

Make the tutorial runnable from a normal terminal without Docker, VS Code, or a global Pi installation. A learner can edit with Vim or any other editor.

```sh
npm install
npm run setup
npm run tutorial
```

The browser remains the tutor interface; the learner changes repository files locally.

## Commands

The repository will become a private npm workspace containing `calculator` and `tutorial-engine`. The root package will provide these commands:

- `npm run setup` prompts for `OPENCODE_API_KEY` and saves it locally.
- `npm run tutorial -- [engine options]` starts the browser-led tutor for this repository.
- `npm run factory` starts the factory loop.
- Root check commands delegate to the existing calculator and tutorial-engine checks.

Pi will be an explicit root dependency. npm will install its CLI locally, and root npm scripts will make it available to the factory through `PATH`. No global Pi installation is required.

## Credentials

Setup is explicit; `npm install` never prompts or writes credentials. `npm run setup` writes the key to ignored `.local/secrets.envrc`, with owner-only permissions. It requires an interactive terminal, never prints the key, and asks before replacing an existing value.

The tutorial and factory launchers load only `OPENCODE_API_KEY` from that file. A value already exported by the caller takes precedence. This preserves CI and other non-interactive workflows, which can supply the key through the environment instead of creating a local file.

## Boundaries

`tutorial-engine` keeps its direct Pi SDK dependency because it remains independently buildable and publishable. The root dependency supplies the repository-local CLI used by the factory. The calculator and engine retain their own package manifests and scripts; the root workspace only orchestrates installation and common commands.

Docker, OrbStack, VS Code, Dev Containers, pnpm, and Graphviz are optional developer conveniences. The Dev Container will use the root npm installation path if retained. Its stale calculator path must be corrected.

## Errors and verification

Launchers will fail early with direct guidance if Node is unsupported, setup is non-interactive, the key is absent, or Pi cannot be resolved. They will forward tutorial arguments such as `--port` and `--no-open` unchanged.

Automated coverage will verify credential precedence and error cases, safe setup-file behaviour, and argument forwarding. Root checks will run the engine check and calculator test. Documentation will make native npm onboarding primary and describe the container route as optional.
