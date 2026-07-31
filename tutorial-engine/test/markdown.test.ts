import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "../web/src/markdown.js";

describe("Markdown", () => {
  it("renders GitHub-Flavored Markdown tables", () => {
    const markup = renderToStaticMarkup(createElement(Markdown, {
      children: "| Step | Status |\n| --- | --- |\n| Build | Done |"
    }));

    expect(markup).toContain("<table>");
    expect(markup).toContain("<th>Step</th>");
    expect(markup).toContain("<td>Done</td>");
  });
});
