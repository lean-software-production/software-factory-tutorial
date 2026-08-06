/**
 * run_tests — the only shell the doer and the healer can reach.
 *
 * This is not a restricted `bash`. pi can restrict bash — a `tool_call` hook may
 * inspect `event.input.command` and block it — but that means deciding whether a
 * shell string is safe, and `npm test; curl evil.example` defeats any allowlist
 * written as string matching. Restricting bash is a parsing problem, and it is a
 * parsing problem you lose.
 *
 * A custom tool is an allowlist by construction. This one takes no parameters at
 * all, so there is nothing for a model to widen. It runs exactly one script: the
 * same `stations/test-runner` the orchestrator runs between stations, producing
 * the same report. A station holding this tool cannot run commands; it can ask
 * for one test run.
 *
 * pi loads TypeScript extensions through jiti, so this needs no build step.
 */

import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const runner = resolve(here, "../stations/test-runner");
const report = resolve(here, "../run/test-report.txt");

const runTests = defineTool({
	name: "run_tests",
	label: "Run tests",
	description:
		"Run the calculator's test suite and return the report. Takes no arguments and runs nothing else.",
	parameters: Type.Object({}),
	promptSnippet: "run_tests: run the calculator's test suite (no arguments)",

	async execute() {
		// The runner always exits 0 and writes its answer to the report, so a
		// failing suite arrives here as text rather than as a thrown error.
		await run(runner, [], { maxBuffer: 8 * 1024 * 1024 });
		const text = await readFile(report, "utf8");
		return { content: [{ type: "text", text }], details: {} };
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(runTests);
}
