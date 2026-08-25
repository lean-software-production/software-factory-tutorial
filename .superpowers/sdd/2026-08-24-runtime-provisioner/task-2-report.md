# Task 2 Report: Wire this tutorial's Node profile

## Status
Completed.

The root workbook launcher now supplies this repository's trusted Node runtime profile to the generic workbook engine. Authored workbook content and learner CLI arguments do not choose host source paths; the launcher computes the repository root and provides one read-only runtime mount: root `node_modules/` at workspace `node_modules/`.

## Implementation Summary

- Reworked `scripts/tutorial-workbook.mjs` from a simple `npm run dev:workbook` forwarder into the trusted launch boundary:
  - computes repository, tutorial, and tutorial-engine roots from the script location;
  - builds the server and workbook web assets before importing `dist/workbook/cli.js`;
  - forwards normal workbook arguments after the fixed tutorial content target;
  - passes `packageDirectory` and the trusted runtime provision profile into `runWorkbookCli()`;
  - keeps help fast and non-mutating.
- Added exported launcher helpers for deterministic onboarding coverage:
  - `trustedNodeRuntimeProvision()`;
  - `tutorialWorkbookArguments()`.
- Documented `npm run tutorial:workbook` as the root trusted-profile launcher.
- Added root onboarding coverage that checks argument forwarding and verifies the runtime profile contains only the read-only `node_modules` mount.

## Validation

Commands run:

```sh
npm run tutorial:workbook -- --help
npm run tutorial -- --help
npx tsx --input-type=module <<'EOF'
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { repositoryRoot, trustedNodeRuntimeProvision } from './scripts/tutorial-workbook.mjs';
import { trustRuntimeProvision } from './tutorial-engine/src/workbook/runtime-provision.js';
import { dockerRunArguments } from './tutorial-engine/src/workbook/terminal.js';

const workspace = await mkdtemp(resolve(tmpdir(), 'workbook-root-profile-'));
try {
  const runtimeProvision = trustRuntimeProvision(trustedNodeRuntimeProvision(repositoryRoot));
  const args = dockerRunArguments({ workspace, runtimeProvision, name: 'workbook-root-profile-test', apiKey: '<redacted>' });
  const mounts = args.filter((arg) => arg.startsWith('type=bind'));
  assert.equal(runtimeProvision.mounts.length, 1);
  assert.equal(runtimeProvision.workspaceMountTargets.length, 1);
  assert.equal(runtimeProvision.workspaceMountTargets[0], 'node_modules');
  assert.ok(mounts.includes(`type=bind,src=${resolve(repositoryRoot, 'node_modules')},dst=/workspace/node_modules,readonly`));
  assert.ok(!mounts.some((mount) => mount.includes('/package.json')));
  assert.ok(!mounts.some((mount) => mount.includes('/package-lock.json')));
  console.log('root Node runtime profile validates to one read-only node_modules Docker mount; package manifests are not mounted');
} finally {
  await rm(workspace, { recursive: true, force: true });
}
EOF
npm run test:onboarding
npm run --workspace=tutorial-engine test -- test/workbook-terminal.test.ts test/session-workspace.test.ts test/workbook-cli.test.ts test/workbook-server.test.ts
npm run check
```

Results:

- Help output remained available from the root launcher without starting the server.
- The legacy `npm run tutorial -- --help` forwarding path still reached the workbook CLI help after its existing web build step.
- Focused runtime/Docker coverage passed: 69 tests across terminal, session workspace, CLI, and server suites.
- Full root check passed.

## Files Changed

- `scripts/tutorial-workbook.mjs` — root trusted-profile build/import launcher and runtime profile helpers.
- `test/onboarding.test.mjs` — root launcher runtime profile and argument forwarding coverage.
- `README.md` — root usage/documentation for `npm run tutorial:workbook`.
- `tutorial-engine/README.md` — engine documentation for the trusted root Node runtime profile.

## Concerns / Follow-up

- None for this task.
