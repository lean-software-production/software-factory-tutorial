const PREFIX = "\x1b]633;workbook-";
const TERMINATOR = "\x07";

export type TerminalShellProtocolEvent =
  | { type: "output"; data: string }
  | { type: "command-submitted"; command: string }
  | { type: "command-finished"; exitStatus: number };

function trailingPrefixLength(value: string): number {
  const maximum = Math.min(value.length, PREFIX.length - 1);
  for (let length = maximum; length > 0; length -= 1) if (value.endsWith(PREFIX.slice(0, length))) return length;
  return 0;
}

function exactBase64(value: string): string | undefined {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64").toString("utf8");
  return Buffer.from(decoded, "utf8").toString("base64") === value ? decoded : undefined;
}

function markerEvent(marker: string): TerminalShellProtocolEvent | undefined {
  const separator = marker.indexOf(";");
  if (separator < 0) return undefined;
  const kind = marker.slice(0, separator);
  const payload = marker.slice(separator + 1);
  if (kind === "command") {
    const command = exactBase64(payload);
    return command === undefined || !command ? undefined : { type: "command-submitted", command };
  }
  if (kind === "finished" && /^\d+$/.test(payload)) {
    const exitStatus = Number(payload);
    return Number.isSafeInteger(exitStatus) ? { type: "command-finished", exitStatus } : undefined;
  }
  return undefined;
}

/**
 * Parses private OSC markers emitted by the controlled Bash shell. Markers are removed from
 * ordinary terminal output so neither the learner nor Coach evidence sees transport protocol.
 */
export class TerminalShellProtocol {
  #pending = "";

  consume(data: string): TerminalShellProtocolEvent[] {
    const source = this.#pending + data;
    this.#pending = "";
    const events: TerminalShellProtocolEvent[] = [];
    let cursor = 0;
    const emitOutput = (output: string) => {
      if (!output) return;
      const previous = events.at(-1);
      if (previous?.type === "output") previous.data += output;
      else events.push({ type: "output", data: output });
    };

    while (cursor < source.length) {
      const start = source.indexOf(PREFIX, cursor);
      if (start < 0) {
        const suffixLength = trailingPrefixLength(source.slice(cursor));
        emitOutput(source.slice(cursor, source.length - suffixLength));
        this.#pending = source.slice(source.length - suffixLength);
        break;
      }
      emitOutput(source.slice(cursor, start));
      const markerStart = start + PREFIX.length;
      const end = source.indexOf(TERMINATOR, markerStart);
      if (end < 0) {
        this.#pending = source.slice(start);
        break;
      }
      const rawMarker = source.slice(start, end + TERMINATOR.length);
      const event = markerEvent(source.slice(markerStart, end));
      if (event) events.push(event); else emitOutput(rawMarker);
      cursor = end + TERMINATOR.length;
    }

    return events;
  }
}
