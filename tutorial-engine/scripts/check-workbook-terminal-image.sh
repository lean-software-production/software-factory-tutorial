#!/usr/bin/env bash
set -euo pipefail

image="lean-software-production/workbook-terminal:latest"
expected_environment=(
  "HOME=/home/learner"
  "GIT_CONFIG_NOSYSTEM=1"
  "GIT_CONFIG_GLOBAL=/dev/null"
  "GIT_TERMINAL_PROMPT=0"
)

image_environment="$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image")"
for expected in "${expected_environment[@]}"; do
  if ! grep -Fqx "$expected" <<<"$image_environment"; then
    printf 'Expected %s in %s environment\n' "$expected" "$image" >&2
    exit 1
  fi
done

temporary_directory="$(mktemp -d)"
container=""
cleanup() {
  if [[ -n "$container" ]]; then docker rm "$container" >/dev/null 2>&1 || true; fi
  rm -rf "$temporary_directory"
}
trap cleanup EXIT

container="$(docker create "$image")"
for executable in /usr/local/bin/node /usr/bin/git /usr/bin/jq /usr/local/bin/pi; do
  docker cp "${container}:${executable}" "$temporary_directory/$(basename "$executable")" >/dev/null
  if [[ ! -f "$temporary_directory/$(basename "$executable")" || ! -x "$temporary_directory/$(basename "$executable")" ]]; then
    printf 'Expected %s in %s to be an executable file\n' "$executable" "$image" >&2
    exit 1
  fi
done

docker run --rm --network none "$image" sh -lc '
  test "$(pwd)" = /workspace
  test -d /workspace
  test -d /home/learner/.pi/agent
  test ! -e /workspace/node_modules
  node --version >/dev/null
  git --version >/dev/null
  jq --version >/dev/null
  pi --version >/dev/null
'

printf 'Verified Node, Git, jq, pinned Pi, learner home, /workspace, and isolated Git environment in generic %s.\n' "$image"
