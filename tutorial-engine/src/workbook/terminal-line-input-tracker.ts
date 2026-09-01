export interface TerminalLineInputActivity {
  /** Meaningful physical shell lines that began in this consumed input. */
  readonly started: number;
  /** Current unsubmitted physical shell lines that were cancelled in this consumed input. */
  readonly cancelled: number;
}

type EscapeState = "none" | "escape" | "csi" | "osc" | "string";

const MAX_LINE_BUFFER = 4_096;

function isPrintableMeaningful(char: string): boolean {
  return char >= " " && char !== "\x7f" && char.trim().length > 0;
}

function isCsiFinal(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
}

/**
 * Tracks meaningful physical terminal input lines without trying to emulate a shell. It is shared
 * by browser and server code so local Continue suppression and the completion fence agree about
 * keyboard input, line erasure, line cancellation, and fragmented escape/control sequences.
 */
export class TerminalLineInputTracker {
  #buffer = "";
  #countedCurrentLine = false;
  #escapeState: EscapeState = "none";
  #sawOscEscape = false;
  #sawStringEscape = false;

  consume(data: string): TerminalLineInputActivity {
    let started = 0;
    let cancelled = 0;
    const cancelCurrentLine = () => {
      if (this.#countedCurrentLine) cancelled += 1;
      this.#buffer = "";
      this.#countedCurrentLine = false;
    };
    const appendPrintable = (char: string) => {
      this.#buffer = (this.#buffer + char).slice(-MAX_LINE_BUFFER);
      if (!this.#countedCurrentLine && isPrintableMeaningful(char)) {
        this.#countedCurrentLine = true;
        started += 1;
      }
    };

    for (const char of data) {
      if (this.#consumeEscape(char)) continue;
      if (char === "\x1b") {
        this.#escapeState = "escape";
        continue;
      }
      if (char === "\r" || char === "\n") {
        this.#buffer = "";
        this.#countedCurrentLine = false;
        continue;
      }
      if (char === "\u0003" || char === "\u0015") {
        cancelCurrentLine();
        continue;
      }
      if (char === "\b" || char === "\x7f") {
        this.#buffer = this.#buffer.slice(0, -1);
        if (this.#countedCurrentLine && !this.#buffer.trim()) cancelCurrentLine();
        continue;
      }
      if (char < " " || char === "\x7f") continue;
      appendPrintable(char);
    }

    return { started, cancelled };
  }

  #consumeEscape(char: string): boolean {
    if (this.#escapeState === "none") return false;
    if (this.#escapeState === "escape") {
      if (char === "[") this.#escapeState = "csi";
      else if (char === "]") {
        this.#escapeState = "osc";
        this.#sawOscEscape = false;
      } else if (char === "P" || char === "X" || char === "^" || char === "_") {
        this.#escapeState = "string";
        this.#sawStringEscape = false;
      } else this.#escapeState = "none";
      return true;
    }
    if (this.#escapeState === "csi") {
      if (isCsiFinal(char)) this.#escapeState = "none";
      return true;
    }
    if (this.#escapeState === "osc") {
      if (char === "\x07") {
        this.#escapeState = "none";
        this.#sawOscEscape = false;
      } else if (this.#sawOscEscape && char === "\\") {
        this.#escapeState = "none";
        this.#sawOscEscape = false;
      } else this.#sawOscEscape = char === "\x1b";
      return true;
    }
    if (this.#escapeState === "string") {
      if (this.#sawStringEscape && char === "\\") {
        this.#escapeState = "none";
        this.#sawStringEscape = false;
      } else this.#sawStringEscape = char === "\x1b";
      return true;
    }
    return false;
  }
}
