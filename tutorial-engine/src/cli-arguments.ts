/**
 * Command-line parsing for the tutorial server, kept separate from startup so the
 * rules stay testable. Every flag value is consumed positionally, so a value can
 * never be mistaken for the tutorial directory however the flags are ordered.
 */

export const USAGE = "Usage: tutorial-engine <tutorial-directory> [--session <id>] [--port 4310] [--host 0.0.0.0] [--no-open]";

export interface TutorialArguments {
  target: string;
  port?: number;
  host?: string;
  noOpen: boolean;
  session?: string;
}

export type ParsedArguments = { kind: "run"; options: TutorialArguments } | { kind: "help" };

/** A misuse of the command line, reported with the usage line rather than a stack trace. */
export class ArgumentError extends Error {}

const VALUE_FLAGS = ["--port", "--host", "--session"] as const;
const BARE_FLAGS = ["--no-open"] as const;

function splitFlag(argument: string): { flag: string; inlineValue?: string } {
  const equals = argument.indexOf("=");
  return equals === -1
    ? { flag: argument }
    : { flag: argument.slice(0, equals), inlineValue: argument.slice(equals + 1) };
}

function parsePort(value: string): number {
  // Number() would accept "", " 12", "0x10", and "1e3"; insist on plain digits.
  if (!/^\d+$/.test(value)) throw new ArgumentError(`--port needs a whole number, not '${value}'.`);
  const port = Number(value);
  if (port > 65535) throw new ArgumentError(`--port must be between 0 and 65535, not ${port}.`);
  return port;
}

function parseHost(value: string): string {
  // A URL or a host:port pair is the usual slip here; both would bind to nothing.
  if (value.includes("/")) throw new ArgumentError(`--host needs a hostname or address, not a URL or path ('${value}').`);
  return value;
}

export function parseArguments(argv: readonly string[]): ParsedArguments {
  if (argv.includes("--help") || argv.includes("-h")) return { kind: "help" };

  const positional: string[] = [];
  let port: number | undefined;
  let host: string | undefined;
  let noOpen = false;
  let session: string | undefined;
  let endOfFlags = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (endOfFlags || !argument.startsWith("-") || argument === "-") {
      positional.push(argument);
      continue;
    }
    // Everything after a bare "--" is a path, so directories starting with "-" stay usable.
    if (argument === "--") { endOfFlags = true; continue; }

    const { flag, inlineValue } = splitFlag(argument);
    if ((VALUE_FLAGS as readonly string[]).includes(flag)) {
      const next = argv[index + 1];
      let value = inlineValue;
      if (value === undefined) {
        // Only consume the next argument when it is a value; otherwise the flag ate a flag.
        if (next !== undefined && (!next.startsWith("-") || next === "-")) { value = next; index += 1; }
      }
      if (value === undefined || value === "") throw new ArgumentError(`${flag} needs a value.`);
      if (flag === "--port") port = parsePort(value);
      else if (flag === "--host") host = parseHost(value);
      else session = value;
      continue;
    }
    if ((BARE_FLAGS as readonly string[]).includes(flag)) {
      if (inlineValue !== undefined) throw new ArgumentError(`${flag} does not take a value.`);
      noOpen = true;
      continue;
    }
    throw new ArgumentError(`Unknown option '${flag}'.`);
  }

  const [target, ...extra] = positional;
  if (!target) throw new ArgumentError("Name the tutorial directory to serve.");
  if (extra.length > 0) throw new ArgumentError(`Serve one tutorial directory at a time; got ${positional.length} (${positional.join(", ")}).`);
  return { kind: "run", options: { target, port, host, noOpen, session } };
}
