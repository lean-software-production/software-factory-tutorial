import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionWorkspaceManager, type TutorialSessionPaths } from "../../tutorial-engine/src/session-workspace.js";
import { startWorkbookServer, type StartedWorkbookServer, type WorkbookServerOptions } from "../../tutorial-engine/src/workbook/server.js";
import type { EvaluationWorkspace } from "./types.js";

export interface CreateEvaluationWorkspaceOptions {
  fixtureRoot?: string;
  tempParent?: string;
  keep?: boolean;
}

const defaultFixtureRoot = resolve(import.meta.dirname, "../workbook");

export async function createEvaluationWorkspace(options: CreateEvaluationWorkspaceOptions = {}): Promise<EvaluationWorkspace> {
  const repositoryRoot = await mkdtemp(join(options.tempParent ?? tmpdir(), "v2-eval-repository-"));
  const root = resolve(repositoryRoot, "tutorial");
  const webRoot = resolve(repositoryRoot, "web");
  const servers = new Set<StartedWorkbookServer>();
  const sessions: TutorialSessionPaths[] = [];
  let closed = false;

  await mkdir(root, { recursive: true });
  await cp(options.fixtureRoot ?? defaultFixtureRoot, root, { recursive: true });
  await mkdir(resolve(root, "factory"), { recursive: true });
  await mkdir(resolve(root, "calculator"), { recursive: true });
  await writeFile(resolve(root, "factory/.gitkeep"), "");
  await writeFile(resolve(root, "calculator/.gitkeep"), "");
  await mkdir(webRoot, { recursive: true });
  await writeFile(resolve(webRoot, "index.html"), "<!doctype html><title>V2 evaluator workbook</title><div id=\"root\"></div>\n");

  return {
    repositoryRoot,
    root,
    webRoot,
    sessions,
    latestSession() {
      const session = sessions.at(-1);
      if (!session) throw new Error("No evaluation session has started.");
      return session;
    },
    async startServer(serverOptions: Partial<Omit<WorkbookServerOptions, "target" | "webRoot" | "session">> = {}) {
      if (closed) throw new Error("Evaluation workspace is already closed.");
      const session = await (await SessionWorkspaceManager.create(root)).createSession();
      sessions.push(session);
      const server = await startWorkbookServer({ ...serverOptions, target: root, webRoot, session });
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
      if (!options.keep) await rm(repositoryRoot, { recursive: true, force: true });
    }
  };
}
