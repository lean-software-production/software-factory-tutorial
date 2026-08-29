#!/usr/bin/env bash
#
# Runs once, after the container is created.
#
# Pi keeps its credentials in the state volume rather than the container
# filesystem, so `Dev Containers: Rebuild Container` doesn't force a re-login.
# The volume starts empty, so create the directory here.
set -euo pipefail

mkdir -p "${PI_CODING_AGENT_DIR}"

# The tutor's model is an environment variable (see devcontainer.json); the
# doer's is Pi state, so it has to be seeded into that directory.
node .devcontainer/seed-doer-model.mjs

# The tutor and the calculator both run from the workspace. Each npm install
# location is a named Linux volume mounted over the host checkout, and fresh
# Docker volumes start as root-owned when the target path is dynamic, so make
# every dependency directory writable before npm populates it. npm ci installs
# exactly from the lockfile; --include=optional keeps platform-specific packages
# such as Rollup's Linux native package present even if a user-level npm config
# omits optional deps.
dependency_directories=(
  node_modules
  tutorial-engine/node_modules
  tutorial/workspaces/refactor-line/calculator/node_modules
)

for dependency_directory in "${dependency_directories[@]}"; do
  mkdir -p "${dependency_directory}"
  if [ ! -w "${dependency_directory}" ]; then
    sudo chown -R "$(id -u):$(id -g)" "${dependency_directory}"
  fi
done

npm ci --include=optional

# `npm run check` ends in a Chromium smoke test. The image carries Chromium's
# system libraries; the browser binary is deliberately not baked in, because it
# has to match the Playwright version this install just resolved rather than one
# pinned when the image was built. Downloading it here means `npm run check`
# works in a fresh container without a separate provisioning step.
npm run --workspace=tutorial-engine browser:install
