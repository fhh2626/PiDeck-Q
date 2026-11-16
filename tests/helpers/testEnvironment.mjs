import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

// Windows runners may expose RUNNER~1 while Qt resolves the same directory to its
// long spelling. Create fixtures under one canonical root; alias-specific tests
// still create their own junctions and alternate spellings explicitly.
if (process.platform === "win32") {
  const root = realpathSync.native(tmpdir());
  process.env.TEMP = root;
  process.env.TMP = root;
}
