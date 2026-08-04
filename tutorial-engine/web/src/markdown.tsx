import { Children, isValidElement, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
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

  return <div className={wrapsLines(language) ? "code-block wrap" : "code-block"}>
    <div className="code-block-toolbar">
      {language && <span className="code-language">{language}</span>}
      <button className="copy-code" type="button" onClick={() => void copy()} aria-label="Copy code">
        {copyStatus === "copied" ? "Copied" : copyStatus === "failed" ? "Copy failed" : "Copy"}
      </button>
    </div>
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

export function Markdown({ children }: { children: string }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{ pre: CodeBlockFromPre }}>{children}</ReactMarkdown></div>;
}
