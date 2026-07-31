# Native npm onboarding implementation plan

## 1. Establish the root workspace

1. Add a private root `package.json` with `calculator` and `tutorial-engine` workspaces and Node `>=22.19.0` as the engine requirement.
2. Add Pi as an explicit root dependency at the version used by the Dev Container. Keep the tutorial engine's direct SDK dependency and align its compatible version range.
3. Add root commands for setup, tutorial, factory, and checks. Use workspace scripts for package-local build and test commands.
4. Run `npm install` from the root to generate the single root lockfile. Remove the two obsolete nested lockfiles after confirming the root lock represents both workspaces.

## 2. Add secure native launchers

1. Add a shared Node helper that reads only `OPENCODE_API_KEY` from `.local/secrets.envrc`; an existing environment value wins.
2. Add `npm run setup` as an interactive Node script. It must reject non-TTY use, collect the key without echoing it, confirm replacement, and create `.local/secrets.envrc` atomically with mode `0600`.
3. Add the tutorial launcher. It loads the local key, verifies it is present, and invokes the tutorial-engine development command against the repository root. Forward arguments after `npm run tutorial --` to the engine.
4. Add the factory launcher. It loads the same key and starts `factory/factory.sh` with npm's local binary directory on `PATH`, so the project-local `pi` command resolves.
5. Produce direct, actionable errors for unsupported Node versions, unavailable Pi, missing key, malformed local credential files, and failed child processes. Do not log secrets.

## 3. Verify the workflow

1. Add focused automated tests for local credential loading, environment precedence, missing/malformed files, setup replacement behaviour, permissions, and command/argument construction.
2. Add root `check` coverage that runs `tutorial-engine`'s TypeScript/tests and the calculator tests.
3. Run `npm run check` from the root after migration.
4. Manually verify the documented flow in a clean checkout: `npm install`, `npm run setup`, then `npm run tutorial -- --no-open` and `npm run factory`.

## 4. Update documentation and optional container support

1. Rewrite the root setup documentation around native npm, a browser, and any editor, including Vim.
2. Document `OPENCODE_API_KEY` as the one external prerequisite and explain CI environment-variable use.
3. Move Docker, OrbStack, VS Code, Dev Containers, pnpm, and Graphviz to an optional-environment note.
4. Change the Dev Container post-create command to install the root workspace and remove redundant tooling from its configuration where the root install now provides it.
5. Update `.gitignore` and `.envrc` only as needed to preserve the ignored local credential convention.

## 5. Final validation

1. Run `npm install` from the repository root with no interactive credential prompt.
2. Run root checks and both package-level checks.
3. Confirm `npm run tutorial -- --port 4310 --no-open` starts on localhost and forwards the selected port.
4. Confirm a missing key produces the intended setup instruction, not a downstream Pi error.
5. Confirm Git tracks no credential file or generated runtime artifact.
