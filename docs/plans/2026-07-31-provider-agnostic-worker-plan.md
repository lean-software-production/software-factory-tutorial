# Provider-agnostic tutor authentication and worker plan

## 1. Replace credential setup with Pi preflight

1. Remove the OpenCode credential parser, local secret writer, and tutorial environment loader.
2. Change `npm run setup` to use the project-local Pi SDK’s model runtime and check whether at least one authenticated model is available.
3. On success, report that Pi is ready without naming providers or credentials. On failure, exit non-zero with the `npx pi` then `/login` instructions.
4. Start the tutorial without injecting provider environment variables. Pi resolves credentials through its normal user-level configuration.

## 2. Revise onboarding coverage

1. Replace secret-file tests with focused unit tests for successful and unsuccessful Pi preflight outcomes.
2. Retain the tutorial argument-forwarding test.
3. Remove the now-unused `.envrc` and any credential-specific repository guidance.
4. Update the README to describe Pi authentication, the interactive login path, and the default Pi worker without naming OpenCode.

## 3. Document the worker seam

1. Keep Pi’s exact invocation as the introductory, blessed path in each factory lesson.
2. Add a concise advanced-worker note to each relevant lesson. It must define the stdin, working-directory, editing, and independent-validation requirements, and state that alternative CLI authentication and restrictions are the learner’s responsibility.
3. Ensure the note does not imply that every alternative harness offers Pi’s tool restrictions.

## 4. Validate

1. Run `npm install` and confirm it has no credential prompt.
2. Run `npm run setup` using the current Pi configuration and verify it reports a usable authenticated model without revealing credentials.
3. Verify the no-auth branch through automated tests.
4. Run `npm run check`.
