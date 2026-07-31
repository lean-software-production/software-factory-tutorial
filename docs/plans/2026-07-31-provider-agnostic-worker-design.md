# Provider-agnostic tutor authentication and worker design

## Goal

Keep the browser-based tutor, which embeds Pi, while removing the project’s dependence on OpenCode credentials. Let Pi’s own authentication configuration select the tutor model and support advanced learners who replace the factory worker with another CLI harness.

## Authentication

The repository will not collect, store, or load provider keys. It will not create `.local/secrets.envrc` or manage `OPENCODE_API_KEY`.

`npm run setup` becomes a non-interactive Pi preflight. It checks the project-local Pi SDK for at least one available, authenticated model without making a model request or exposing credential values. If none is available, it explains the interactive Pi login flow:

```sh
npx pi
/login
```

The learner selects any Pi-supported provider, including an API-key provider such as OpenCode or a subscription provider such as Claude or Codex. Pi owns the resulting user-level credentials and configuration.

The browser tutor uses that Pi configuration. The default Pi factory worker uses the same configuration. Advanced learners who need separate tutor and worker credentials configure the server and worker environments or Pi profiles themselves; the tutorial does not own either secret.

## Worker seam

Pi remains the blessed default worker and its exact command remains the introductory path. The factory’s essential interface is not Pi-specific:

- receive the work or recovery prompt on standard input;
- operate with `calculator/` as its working directory;
- edit the kata files;
- leave validation to the surrounding Bash loop.

A short advanced note in the worker lessons will say that a learner may replace the Pi subshell with another CLI harness. Its invocation, authentication, sandboxing, and tool restrictions are that learner’s responsibility. The factory must retain independent Bash validation; it must not trust an alternative worker’s report.

## Documentation and verification

The README will name Pi authentication, rather than OpenCode, as the web tutor prerequisite. It will explain that the default factory worker is Pi and point advanced users to the worker-substitution note.

Tests will cover the preflight result and its no-auth guidance without reading credentials. The complete root check will continue to run the engine, calculator, and onboarding tests.
