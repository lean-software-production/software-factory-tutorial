# Task 8 report — ordinary workspace containment

## Result

Task 8 is complete in commit `2631a72 Simplify tutor workspace containment`.

## Boundary

`WorkspaceBoundary` is now a small read-only ordinary-containment boundary. It:

- canonicalizes and validates the live workspace root;
- rejects POSIX, Windows-drive, and UNC absolute paths;
- rejects `..` traversal with either path separator and invalid NUL characters;
- checks the lexical candidate remains below the root;
- resolves the existing candidate canonically and rejects a static symlink that escapes the root;
- allows ordinary internal symlinks;
- provides only bounded-tool support operations: read, stat, and directory listing.

The prior macOS `O_NOFOLLOW_ANY`, Linux `/proc/self/fd` descriptor traversal, open-one-segment-at-a-time
logic, root/file identity checks, before/after file-version checks, platform rejection, and concurrent
race suite are removed. The boundary explicitly documents that concurrent malicious replacement between
check and read is out of scope.

The unused broad mutable workspace tool factory and its read/write/edit/move/grep/find/ls audit surface
were removed with the boundary machinery. Main Tutor still receives only `list_files` and `read_file`.

## Bounded and escaped tools

`list_files` retains deterministic sorting, entry/offset/output limits, truncation markers, reserved
`.git`/`.tutorial` rejection (case-insensitive), and quoted/escaped learner-controlled names in text and
details. `read_file` retains path/offset/limit/file-size bounds, byte-range truncation, safe errors, and
quoted path metadata. Neither tool mutates files or exposes raw outside paths.

## Availability

Workflow tests prove ordinary conversation receives the canonical live workspace only while an editor or
terminal practice block is active, and receives none during workbook introduction. Existing direct-review
server tests cover editor and terminal review roots. Tutor session tests prove both review kinds receive
only `accept_current_attempt`, `list_files`, and `read_file`; reflection review without a workspace gets
only the decision tool. Fresh operations recreate the two workspace tools and cannot reuse a prior root.

## Verification

```text
Focused boundary/tool/tutor/server tests: 20 passed, 61 skipped
Production/test TypeScript: passed
Repository race-primitive search: clean in live source/tests
npm run --workspace=tutorial-engine test:fast:
  lint/typechecks/check:eval passed
  55 files, 592 tests passed
  web build passed
  browser smoke passed
```
