import { JSDOM } from "jsdom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
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

let mountedRoot: Root | undefined;
let dom: JSDOM | undefined;

afterEach(async () => {
  if (mountedRoot) await act(async () => { mountedRoot!.unmount(); });
  mountedRoot = undefined;
  dom?.window.close();
  dom = undefined;
  vi.unstubAllGlobals();
});

async function mount(element: ReactNode) {
  dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "http://localhost/" });
  vi.stubGlobal("window", dom.window as any);
  vi.stubGlobal("document", dom.window.document as any);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement as any);
  vi.stubGlobal("Event", dom.window.Event as any);
  vi.stubGlobal("navigator", dom.window.navigator as any);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = dom.window.document.getElementById("root")!;
  mountedRoot = createRoot(container);
  await act(async () => { mountedRoot!.render(element); });
  return container;
}

describe("ChoiceCard", () => {
  it("disables every choice locally after choosing an option", async () => {
    const send = vi.fn();
    const container = await mount(<ChoiceCard event={event} disabled={false} send={send} />);
    const buttons = Array.from(container.querySelectorAll("button"));

    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.disabled)).toBe(false);

    await act(async () => {
      buttons[0]!.dispatchEvent(new dom!.window.MouseEvent("click", { bubbles: true }));
    });

    expect(send).toHaveBeenCalledWith({ type: "choose", choiceId: "choice-1", optionId: "continue" });
    expect(buttons.every((button) => button.disabled)).toBe(true);
  });

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
