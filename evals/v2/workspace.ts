import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startWorkbookServer, type StartedWorkbookServer, type WorkbookServerOptions } from "../../tutorial-engine/src/workbook/server.js";
import type { EvaluationWorkspace } from "./types.js";

export interface CreateEvaluationWorkspaceOptions {
  fixtureRoot?: string;
  tempParent?: string;
  keep?: boolean;
}

const defaultFixtureRoot = resolve(import.meta.dirname, "../workbook");

export async function createEvaluationWorkspace(options: CreateEvaluationWorkspaceOptions = {}): Promise<EvaluationWorkspace> {
  const root = await mkdtemp(join(options.tempParent ?? tmpdir(), "v2-eval-workbook-"));
  const webRoot = resolve(root, "web");
  const servers = new Set<StartedWorkbookServer>();
  let closed = false;

  await cp(options.fixtureRoot ?? defaultFixtureRoot, root, { recursive: true });
  await mkdir(webRoot, { recursive: true });
  await writeFile(resolve(webRoot, "index.html"), "<!doctype html><title>V2 evaluator workbook</title><div id=\"root\"></div>\n");

  return {
    root,
    webRoot,
    async startServer(serverOptions: Partial<Omit<WorkbookServerOptions, "target" | "webRoot">> = {}) {
      if (closed) throw new Error("Evaluation workspace is already closed.");
      const server = await startWorkbookServer({ ...serverOptions, target: root, webRoot });
      servers.add(server);
      const close = server.close.bind(server);
      return {
        ...server,
        close: async () => {
          if (!servers.has(server)) return;
          servers.delete(server);
          await close();
        }
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([...servers].map((server) => server.close()));
      servers.clear();
      if (!options.keep) await rm(root, { recursive: true, force: true });
    }
  };
}
