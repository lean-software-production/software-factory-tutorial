import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runWorkbookCli } from "../src/workbook/cli.js";

describe("workbook CLI", () => {
  it("starts the normal launch path with the embedded terminal enabled", async () => {
    const close = vi.fn(async () => {});
    const startServer = vi.fn(async () => ({ url: "http://127.0.0.1:4310", port: 4310, host: "127.0.0.1", close }));

    const server = await runWorkbookCli(["/tmp/workbook", "--no-open"], {
      startServer,
      installSignalHandlers: false,
      packageDirectory: "/pkg",
      logger: { info: vi.fn() },
    });

    expect(server).toBeDefined();
    expect(startServer).toHaveBeenCalledOnce();
    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({
      target: "/tmp/workbook",
      webRoot: resolve("/pkg", "dist/web-workbook"),
      embeddedTerminal: true,
    }));
    expect(startServer.mock.calls[0]![0]).not.toHaveProperty("terminalPtyFactory");
    expect(startServer.mock.calls[0]![0]).not.toHaveProperty("terminalObserver");
  });
});
