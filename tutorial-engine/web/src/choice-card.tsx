import { useState } from "react";
import { ChoiceIcon } from "./choice-icon.js";
import type { BrowserMessage, TutorialEvent } from "../../src/protocol/events.js";

type ChoiceCardProps = {
  event: Extract<TutorialEvent, { type: "choice" }>;
  send: (message: BrowserMessage) => void;
  disabled: boolean;
  selectedOptionId?: string;
};

export function ChoiceCard({ event, send, disabled, selectedOptionId }: ChoiceCardProps) {
  const [chosen, setChosen] = useState<string>();
  const selected = event.options.find((option) => option.id === selectedOptionId);
  const resolved = selectedOptionId !== undefined;
  const unavailable = disabled || event.historical || resolved || Boolean(chosen);

  return <article className="card choice"><h2>Your choice</h2><p>{event.question}</p><div className="options">{event.options.map((option) => <button key={option.id} disabled={unavailable} onClick={() => { setChosen(option.id); send({ type: "choose", choiceId: event.id, optionId: option.id }); }}><span className="choice-option-label"><ChoiceIcon category={option.icon} /><strong>{option.label}</strong></span>{option.description && <span className="choice-option-description">{option.description}</span>}</button>)}</div>{selected && <p className="muted">Selected: {selected.label}</p>}{event.historical && <p className="muted">This was a choice from the saved session.</p>}</article>;
}
