# Base tutorial engine and natural-language calculator kata

## Aim

Build a local, browser-led tutorial for practising validation loops during a refactoring kata. The learner works in ordinary local files. Pi coaches, demonstrates work when asked, and keeps the next small validation loop obvious. The web UI adds only what a terminal cannot: diagrams, readable validation output, and clear choices.

The first runnable lesson is an original TypeScript natural-language calculator kata. It is inspired by Chelsea Troy’s natural-language calculator exercise, but must not copy or translate its code, tests, prose, examples, or structure. Include a short attribution that names the inspiration and states that this implementation is independent.

## Repository shape

```text
tutorial-engine/                         # publishable npm package
  src/                                   # engine, local server, Pi adapter
  web/                                   # React UI
  docs/plans/iterations/001-base/
  package.json
katas/
  natural-language-calculator/           # independent TypeScript kata and lesson
    src/
    test/
    tutorial.ts
    ATTRIBUTION.md
    package.json
```

The engine and kata remain separate. The engine knows how to run a lesson; the kata supplies its workspace, checks, coaching prompt, and lesson-specific rich content.

## Engine design

### Process model

`tutorial-engine start <kata-directory>` starts a localhost-only Node server and opens the browser. The server runs Pi as a TypeScript library using `@earendil-works/pi-coding-agent`; do not spawn the Pi CLI or use RPC.

The server owns the Pi session, credentials, filesystem access, and working directory. The browser receives only rendered events and sends learner input or selected actions back to the server.

### Lesson contract

A kata exports a small definition containing:

- its title and workspace directory;
- the command(s) that validate it;
- an agent coaching prompt and any lesson rules;
- initial rich content, such as a diagram or orientation note;
- optional allowed actions for the current step.

The first version needs no general lesson editor or persistence format. A TypeScript module is enough.

### Browser protocol

The server maps Pi session events to a compact, app-owned event stream:

- assistant markdown deltas and completed messages;
- tool start, progress, completion, and errors;
- validation command output and status;
- structured presentation blocks;
- an outstanding choice request;
- run state: idle, working, awaiting-choice, or failed.

The browser sends typed messages: `chat`, `choose`, `abort`, and `run-validation`. It may send chat while Pi is working as a steering or follow-up message.

### Structured agent tools

Give the tutorial agent a small set of custom tools. The UI renders their arguments rather than attempting to parse prose:

- `present_markdown` — a titled explanation or instruction;
- `present_diagram` — Mermaid source and an accessible text fallback;
- `offer_choices` — a question and a short, fixed option list; the tool waits for the learner’s selection;
- `run_validation` — runs one allowlisted kata validation command and displays output;
- `show_file_excerpt` — displays a small file/line range relevant to the next step.

The coaching prompt tells the agent to use `offer_choices` whenever it asks whether the learner wants to make a change or have the agent make it. The server validates every tool argument and rejects commands outside the lesson’s allowlist.

### UI

Use React and TypeScript. The first screen has:

- a compact header with kata name and run state;
- a scrolling tutorial transcript;
- cards for code excerpts, validation output, diagrams, and choices;
- normal chat input and a stop button;
- no in-browser code editor.

Render Mermaid locally in the browser. Display raw Mermaid text if rendering fails. Keep the design quiet: the transcript is primary, controls are secondary, and there are no dashboards or progress gamification in the first release.

### Safety and resilience

Bind only to `127.0.0.1` by default. Keep provider credentials on the server. Start with a narrow set of Pi tools and a kata-specific command allowlist. Surface Pi/tool failures in the transcript with a retry path; do not silently retry learner-visible validation commands. Keep one in-memory session for the initial single-user server. Persisted sessions, log-in UI, collaboration, and remote access are out of scope.

## Kata design

### Starting point

Create an original Node/TypeScript package using a conventional test runner (Vitest is preferred). `npm test` must be the single validation command. It should run without global tools after `npm install`.

The program evaluates a small spoken-expression language. Make its examples and grammar distinct from the source exercise. A suitable independent grammar is:

- number words from `zero` through `twelve`, plus digit tokens;
- prefix operations such as `add four and nine`, `subtract two from ten`, `multiply three by six`, and `divide twelve by four`;
- optional parentheses for nested expressions;
- a CLI that evaluates one expression passed as arguments and prints a result.

The starter implementation should be intentionally awkward but correct for the stated behaviour. It should have:

- parsing, arithmetic, formatting, and CLI concerns tangled together;
- repetitive conditionals for operations and number words;
- weak error messages that lose the failing token/context;
- enough tests to make safe refactoring possible.

Do not copy any source, test, sample expression, error text, or documentation wording from the inspiration.

### Refactoring pressures

The tutorial will use these pressures to create successive validation loops:

1. Establish a green baseline and map the current flow.
2. Improve a small seam without changing behaviour, then run focused and full checks.
3. Consolidate the number vocabulary so adding a number word has one home.
4. Separate tokenisation/parsing from evaluation so an operation has one clear implementation.
5. Move CLI input/output to the boundary.
6. Improve errors so a bad expression identifies its token and context.

Each teaching step should ask the learner to make the change or let Pi make it, then validate immediately. The agent must not take more than one step without a learner choice.

### Kata acceptance checks

- `npm install && npm test` passes from the kata directory.
- The CLI has documented example invocations and exits non-zero for invalid expressions.
- Tests cover valid prefix operations, nesting, digit and word operands, malformed input, and CLI error behaviour.
- The starting implementation is readable enough to inspect but has real, deliberate refactoring pressure.
- `ATTRIBUTION.md` credits Chelsea Troy’s original exercise as inspiration, links to it, and says this TypeScript kata was independently implemented.

## Build order

1. Create the TypeScript kata, independent tests, CLI, attribution, and concise README.
2. Add the kata’s `tutorial.ts` definition and coaching instructions.
3. Create the `tutorial-engine` npm package and its direct Pi SDK session adapter.
4. Add the localhost server and browser event protocol.
5. Build the React transcript, choice cards, Mermaid renderer, chat, and validation card.
6. Wire the calculator lesson into `tutorial-engine start`.
7. Test the kata in isolation, then manually complete one learner-led and one agent-led refactoring loop through the browser.

## Non-goals for iteration 001

- Remote hosting or multi-user sessions.
- A browser code editor or sandboxed filesystem.
- General lesson authoring UI or a declarative lesson format.
- Pi CLI/RPC integration.
- Reproducing the source exercise or treating its tests as a specification.
