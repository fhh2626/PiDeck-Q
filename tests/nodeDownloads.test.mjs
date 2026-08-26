import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { NodeDownloads } = loadTsCommonJs("src/native-node/platform/NodeDownloads.ts");

function createDownloads(body) {
	return new NodeDownloads({
		fetch: async () => new Response(body, { status: 200 }),
	});
}

test("NodeDownloads rejects a truncated response and removes the partial file", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pideck-download-size-mismatch-"));
	const filePath = join(tempDir, "update.zip");
	try {
		await assert.rejects(
			() => createDownloads("partial").downloadToFile({
				url: "https://example.test/update.zip",
				filePath,
				expectedBytes: 100,
			}),
			/Download size mismatch: expected 100, got 7/,
		);
		await assert.rejects(() => stat(filePath), { code: "ENOENT" });
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("NodeDownloads completes when the received size matches expectedBytes", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pideck-download-size-match-"));
	const filePath = join(tempDir, "update.zip");
	try {
		const result = await createDownloads("complete").downloadToFile({
			url: "https://example.test/update.zip",
			filePath,
			expectedBytes: 8,
		});
		assert.equal(result.receivedBytes, 8);
		assert.equal(await readFile(filePath, "utf8"), "complete");
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});
