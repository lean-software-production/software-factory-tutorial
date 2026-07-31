import { readFile } from "node:fs/promises";

const MINIMUM_NODE_VERSION = [22, 19, 0];

function versionAtLeast(actual, required) {
  for (let index = 0; index < required.length; index += 1) {
    if (actual[index] > required[index]) return true;
    if (actual[index] < required[index]) return false;
  }
  return true;
}

export function assertSupportedNodeVersion(version = process.versions.node) {
  const parsed = version.split(".").map(Number);
  if (!versionAtLeast(parsed, MINIMUM_NODE_VERSION)) {
    throw new Error(`Node.js ${MINIMUM_NODE_VERSION.join(".")} or later is required; found ${version}.`);
  }
}

function parseKeyValue(value) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(".local/secrets.envrc contains an empty OPENCODE_API_KEY.");
  if (!trimmed.startsWith('"')) return trimmed;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "string" || !parsed) throw new Error("not a non-empty string");
    return parsed;
  } catch {
    throw new Error(".local/secrets.envrc contains a malformed OPENCODE_API_KEY.");
  }
}

export async function loadOpencodeApiKey(file, environment = process.env) {
  const exported = environment.OPENCODE_API_KEY?.trim();
  if (exported) return exported;

  let contents;
  try {
    contents = await readFile(file, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return undefined;
    throw error;
  }

  const match = contents.match(/^\s*(?:export\s+)?OPENCODE_API_KEY\s*=\s*(.+?)\s*$/m);
  if (!match?.[1]) return undefined;
  return parseKeyValue(match[1]);
}

export async function requireOpencodeApiKey(file, environment = process.env) {
  const key = await loadOpencodeApiKey(file, environment);
  if (!key) throw new Error("OPENCODE_API_KEY is not configured. Run 'npm run setup' or export it in your shell.");
  return key;
}
