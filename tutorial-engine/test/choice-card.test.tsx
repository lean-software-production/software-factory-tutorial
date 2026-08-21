import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChoiceCard } from "../web/src/choice-card.js";

const event = {
  type: "choice" as const,
  id: "choice-1",
  question: "Continue?",
  options: [
    { id: "continue", label: "Continue", icon: "do" as const },
    { id: "pause", label: "Pause", icon: "pause" as const },
  ],
};

describe("ChoiceCard", () => {
  it("leaves active choices enabled until selected, resolved, or historical", () => {
    expect(renderToStaticMarkup(
      <ChoiceCard event={event} disabled={false} send={() => {}} />
    )).not.toContain("disabled=\"\"");

    const resolved = renderToStaticMarkup(
      <ChoiceCard event={event} selectedOptionId="continue" disabled={false} send={() => {}} />
    );
    expect(resolved.match(/disabled=\"\"/g)).toHaveLength(2);
    expect(resolved).toContain("Selected: Continue");

    const historical = renderToStaticMarkup(
      <ChoiceCard event={{ ...event, historical: true }} disabled={false} send={() => {}} />
    );
    expect(historical).toContain("This was a choice from the saved session.");
    expect(historical.match(/disabled=\"\"/g)).toHaveLength(2);
  });
});
