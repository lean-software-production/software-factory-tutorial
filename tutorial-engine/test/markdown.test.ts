import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

    expect(markup).not.toContain("code-block-toolbar");
    expect(markup).not.toContain("code-language");
    expect(markup).toContain('class="hljs language-typescript"');
    expect(markup).toContain('class="hljs-keyword">const</span>');
    expect(markup).toContain('aria-label="Copy code"');
    expect(markup).toContain('title="Copy code"');
    expect(markup).not.toContain(">Copy</button>");
  });

  it("wraps prose excerpts so a long line cannot widen the page", () => {
    const prose = renderToStaticMarkup(createElement(FileExcerptCodeBlock, {
      path: "factory/success.md",
      source: "The calculator passes its tests, reveals its intention, carries no duplication, and uses the fewest elements the behaviour requires."
    }));
    const findings = renderToStaticMarkup(createElement(FileExcerptCodeBlock, {
      path: "factory/refactor/validate-findings.txt",
      source: "VERDICT: FAIL\n\nFINDINGS:\n- [FAIL] no duplication: the same branch appears in parse() and format(), which is what this refactoring was supposed to remove."
    }));

    expect(prose).toContain('class="code-block wrap"');
    expect(findings).toContain('class="code-block wrap"');
  });

  it("lets code excerpts scroll rather than breaking a command across lines", () => {
    const shell = renderToStaticMarkup(createElement(FileExcerptCodeBlock, {
      path: "factory/refactor/run.sh",
      source: "cat validate.md success.md quality-before.txt | (cd ../../calculator && pi --no-session --tools read,grep,find,ls,bash -p)"
    }));

    expect(shell).toContain('class="code-block"');
    expect(shell).not.toContain("code-block wrap");
  });
});

describe("the transcript's layout", () => {
  const styles = readFileSync(fileURLToPath(new URL("../web/src/styles.css", import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const declarations = (selector: string) =>
    styles.split("}").find((rule) => rule.split("{")[0]?.trim() === selector)?.split("{")[1] ?? "";

  it("lets a card shrink below its content, or nothing else can scroll or wrap", () => {
    // main and .transcript are grids, and a grid child defaults to
    // min-width: auto — it refuses to shrink below its content's own width. A
    // single long line then widens the card, the transcript and the page, and
    // the overflow rules below never get a chance to apply. Wrapping the
    // excerpt was not enough on its own; this is the other half of it.
    expect(declarations("main > *, .transcript > *, header > *")).toContain("min-width: 0");
  });

  it("keeps code blocks readable with an overlaid icon-only copy control", () => {
    expect(declarations(".markdown")).toContain("overflow-x: auto");
    expect(declarations(".code-block")).toContain("position: relative");
    expect(declarations(".copy-code")).toContain("position: absolute");
    expect(declarations(".copy-code")).toContain("right: 9px");
    expect(declarations(".code-block pre")).toContain("font-size: 1rem");
    expect(declarations(".code-block.wrap pre")).toContain("white-space: pre-wrap");
    expect(styles).not.toContain("code-block-toolbar");
  });
});
