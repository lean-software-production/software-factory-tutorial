---
type: editor-practice
path: factory/refactor-do.sh
tutor: |-
  Check that factory/refactor-do.sh preserves the displayed harness behaviour: Bash with
  set -euo pipefail, cd "$(dirname "$0")", mkdir -p .tmp, the two phase announcements, the
  calculator quality baseline written to .tmp/refactor-quality-before.txt with || true, and Pi run
  from calculator with exactly read,edit,write,grep,find,ls. Accept harmless spacing or quoting
  differences that preserve the same behaviour, but not a script that omits the baseline, changes
  the working directory, changes the tool list, gives Pi bash, adds tests, or adds a loop.
---

## Write the doer harness

Create `factory/refactor-do.sh` with this complete Bash harness:

```sh
#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p .tmp
echo "Recording quality baseline..."
(cd ../calculator && node scripts/quality.mjs) > .tmp/refactor-quality-before.txt || true
echo "Starting doer..."
cat refactor.md | (cd ../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)
```

The first step records a baseline: what `node scripts/quality.mjs` reported about the calculator
before the doer touched anything. Run it yourself and you will see what it produces — ESLint
findings about complexity and size, knip findings about unused code, and a summary line naming which
tool reported anything. It is a list of complaints, not a score. Keeping that list gives the next
lesson something to compare against, and a comparison is the only way to tell an improvement from an
assertion. The script runs `node scripts/quality.mjs` rather than `npm run quality` because npm
appends its own error block to a non-zero exit, which reads as though the script broke when in fact
it only reported findings.

Note that the baseline is re-recorded every time you run `refactor-do.sh`. It records the calculator
as it stood at the start of *this* turn, not a fixed starting point for the whole of Part 1. That is
deliberate: the question worth asking about a turn is whether that turn improved things, and after
the second turn a baseline from before the first would no longer answer it.

The two lines around the Pi call are the harness — deterministic code wrapping a model call.
Notice that each step announces itself before it runs. Nothing the harness does should be invisible
to you, because when a run surprises you the announcements are how you find out which part surprised
you.

`refactor-do.sh` performs one doer turn and exits. It has no Bash loop, validation command, recovery
path, or second agent.
