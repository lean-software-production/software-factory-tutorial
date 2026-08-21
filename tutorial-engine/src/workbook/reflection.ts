import type { SubmitAttempt } from "./attempts.js";

export type ReflectionTurn = { role: "learner" | "tutor"; text: string };

export interface SubmitReflectionAttemptRequest {
  lessonId: string;
  blockId: string;
  privateGuidance: string;
  response: string;
  conversation: ReflectionTurn[];
  submitAttempt: SubmitAttempt;
}

function cleanReflectionText(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const text = value.trim().slice(0, 4_000);
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function assertConversation(conversation: ReflectionTurn[]): ReflectionTurn[] {
  if (!Array.isArray(conversation)) throw new Error("Reflection conversation must be an array.");
  return conversation.map((turn) => {
    if (!turn || (turn.role !== "learner" && turn.role !== "tutor") || typeof turn.text !== "string") throw new Error("Reflection conversation contains an invalid turn.");
    return { role: turn.role, text: turn.text };
  });
}

export async function submitReflectionAttempt(request: SubmitReflectionAttemptRequest): Promise<ReflectionTurn[]> {
  const response = cleanReflectionText(request.response, "Reflection response");
  const conversation = assertConversation(request.conversation);
  await request.submitAttempt({
    lessonId: request.lessonId,
    blockId: request.blockId,
    privateGuidance: request.privateGuidance,
    evidence: { kind: "reflection", response, conversation }
  });
  return [...conversation, { role: "learner", text: response }];
}

export function appendTutorFeedback(conversation: ReflectionTurn[], feedback: string): ReflectionTurn[] {
  const thread = assertConversation(conversation);
  const text = cleanReflectionText(feedback, "Tutor feedback");
  return [...thread, { role: "tutor", text }];
}
