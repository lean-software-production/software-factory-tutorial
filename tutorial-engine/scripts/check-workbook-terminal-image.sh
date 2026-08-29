#!/usr/bin/env bash
set -euo pipefail

image="lean-software-production/workbook-terminal:latest"
expected_environment=(
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
docker cp "${container}:/usr/bin/git" "$temporary_directory/git" >/dev/null
if [[ ! -f "$temporary_directory/git" || ! -x "$temporary_directory/git" ]]; then
  printf 'Expected /usr/bin/git in %s to be an executable file\n' "$image" >&2
  exit 1
fi

printf 'Verified Git and isolated Git environment in %s without starting a container.\n' "$image"
