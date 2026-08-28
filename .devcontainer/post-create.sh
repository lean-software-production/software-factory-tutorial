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

# The tutor and the calculator both run from the workspace, so install the
# workspace dependencies now rather than making the first lesson wait on them.
npm install

# `npm run check` ends in a Chromium smoke test. The image carries Chromium's
# system libraries; the browser binary is deliberately not baked in, because it
# has to match the Playwright version this install just resolved rather than one
# pinned when the image was built. Downloading it here means `npm run check`
# works in a fresh container without a separate provisioning step.
npm run --workspace=tutorial-engine browser:install
