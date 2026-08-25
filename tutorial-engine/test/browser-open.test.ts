import { describe, expect, it } from "vitest";
import { browserCommand } from "../src/workbook/browser-open.js";

const URL = "http://127.0.0.1:4310";

describe("browserCommand", () => {
  it("prefers BROWSER, which is how a devcontainer offers the host's browser", () => {
    expect(browserCommand(URL, { BROWSER: "/vscode/vscode-server/bin/helpers/browser.sh" }, "linux"))
      .toEqual({ command: "/vscode/vscode-server/bin/helpers/browser.sh", args: [URL] });
  });

  it("ignores an empty or blank BROWSER rather than spawning nothing", () => {
    expect(browserCommand(URL, { BROWSER: "  " }, "linux")).toEqual({ command: "xdg-open", args: [URL] });
    expect(browserCommand(URL, { BROWSER: "" }, "darwin")).toEqual({ command: "open", args: [URL] });
  });

  it("falls back to the platform opener", () => {
    expect(browserCommand(URL, {}, "linux")).toEqual({ command: "xdg-open", args: [URL] });
    expect(browserCommand(URL, {}, "darwin")).toEqual({ command: "open", args: [URL] });
    expect(browserCommand(URL, {}, "win32")).toEqual({ command: "cmd", args: ["/c", "start", URL] });
  });
});
