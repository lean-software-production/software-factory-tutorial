---
type: reflection
tutor: |-
  Ask the learner to answer the checks from the block. A satisfactory answer demonstrates both
  branch outcomes or a faithful simulation, confirms repair receives findings, PASS commits only
  calculator files with a clean message, FAIL does not commit, unreadable verdicts route to repair,
  and the anchor prevents quoted verdict prose from being parsed. Accept simulated verdict parsing
  for the edge case, but require real git inspection for commits. The why is that a model-written
  contract now drives deterministic routing.
---

## Checks

From the repository root:

```sh
./factory/refactor/run.sh
```

Verify by hand that:

- a failing verdict starts a repair, announced with `Starting repair...` before Pi is invoked;
- the repair station is handed the findings — the validator's own words are in what was piped to it;
- a failing verdict produces **no** commit;
- a passing verdict starts a commit, announced with `Starting commit...`, and `git log -1` shows a
  message that describes the change rather than announcing itself;
- `git show --stat HEAD` touches only files under `calculator/`;
- the loop still pauses for Enter once per iteration, whichever way the verdict went; and
- a run in which the validator produces no recognisable verdict routes to repair rather than past
  it.

The last one is easier to arrange than to wait for. Feed the parse some prose directly:

```sh
bash -c 'printf "The code looks fine to me.\n" > d.txt
  grep -m1 -o "^VERDICT: \(PASS\|FAIL\)" d.txt || echo "VERDICT: FAIL"'

bash -c 'printf "must be VERDICT: PASS or VERDICT: FAIL, and mine is:\nVERDICT: FAIL\n" > d.txt
  grep -m1 -o "^VERDICT: \(PASS\|FAIL\)" d.txt || echo "VERDICT: FAIL"'
```

Both must print `VERDICT: FAIL`, the second from its verdict line rather than from the sentence
above
it. Delete `d.txt` afterwards.

Now drop the `^` from the second command and run it again. It prints two lines — `VERDICT: PASS`
from
the sentence, then `VERDICT: FAIL` from the actual verdict — because `-m1` stopped at the first
matching line and `-o` printed every match on it. That is the whole reason the anchor is there, and
it
is worse than a misread verdict: `$verdict` is now a two-line string matching neither arm's test, so
the line takes the `else` and commits a change it was told had failed.

There is a second way to get an unreadable verdict, and it is more common than a model wandering
from
its format: **Pi exits 0 when the model call itself fails.** A rate limit or a provider error
produces a
run whose assistant message is empty and whose stop reason is an error, and the exit code says
nothing
about it — so `set -euo pipefail` will not catch it, and the findings file ends up empty. The
fallback
below is what turns that into a repair turn rather than a silent commit.

An unreadable or missing verdict is treated as a failure on purpose. The validator is a model, and
models wander from the format they were given. The alternative is a line that treats "I could not
tell"
as "everything is fine", carries on refactoring on top of a change nobody checked, and commits it.
Read
the other way, the worst case is one repair turn that was not needed. The two mistakes are not the
same
size.
