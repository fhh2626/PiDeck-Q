import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Read complete diagnostic records from an isolated backend fixture's own logs. */
export function appLogLines(fixture) {
  const directory = join(fixture.userData, "logs");
  if (!existsSync(directory)) return [];
  const lines = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".log")) continue;
    for (const line of readFileSync(join(directory, name), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { lines.push(JSON.parse(line)); }
      catch { /* A last record can still be flushing; a later observation reads it again. */ }
    }
  }
  return lines;
}
