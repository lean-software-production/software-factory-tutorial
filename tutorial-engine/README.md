# Tutorial engine

A local, browser-led refactoring tutorial runner. It embeds `@earendil-works/pi-coding-agent` directly as a TypeScript SDK; it does not start Pi's CLI or RPC mode.

## Run a lesson

```sh
cd tutorial-engine
npm install
npm run build
npm start -- ../katas/my-kata
```

For local source development, build the web client and start the TypeScript server in one command:

```sh
npm run dev -- ../katas/my-kata
```

Add `--no-open` to suppress browser launch, or `--port 4310` to select a port. The server binds only to `127.0.0.1` and prints its URL.

Pi credentials remain in the server process and continue to use the local Pi SDK configuration. The browser has no filesystem or provider credential access.

## Lesson contract

A kata exports `tutorial.ts` (a default export is recommended):

```ts
import type { LessonDefinition } from "@lean-software-production/tutorial-engine";

const lesson: LessonDefinition = {
  title: "Small safe refactor",
  workspace: ".",
  validationCommands: [
    { id: "test", label: "Run tests", command: "npm", args: ["test"] }
  ],
  coachingPrompt: "Teach one safe validation loop at a time.",
  rules: ["Preserve behaviour."],
  initialContent: [
    { kind: "markdown", title: "Orientation", markdown: "Start with a green baseline." }
  ]
};

export default lesson;
```

Validation commands are executable/argument pairs, never shell strings. Only listed command IDs can run. The tutorial agent receives a narrow tool allowlist: file inspection/editing inside the kata, structured presentation tools, and the allowlisted validation tool. It has no Bash tool.

## Commands

```sh
npm run build  # compile server and browser client
npm test       # unit tests
npm run check  # TypeScript and tests
```
