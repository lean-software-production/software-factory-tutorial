import type { TutorialLogger } from "../runtime-log.js";

export type PiTutorSessionEvent =
  | {
    type: "message_end";
    message: {
      role: string;
      content?: Array<{ type: string; text?: string }>;
      errorMessage?: string;
    };
  }
  | { type: string };

export interface PiTutorSession<Event = PiTutorSessionEvent> {
  state: { model: { provider: string; id: string } };
  subscribe(listener: (event: Event) => void): () => void;
  prompt(prompt: string): Promise<unknown>;
  dispose(): void;
}

export interface ResilientTutorSession {
  prompt(prompt: string): Promise<string>;
  dispose(): void;
}

export interface ResilientTutorSessionOptions {
  wait?: (milliseconds: number) => Promise<void>;
}

const attempts = 3;

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

function terminalResult(event: unknown): { text: string; errorMessage?: string } | undefined {
  if (!event || typeof event !== "object") return undefined;
  const value = event as { type?: unknown; message?: unknown };
  if (value.type !== "message_end" || !value.message || typeof value.message !== "object") return undefined;
  const message = value.message as { role?: unknown; content?: unknown; errorMessage?: unknown };
  if (message.role !== "assistant") return undefined;
  const content = Array.isArray(message.content) ? message.content : [];
  const text = content
    .filter((item): item is { type: string; text?: string } => Boolean(item) && typeof item === "object" && (item as { type?: unknown }).type === "text")
    .map((item) => item.text ?? "")
    .join("");
  return { text, errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined };
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactPromptFromLog(reason: string, prompt: string): string {
  return prompt ? reason.replaceAll(prompt, "[redacted learner prompt]") : reason;
}

async function promptOnce<Event>(session: PiTutorSession<Event>, prompt: string): Promise<string> {
  let result: { text: string; errorMessage?: string } | undefined;
  const unsubscribe = session.subscribe((event) => { result = terminalResult(event) ?? result; });
  try {
    await session.prompt(prompt);
  } finally {
    unsubscribe();
  }
  if (result?.errorMessage) throw new Error(result.errorMessage);
  if (result?.text.trim()) return result.text;
  throw new Error("assistant returned no text");
}

/** Retries only terminal provider failures, without logging learner prompt content. */
export function createResilientTutorSession<Event>(
  session: PiTutorSession<Event>,
  log: TutorialLogger,
  label: string,
  options: ResilientTutorSessionOptions = {}
): ResilientTutorSession {
  const wait = options.wait ?? defaultWait;
  return {
    async prompt(prompt: string): Promise<string> {
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          return await promptOnce(session, prompt);
        } catch (error) {
          const reason = errorReason(error);
          const logReason = redactPromptFromLog(reason, prompt);
          log.error(`${label} prompt failed (attempt ${attempt}/${attempts}; ${session.state.model.provider}/${session.state.model.id}): ${logReason}`);
          if (attempt === attempts) throw error instanceof Error ? error : new Error(reason);
          await wait(attempt * 250);
        }
      }
      throw new Error("Unreachable retry state.");
    },
    dispose(): void { session.dispose(); }
  };
}
