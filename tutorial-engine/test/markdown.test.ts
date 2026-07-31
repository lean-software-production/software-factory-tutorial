import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FileExcerptCodeBlock, Markdown } from "../web/src/markdown.js";

describe("Markdown", () => {
  it("renders GitHub-Flavored Markdown tables", () => {
    const markup = renderToStaticMarkup(createElement(Markdown, {
      children: "| Step | Status |\n| --- | --- |\n| Build | Done |"
    }));

    expect(markup).toContain("<table>");
    expect(markup).toContain("<th>Step</th>");
    expect(markup).toContain("<td>Done</td>");
  });

  it("highlights declared fenced-code languages without changing inline code", () => {
    const markup = renderToStaticMarkup(createElement(Markdown, {
      children: "Use `answer` inline.\n\n```ts\nconst answer: number = 42;\n```"
    }));

    expect(markup).toContain("<code>answer</code>");
    expect(markup).toContain('class="hljs language-ts"');
    expect(markup).toContain('class="hljs-keyword">const</span>');
    expect(markup).toContain('aria-label="Copy code"');
  });

  it("renders a highlighted, copyable file excerpt using its extension", () => {
    const markup = renderToStaticMarkup(createElement(FileExcerptCodeBlock, {
      path: "src/example.ts",
      source: "const answer: number = 42;"
    }));

    expect(markup).toContain('class="code-language">typescript</span>');
    expect(markup).toContain('class="hljs language-typescript"');
    expect(markup).toContain('class="hljs-keyword">const</span>');
    expect(markup).toContain(">Copy</button>");
  });
});
