import assert from "node:assert/strict";
import test from "node:test";
import { filePathFromHref, normalizeLocalFilePath, normalizeLocalFileTarget, resolveFileLinkPath, resolveLocalFileTarget } from "../src/renderer/src/utils/fileLinks.ts";

test("G1/Red: normalizeLocalFileTarget parses standard Windows file URL", () => {
	const res = normalizeLocalFileTarget("file:///R:/Temp/example.png", "win32");
	assert.equal(res.ok, true);
	if (res.ok) {
		assert.equal(res.path, "R:/Temp/example.png");
	}
});

test("G1/Red: normalizeLocalFileTarget supports legacy file://R:/Temp/example.png format", () => {
	const res = normalizeLocalFileTarget("file://R:/Temp/example.png", "win32");
	assert.equal(res.ok, true);
	if (res.ok) {
		assert.equal(res.path, "R:/Temp/example.png");
	}
});

for (const suffix of ["#section", "?raw=1", "?raw=1#section"]) {
	test(`legacy Windows file URLs separate ${suffix} from the disk target`, () => {
		const target = normalizeLocalFileTarget(`file://R:/Temp/a%23b%2520.png${suffix}`, "win32");
		assert.deepEqual(target, { ok: true, path: "R:/Temp/a#b%20.png" });
		assert.deepEqual(target, normalizeLocalFileTarget(`file:///R:/Temp/a%23b%2520.png${suffix}`, "win32"));
	});
}

test("G1/Red: normalizeLocalFileTarget handles spaces, Chinese, #, literal %20, and preserves literal %20 in plain paths", () => {
	// Spaces
	const space = normalizeLocalFileTarget("file:///R:/Temp/a%20b.png", "win32");
	assert.equal(space.ok, true);
	if (space.ok) assert.equal(space.path, "R:/Temp/a b.png");

	// Chinese
	const cn = normalizeLocalFileTarget("file:///R:/Temp/%E5%88%98%E5%93%A5.png", "win32");
	assert.equal(cn.ok, true);
	if (cn.ok) assert.equal(cn.path, "R:/Temp/刘哥.png");

	// # (%23)
	const hash = normalizeLocalFileTarget("file:///R:/Temp/a%23b.png", "win32");
	assert.equal(hash.ok, true);
	if (hash.ok) assert.equal(hash.path, "R:/Temp/a#b.png");

	// Literal %20 (%2520) in URL
	const litUrl = normalizeLocalFileTarget("file:///R:/Temp/a%2520b.png", "win32");
	assert.equal(litUrl.ok, true);
	if (litUrl.ok) assert.equal(litUrl.path, "R:/Temp/a%20b.png");

	// Plain path with %20 must keep literal %20 (not decoded to space)
	const plain = normalizeLocalFileTarget("R:\\Temp\\a%20b.png", "win32");
	assert.equal(plain.ok, true);
	if (plain.ok) assert.equal(plain.path, "R:\\Temp\\a%20b.png");
});

test("G1/Red: normalizeLocalFileTarget preserves UNC paths on Windows and POSIX paths on linux/darwin", () => {
	const unc = normalizeLocalFileTarget("file://server/share/a.png", "win32");
	assert.equal(unc.ok, true);
	if (unc.ok) assert.equal(unc.path, "\\\\server\\share\\a.png");

	const posix = normalizeLocalFileTarget("file:///tmp/a.png", "linux");
	assert.equal(posix.ok, true);
	if (posix.ok) assert.equal(posix.path, "/tmp/a.png");
});

test("G1/Red: normalizeLocalFileTarget rejects invalid percent encoding, encoded separators, and external links", () => {
	const invalidPercent = normalizeLocalFileTarget("file:///R:/Temp/%ZZ.png", "win32");
	assert.equal(invalidPercent.ok, false);

	// Encoded separators %2F / %5C in file URL segment
	const encodedSep1 = normalizeLocalFileTarget("file:///R:/Temp/a%2Fb.png", "win32");
	assert.equal(encodedSep1.ok, false);

	const encodedSep2 = normalizeLocalFileTarget("file:///R:/Temp/a%5Cb.png", "win32");
	assert.equal(encodedSep2.ok, false);

	// External links should not be accepted as local file target
	const http = normalizeLocalFileTarget("https://example.com/a.png", "win32");
	assert.equal(http.ok, false);
});

for (const platform of ["linux", "darwin"]) {
	test(`${platform} file targets preserve an absolute directory that resembles a Windows drive`, () => {
		const path = "/C:/reports/summary.md";
		assert.deepEqual(resolveLocalFileTarget(`file://${path}`, "/workspace", platform), { ok: true, path });
		assert.deepEqual(resolveLocalFileTarget(path, "/workspace", platform), { ok: true, path });
		assert.equal(resolveFileLinkPath(path, "/workspace", platform), path);
		assert.equal(normalizeLocalFilePath(path, platform), path);
		assert.equal(filePathFromHref(path, platform), path);
	});
}

test("Windows file targets still normalize URL-shaped drive paths", () => {
	assert.deepEqual(resolveLocalFileTarget("/C:/reports/summary.md", "D:/workspace", "win32"), {
		ok: true, path: "C:/reports/summary.md",
	});
});
