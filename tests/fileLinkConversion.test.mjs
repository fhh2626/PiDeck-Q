import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
const { toInternalFileHref, filePathFromHref, filePathToUri } = loadTsCommonJs("src/renderer/src/utils/fileLinks.ts");
for (const path of ["src/项目/图.png", String.raw`src\folder\a.png`, "src/literal%20.png", "src/literal%5c.png", "../docs/a.md", "settings.json"]) {
  test(`relative internal href preserves raw disk target ${path}`, () => {
    assert.equal(toInternalFileHref(path), path);
    assert.equal(filePathFromHref(toInternalFileHref(path), "win32"), path);
  });
}
for (const [path, platform, expected] of [
  ["C:/项目/My%20File.png", "win32", "C:/项目/My%20File.png"],
  [String.raw`C:\work\a.png`, "win32", "C:/work/a.png"],
  [String.raw`\\server\share\a.png`, "win32", String.raw`\\server\share\a.png`],
  ["/tmp/My%20File.png", "linux", "/tmp/My%20File.png"],
]) test(`standard absolute href roundtrip ${path}`, () => {
  const href = toInternalFileHref(path);
  assert.match(href, /^file:\/\//);
  assert.doesNotMatch(href, /%2f|%5c/i);
  assert.equal(filePathFromHref(href, platform), expected);
});
for (const href of [undefined, null, "", "https://example.com/a.png", "#heading", "file:///C:/bad%2f.png", "file:///C:/bad%5c.png", "file:///C:/bad%ZZ.png", "file://C%3A%2Fwork%2Fa.png"]) {
  test(`invalid/external input remains rejected: ${href}`, () => assert.equal(filePathFromHref(href, "win32"), null));
}
test("UNC remote URI is rejected on POSIX", () => assert.equal(filePathFromHref(filePathToUri(String.raw`\\server\share\a.png`), "linux"), null));
