import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock("mermaid", () => ({ default: mermaid }));
import { FileExcerptCodeBlock, Markdown } from "../web-workbook/src/markdown.js";

describe("Markdown", () => {
  it("renders GitHub-Flavored Markdown tables", () => {
    const markup = renderToStaticMarkup(createElement(Markdown, {
      children: "| Step | Status |\n| --- | --- |\n| Build | Done |"
    }));

    expect(markup).toContain("<table>");
    expect(markup).toContain("<th>Step</th>");
    expect(markup).toContain("<td>Done</td>");
  });

  it("renders authored Mermaid fences as diagram containers but keeps generated Mermaid literal and copyable", () => {
    const authored = renderToStaticMarkup(createElement(Markdown, {
      source: "authored",
      children: "```mermaid\ngraph TD\n  A --> B\n```"
    }));
    const generated = renderToStaticMarkup(createElement(Markdown, {
      children: "```mermaid\ngraph TD\n  A --> B\n```"
    }));

    // Server rendering does not import Mermaid: the browser effect will render this container.
    expect(authored).toContain('class="mermaid-diagram"');
    expect(authored).toContain('aria-busy="true"');
    expect(authored).not.toContain('class="code-block"');
    expect(mermaid.initialize).not.toHaveBeenCalled();
    expect(mermaid.render).not.toHaveBeenCalled();
    expect(generated).not.toContain('class="mermaid-diagram"');
    expect(generated).toContain('class="code-block"');
    expect(generated).toContain('aria-label="Copy code"');
    expect(generated).toContain("graph TD");
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
  const styles = readFileSync(fileURLToPath(new URL("../web-workbook/src/styles.css", import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const declarations = (selector: string) =>
    styles.split("}").find((rule) => rule.split("{")[0]?.trim() === selector)?.split("{")[1] ?? "";


  it("keeps code blocks readable with an overlaid icon-only copy control", () => {
    expect(declarations(".markdown")).toContain("overflow-x: auto");
    expect(declarations(".code-block")).toContain("position: relative");
    expect(declarations(".copy-code")).toContain("position: absolute");
    expect(declarations(".copy-code")).toContain("right: 9px");
    expect(declarations(".code-block pre")).toContain("font-size: 1rem");
    expect(declarations(".code-block.wrap pre")).toContain("white-space: pre-wrap");
  });

  it("bounds Mermaid diagrams within the Markdown column", () => {
    expect(declarations(".mermaid-diagram")).toContain("width: 100%");
    expect(declarations(".mermaid-diagram")).toContain("overflow-x: auto");
    expect(declarations(".mermaid-diagram svg")).toContain("max-width: 100%");
  });
});

let root: Root | undefined;
let dom: JSDOM | undefined;

afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  root = undefined;
  dom?.window.close();
  dom = undefined;
  vi.unstubAllGlobals();
});

async function mountMarkdown(source: "authored" | "generated", children: string) {
  dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>");
  vi.stubGlobal("window", dom.window as any);
  vi.stubGlobal("document", dom.window.document as any);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => { root?.render(createElement(Markdown, { source, children })); });
  return dom.window.document.body;
}

describe("MermaidDiagram", () => {
  it("initialises Mermaid strictly, renders SVG, falls back on errors, and ignores obsolete renders", async () => {
    mermaid.render.mockResolvedValueOnce({ svg: "<svg data-diagram=\"first\"></svg>" });
    const body = await mountMarkdown("authored", "```mermaid\ngraph TD\n  A --> B\n```");
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(mermaid.initialize).toHaveBeenCalledWith({ startOnLoad: false, securityLevel: "strict", htmlLabels: false });
    expect(body.querySelector("svg[data-diagram='first']")).not.toBeNull();

    mermaid.render.mockRejectedValueOnce(new Error("invalid diagram"));
    await act(async () => { root?.render(createElement(Markdown, { source: "authored", children: "```mermaid\nnot a diagram\n```" })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(body.querySelector(".mermaid-diagram")).toBeNull();
    expect(body.querySelector(".code-block")?.textContent).toContain("not a diagram");
    expect(body.querySelector(".copy-code")).not.toBeNull();

    let resolveSlow!: (value: { svg: string }) => void;
    mermaid.render.mockImplementationOnce(() => new Promise((resolve) => { resolveSlow = resolve; }));
    await act(async () => { root?.render(createElement(Markdown, { source: "authored", children: "```mermaid\ngraph TD\n  slow\n```" })); });
    await act(async () => { await Promise.resolve(); });
    mermaid.render.mockResolvedValueOnce({ svg: "<svg data-diagram=\"fast\"></svg>" });
    await act(async () => { root?.render(createElement(Markdown, { source: "authored", children: "```mermaid\ngraph TD\n  fast\n```" })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    resolveSlow({ svg: "<svg data-diagram=\"slow\"></svg>" });
    await act(async () => { await Promise.resolve(); });

    expect(body.querySelector("svg[data-diagram='fast']")).not.toBeNull();
    expect(body.querySelector("svg[data-diagram='slow']")).toBeNull();
  });
});
