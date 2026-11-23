import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Model only the scoped batch protocol; production shell semantics have separate real-shell tests. */
export function runFakeScopedTrash(root, identity, pairs, toHost) {
  const hostRoot = toHost(root);
  const actual = statSync(hostRoot, { bigint: true });
  if (`${actual.dev}:${actual.ino}` !== identity || realpathSync.native(hostRoot) !== hostRoot) throw new Error("root identity changed");
  const parent = (relative, create) => {
    let current = hostRoot;
    for (const component of relative ? relative.split("/") : []) {
      if (!component || component === "." || component === "..") throw new Error("unsafe relative path");
      current = join(current, component);
      if (create && !existsSync(current)) mkdirSync(current);
      if (lstatSync(current).isSymbolicLink() || realpathSync.native(current) !== current) throw new Error("redirected directory");
    }
    return current;
  };
  for (let index = 0; index < pairs.length; index += 2) {
    const from = pairs[index], to = pairs[index + 1];
    const source = join(parent(dirname(from) === "." ? "" : dirname(from).replaceAll("\\", "/"), false), basename(from));
    const destination = join(parent(dirname(to).replaceAll("\\", "/"), true), basename(to));
    if (existsSync(destination)) throw new Error("destination exists");
    try { lstatSync(source); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    renameSync(source, destination);
  }
}
