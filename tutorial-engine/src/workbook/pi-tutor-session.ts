import type { TutorialLogger } from "./runtime-log.js";
import { TUTOR_PROVIDER_ATTEMPTS, TutorInfrastructureError } from "./tutor-infrastructure.js";

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

export type ResilientTutorFailureLog = "detailed" | "generic";

export interface ResilientTutorPromptOptions {
  failureLog?: ResilientTutorFailureLog;
}

export interface ResilientTutorSession {
  prompt(prompt: string, options?: ResilientTutorPromptOptions): Promise<string>;
  dispose(): void;
}

export interface ResilientTutorSessionOptions {
  failureLog?: ResilientTutorFailureLog;
  wait?: (milliseconds: number) => Promise<void>;
}

export interface ResilientTutorCompactionOptions {
  wait?: (milliseconds: number) => Promise<void>;
  isExpectedNoop?: (error: unknown) => boolean;
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

function durationMs(startedAtMs: number): number {
  return Math.max(0, Date.now() - startedAtMs);
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

function logPromptFailure<Event>(input: { session: PiTutorSession<Event>; log: TutorialLogger; label: string; prompt: string; error: unknown; attempt: number; durationMs: number; failureLog: ResilientTutorFailureLog }): string {
  const reason = errorReason(input.error);
  if (input.failureLog === "generic") {
    input.log.error(`${input.label} prompt failed (attempt ${input.attempt}/${TUTOR_PROVIDER_ATTEMPTS}; durationMs=${input.durationMs}).`);
    return reason;
  }
  const logReason = redactPromptFromLog(reason, input.prompt);
  input.log.error(`${input.label} prompt failed (attempt ${input.attempt}/${TUTOR_PROVIDER_ATTEMPTS}; durationMs=${input.durationMs}; ${input.session.state.model.provider}/${input.session.state.model.id}): ${logReason}`);
  return reason;
}

function logPromptSuccess(log: TutorialLogger, label: string, attempt: number, durationMs: number): void {
  log.info(`${label} prompt completed (attempt ${attempt}/${TUTOR_PROVIDER_ATTEMPTS}; durationMs=${durationMs}; outcome=success).`);
}

function logPromptExhaustion(log: TutorialLogger, label: string, durationMs: number): void {
  log.error(`${label} prompt exhausted (attempts=${TUTOR_PROVIDER_ATTEMPTS}; durationMs=${durationMs}; outcome=infrastructure_failure).`);
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
  return result?.text ?? "";
}

/** Retries provider failures exactly three times without logging learner prompt content. */
export function createResilientTutorSession<Event>(
  session: PiTutorSession<Event>,
  log: TutorialLogger,
  label: string,
  options: ResilientTutorSessionOptions = {}
): ResilientTutorSession {
  const wait = options.wait ?? defaultWait;
  const defaultFailureLog = options.failureLog ?? "detailed";
  return {
    async prompt(prompt: string, promptOptions?: ResilientTutorPromptOptions): Promise<string> {
      const failureLog = promptOptions?.failureLog ?? defaultFailureLog;
      const operationStartedAtMs = Date.now();
      let finalError: unknown;
      for (let attempt = 1; attempt <= TUTOR_PROVIDER_ATTEMPTS; attempt += 1) {
        const attemptStartedAtMs = Date.now();
        try {
          const text = await promptOnce(session, prompt);
          logPromptSuccess(log, label, attempt, durationMs(attemptStartedAtMs));
          return text;
        } catch (error) {
          finalError = error;
          logPromptFailure({ session, log, label, prompt, error, attempt, durationMs: durationMs(attemptStartedAtMs), failureLog });
          if (attempt < TUTOR_PROVIDER_ATTEMPTS) await wait(attempt * 250);
        }
      }
      logPromptExhaustion(log, label, durationMs(operationStartedAtMs));
      throw new TutorInfrastructureError(finalError);
    },
    dispose(): void { session.dispose(); }
  };
}

export async function compactWithTutorRetries<T>(
  compact: () => Promise<T>,
  log: TutorialLogger,
  label: string,
  options: ResilientTutorCompactionOptions = {}
): Promise<T> {
  const wait = options.wait ?? defaultWait;
  const operationStartedAtMs = Date.now();
  let finalError: unknown;
  for (let attempt = 1; attempt <= TUTOR_PROVIDER_ATTEMPTS; attempt += 1) {
    const attemptStartedAtMs = Date.now();
    try {
      const result = await compact();
      log.info(`${label} compact completed (attempt ${attempt}/${TUTOR_PROVIDER_ATTEMPTS}; durationMs=${durationMs(attemptStartedAtMs)}; outcome=success).`);
      return result;
    } catch (error) {
      if (options.isExpectedNoop?.(error)) throw error;
      finalError = error;
      log.error(`${label} compact failed (attempt ${attempt}/${TUTOR_PROVIDER_ATTEMPTS}; durationMs=${durationMs(attemptStartedAtMs)}): ${errorReason(error)}`);
      if (attempt < TUTOR_PROVIDER_ATTEMPTS) await wait(attempt * 250);
    }
  }
  log.error(`${label} compact exhausted (attempts=${TUTOR_PROVIDER_ATTEMPTS}; durationMs=${durationMs(operationStartedAtMs)}; outcome=infrastructure_failure).`);
  throw new TutorInfrastructureError(finalError);
}
