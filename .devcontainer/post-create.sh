#!/usr/bin/env bash
#
# Runs once, after the container is created.
#
# Pi keeps its credentials in the state volume rather than the container
# filesystem, so `Dev Containers: Rebuild Container` doesn't force a re-login.
# The volume starts empty, so create the directory here.
set -euo pipefail

mkdir -p "${PI_CODING_AGENT_DIR}"

# The tutor and the calculator both run from the workspace, so install the
# workspace dependencies now rather than making the first lesson wait on them.
npm install
