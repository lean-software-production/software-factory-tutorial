#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

sanitize_quality_paths() {
  local workspace_cwd workspace_physical_cwd calculator_cwd calculator_physical_cwd sed_script entry candidate replacement escaped_cwd
  sed_script=""
  workspace_cwd="$(cd ../.. && pwd)"
  workspace_physical_cwd="$(cd ../.. && pwd -P)"
  calculator_cwd="$(cd ../../calculator && pwd)"
  calculator_physical_cwd="$(cd ../../calculator && pwd -P)"
  for entry in \
    "$calculator_cwd|<calculator>" \
    "$calculator_physical_cwd|<calculator>" \
    "$workspace_cwd|<workspace>" \
    "$workspace_physical_cwd|<workspace>" \
    "/workspace|<workspace>" \
    "/opt/workbook|<workbook>" \
    "/private/var/folders|<tmp>" \
    "/var/folders|<tmp>" \
    "/private/tmp|<tmp>" \
    "/tmp|<tmp>"; do
    candidate="${entry%%|*}"
    replacement="${entry#*|}"
    [ -n "$candidate" ] || continue
    escaped_cwd="$(printf '%s' "$candidate" | sed 's/[][\\.^$*\/]/\\&/g')"
    sed_script="${sed_script}s/${escaped_cwd}/${replacement}/g;"
  done
  sed "$sed_script"
}

bound_quality_output() {
  awk '
    function clipped(line) { return length(line) > 180 ? substr(line, 1, 177) "..." : line }
    /All quality checks passed\.|Findings reported by:/ { summary=clipped($0) }
    NR <= 60 {
      line=clipped($0)
      lines[++kept]=line
      if (line ~ /All quality checks passed\.|Findings reported by:/) first_has_summary=1
    }
    END {
      for (i=1; i<=kept; i++) print lines[i]
      if (!first_has_summary && summary != "") {
        if (NR > kept) print "... quality output truncated ..."
        print summary
      }
    }
  '
}

quality_now() {
  local output_file status
  output_file=".tmp/quality-output.$$"
  rm -f "$output_file"
  if (
    ulimit -f 128
    cd ../../calculator
    node scripts/quality.mjs
  ) > "$output_file" 2>&1; then
    status=0
  else
    status=$?
  fi
  sanitize_quality_paths < "$output_file" | bound_quality_output
  if ! grep -Eq 'All quality checks passed\.|Findings reported by:' "$output_file"; then
    echo "quality command could not run: no bounded summary."
  fi
  rm -f "$output_file"
  return "$status"
}

mkdir -p .tmp
if [ ! -f .tmp/quality-before.txt ]; then
  echo "No quality baseline. Run ./do.sh first." >&2
  exit 1
fi
echo "Gathering evidence..."
{
  echo "=== QUALITY BEFORE (recorded before the doer ran) ==="
  cat .tmp/quality-before.txt
  echo
  echo "=== QUALITY NOW ==="
  quality_now || true
  echo
  echo "=== TESTS ==="
  (cd ../../calculator && npm test 2>&1) || true
  echo
  echo "=== WORKING DIFF ==="
  (cd ../../calculator && git diff -- .)
} > .tmp/evidence.txt
echo "Starting validation..."
cat validate.md success.md .tmp/evidence.txt \
  | (cd ../../calculator && pi --no-session --tools read,grep,find,ls -p) \
  | tee .tmp/validate-findings.txt
