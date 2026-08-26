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

test("NodeDownloads removes a partial file when the network reader fails", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pideck-download-reader-failure-"));
	const filePath = join(tempDir, "update.zip");
	const body = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("partial"));
			controller.error(new Error("network interrupted"));
		},
	});
	try {
		await assert.rejects(
			() => new NodeDownloads({ fetch: async () => new Response(body, { status: 200 }) }).downloadToFile({
				url: "https://example.test/update.zip",
				filePath,
			}),
			/network interrupted/,
		);
		await assert.rejects(() => stat(filePath), { code: "ENOENT" });
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("NodeDownloads turns a WriteStream error into a rejected download", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pideck-download-write-failure-"));
	try {
		await assert.rejects(
			() => createDownloads("content").downloadToFile({
				url: "https://example.test/update.zip",
				filePath: join(tempDir, "missing", "update.zip"),
			}),
			/ENOENT|no such file|cannot find/i,
		);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

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
