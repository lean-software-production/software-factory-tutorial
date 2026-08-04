/**
 * Which command opens a URL, kept separate from startup so the rules stay testable.
 */

export interface BrowserCommand {
  command: string;
  args: string[];
}

/**
 * BROWSER first: that is how an environment hands over a browser it can actually
 * reach. A VS Code devcontainer sets it to a helper that opens the URL on the
 * host and forwards the port, and the container has no xdg-open of its own.
 */
export function browserCommand(url: string, environment: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): BrowserCommand {
  const browser = environment.BROWSER?.trim();
  if (browser) return { command: browser, args: [url] };
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", url] };
  return { command: "xdg-open", args: [url] };
}
