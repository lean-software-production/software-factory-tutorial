import { chmod, stat } from "node:fs/promises";
import { resolve } from "node:path";

// node-pty's Darwin prebuild ships spawn-helper as data in some npm installs.
// posix_spawnp then fails even though the native addon loads. Restore its mode.
const helper = resolve(import.meta.dirname, "../../node_modules/node-pty/prebuilds", `darwin-${process.arch}`, "spawn-helper");
if (process.platform === "darwin") {
  try {
    const mode = (await stat(helper)).mode;
    if ((mode & 0o111) === 0) await chmod(helper, mode | 0o755);
  } catch { /* node-pty may be absent during partial installs. */ }
}
