# Tutorial engine

A local, browser-led tutorial runner. It embeds `@earendil-works/pi-coding-agent` directly as a TypeScript SDK; it does not start Pi’s CLI or RPC mode.

## Run a tutorial

Point the engine at a tutorial directory:

```sh
cd tutorial-engine
npm install
npm run dev -- ..
```

Add `--no-open` to suppress browser launch, or `--port 4310` to choose a port. The server binds only to `127.0.0.1`. Pi credentials remain in the server process; the browser has no filesystem or provider-credential access.

Keep the launching terminal open. It prints timestamped startup, browser, Pi, tool, validation, and shutdown events. It also saves each run to `~/Library/Logs/SoftwareFactoryTutorial/` on macOS (or `$XDG_STATE_HOME/software-factory-tutorial/` elsewhere); the terminal prints the exact path. While Pi is working, a heartbeat every 15 seconds names its current activity, so a browser spinner always has a corresponding server-side status.

## Tutorial convention

A tutorial needs no engine configuration file. The engine infers it from the directory:

- the first `#` heading in `README.md` is the title and the README is the whole-exercise orientation;
- `docs/specs/README.md` is the lesson ledger;
- the first `Todo` row is the current lesson;
- the linked spec tells the tutor what to teach.

The tutor reads those files, guides one small step at a time, and offers to let the learner make a change or make it for them.

## Commands

```sh
npm run build  # compile server and browser client
npm test       # unit tests
npm run check  # TypeScript and tests
```
