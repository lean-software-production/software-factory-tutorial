import { EvalTimeoutError, PersonaProtocolError } from "./session.js";

/** Only failures before useful tutor output are safe to repeat on a new workspace. */
export function shouldRetry(error: unknown): boolean {
  if (error instanceof PersonaProtocolError) return false;
  if (error instanceof EvalTimeoutError) return !error.modelOutputObserved;
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b|\b5\d\d\b|connection reset|ECONNRESET/i.test(message);
}
