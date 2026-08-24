import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("LazyPanel stores a loaded function component without invoking it as a state updater", () => {
  const source = fs.readFileSync(
    path.resolve("src/renderer/src/components/workspace/DrawerSurface.tsx"),
    "utf8"
  );

  assert.match(source, /setComponent\(\(\)\s*=>\s*Component\)/);
  assert.doesNotMatch(source, /setComponent\(Component\)/);
});
