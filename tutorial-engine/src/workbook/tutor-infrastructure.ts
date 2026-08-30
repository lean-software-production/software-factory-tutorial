/** Browser-safe infrastructure contract shared by the workbook server and client. */
export const TUTOR_PROVIDER_ATTEMPTS = 3;
export const TUTOR_INFRASTRUCTURE_FATAL_MESSAGE = "The AI tutor provider is unavailable. Fix or reconnect the provider, then restart this workbook to continue.";

export type PublicTutorInfrastructureFatalState = {
  kind: "tutor-infrastructure";
  message: string;
};

export function publicTutorInfrastructureFatalState(): PublicTutorInfrastructureFatalState {
  return { kind: "tutor-infrastructure", message: TUTOR_INFRASTRUCTURE_FATAL_MESSAGE };
}

export class TutorInfrastructureError extends Error {
  readonly publicMessage = TUTOR_INFRASTRUCTURE_FATAL_MESSAGE;

  constructor(cause?: unknown) {
    super(TUTOR_INFRASTRUCTURE_FATAL_MESSAGE, { cause });
    this.name = "TutorInfrastructureError";
  }
}

export function isTutorInfrastructureError(error: unknown): error is TutorInfrastructureError {
  return error instanceof TutorInfrastructureError;
}
