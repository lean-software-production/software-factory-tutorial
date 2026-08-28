import { Children, isValidElement, useEffect, useId, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

type CodeBlockProps = {
  source: string;
  language?: string;
  className?: string;
  children?: ReactNode;
};

function textContent(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(textContent).join("");
  if (isValidElement<{ children?: ReactNode }>(children)) return textContent(children.props.children);
  return "";
}

function codeChild(children: ReactNode) {
  return Children.toArray(children).find(isValidElement<{ className?: string; children?: ReactNode }>);
}

function languageFromClassName(className?: string): string | undefined {
  return className?.split(" ").find((name) => name.startsWith("language-"))?.slice("language-".length);
}

export function inferCodeLanguage(path: string): string | undefined {
  const filename = path.split("/").at(-1)?.toLowerCase();
  if (!filename) return undefined;
  if (filename === "dockerfile") return "dockerfile";

  const extension = filename.split(".").at(-1);
  const languages: Record<string, string> = {
    bash: "bash", c: "c", cc: "cpp", cjs: "javascript", cpp: "cpp", cs: "csharp", css: "css", cxx: "cpp",
    env: "bash", go: "go", h: "c", hpp: "cpp", html: "html", htm: "html", ini: "ini", java: "java", js: "javascript",
    json: "json", jsx: "javascript", kt: "kotlin", kts: "kotlin", md: "markdown", markdown: "markdown", mjs: "javascript",
    php: "php", py: "python", rb: "ruby", rs: "rust", sass: "scss", scss: "scss", sh: "bash", sql: "sql",
    swift: "swift", toml: "ini", ts: "typescript", tsx: "typescript", xml: "xml", yaml: "yaml", yml: "yaml", zsh: "bash"
  };
  return extension ? languages[extension] : undefined;
}

/**
 * Prose wraps; code scrolls. A long sentence in a Markdown or findings file has
 * no reason to widen the page, but breaking a shell command mid-flag makes it
 * harder to read than a scrollbar does. An unrecognised extension is treated as
 * prose: the files this tutorial shows without a known language are success
 * criteria, prompts and verdicts.
 */
function wrapsLines(language: string | undefined): boolean {
  return language === undefined || language === "markdown";
}

export function CodeBlock({ source, language, className, children }: CodeBlockProps) {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard API is unavailable");
      await navigator.clipboard.writeText(source);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  const copyTitle = copyStatus === "copied" ? "Code copied" : copyStatus === "failed" ? "Copy failed" : "Copy code";
  return <div className={wrapsLines(language) ? "code-block wrap" : "code-block"}>
    <button className="copy-code" type="button" onClick={() => void copy()} aria-label="Copy code" title={copyTitle}>
      <span aria-hidden="true">⧉</span>
    </button>
    <pre><code className={className}>{children ?? source}</code></pre>
    {copyStatus !== "idle" && <p className={copyStatus === "failed" ? "copy-status" : "visually-hidden"} role="status" aria-live="polite">{copyStatus === "copied" ? "Code copied to clipboard." : "Could not copy; select the code and copy it manually."}</p>}
  </div>;
}

type CodeBlockFromPreProps = ComponentPropsWithoutRef<"pre"> & { source?: string; language?: string };

function CodeBlockFromPre({ children, source, language }: CodeBlockFromPreProps) {
  const code = codeChild(children);
  const codeChildren = code?.props.children ?? children;
  return <CodeBlock
    source={source ?? textContent(codeChildren)}
    language={language ?? languageFromClassName(code?.props.className)}
    className={code?.props.className}
  >
    {codeChildren}
  </CodeBlock>;
}

function fenceFor(source: string): string {
  const longestBacktickRun = Math.max(0, ...Array.from(source.matchAll(/`+/g), ([match]) => match.length));
  return "`".repeat(Math.max(3, longestBacktickRun + 1));
}

export function FileExcerptCodeBlock({ path, source }: { path: string; source: string }) {
  const language = inferCodeLanguage(path);
  const fence = fenceFor(source);
  const markdown = `${fence}${language ?? ""}\n${source}${source.endsWith("\n") ? "" : "\n"}${fence}`;

  return <ReactMarkdown
    rehypePlugins={[rehypeHighlight]}
    components={{ pre: (props) => <CodeBlockFromPre {...props} source={source} language={language} /> }}
  >
    {markdown}
  </ReactMarkdown>;
}

type MarkdownSource = "authored" | "generated";
type LessonFrameParts = { before: string; outcomes: readonly string[]; after: string };
type MermaidRender = { source: string; status: "loading" | "success" | "failed"; svg?: string };

const lessonOutcomesMarker = "\n\n## What you will learn\n\n";

/**
 * Lesson frames are formatted by formatLessonFrameBody(). Keep this narrow parser at the display
 * boundary: it turns only that stable shape into a component, while the saved authored Markdown
 * remains unchanged for history and other consumers.
 */
function lessonFrameParts(markdown: string): LessonFrameParts | undefined {
  const markerIndex = markdown.indexOf(lessonOutcomesMarker);
  if (markerIndex < 0) return undefined;

  const before = markdown.slice(0, markerIndex);
  const afterMarker = markdown.slice(markerIndex + lessonOutcomesMarker.length);
  const [outcomeSource, ...afterParts] = afterMarker.split("\n\n");
  const outcomeMatches = outcomeSource?.split("\n").map((line) => line.match(/^- (.+)$/)?.[1]);
  if (!outcomeMatches?.length || outcomeMatches.some((outcome) => outcome === undefined)) return undefined;

  return {
    before,
    outcomes: outcomeMatches.filter((outcome): outcome is string => outcome !== undefined),
    after: afterParts.join("\n\n")
  };
}

let mermaidRenderer: Promise<(typeof import("mermaid"))["default"]> | undefined;

function loadMermaid() {
  mermaidRenderer ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", htmlLabels: false });
    return mermaid;
  });
  return mermaidRenderer;
}

function MermaidDiagram({ source }: { source: string }) {
  const diagramId = `workbook-mermaid-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const [render, setRender] = useState<MermaidRender>({ source, status: "loading" });
  const current = render.source === source ? render : { source, status: "loading" as const };

  useEffect(() => {
    let cancelled = false;
    void loadMermaid().then((mermaid) => mermaid.render(diagramId, source)).then(({ svg }) => {
      if (!cancelled) setRender({ source, status: "success", svg });
    }).catch(() => {
      if (!cancelled) setRender({ source, status: "failed" });
    });
    return () => { cancelled = true; };
  }, [diagramId, source]);

  if (current.status === "failed") return <CodeBlock source={source} language="mermaid" className="language-mermaid" />;
  if (current.status === "success") return <div className="mermaid-diagram" role="img" aria-label="Mermaid diagram" dangerouslySetInnerHTML={{ __html: current.svg ?? "" }} />;
  return <div className="mermaid-diagram" aria-busy="true" aria-label="Loading Mermaid diagram" />;
}

function MarkdownPre({ source, ...props }: ComponentPropsWithoutRef<"pre"> & { source: MarkdownSource }) {
  const code = codeChild(props.children);
  const language = languageFromClassName(code?.props.className);
  if (source === "authored" && language === "mermaid") return <MermaidDiagram source={textContent(code?.props.children ?? props.children)} />;
  return <CodeBlockFromPre {...props} />;
}

export function Markdown({ children, source = "generated", lessonFrame = false }: { children: string; source?: MarkdownSource; lessonFrame?: boolean }) {
  const renderMarkdown = (markdown: string) => <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{ pre: (props) => <MarkdownPre {...props} source={source} /> }}>{markdown}</ReactMarkdown>;
  const frame = lessonFrame ? lessonFrameParts(children) : undefined;

  if (!frame) return <div className="markdown">{renderMarkdown(children)}</div>;

  return <div className="markdown lesson-frame-markdown">
    {frame.before && renderMarkdown(frame.before)}
    <section className="course-compass">
      <h2>What you will learn</h2>
      <ul>{frame.outcomes.map((outcome, index) => <li key={index}>{renderMarkdown(outcome)}</li>)}</ul>
    </section>
    {frame.after && renderMarkdown(frame.after)}
  </div>;
}
