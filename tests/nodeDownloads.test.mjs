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

test("NodeDownloads rejects a content-length larger than expected before creating a file", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pideck-download-oversized-header-"));
	const filePath = join(tempDir, "update.zip");
	try {
		const downloads = new NodeDownloads({
			fetch: async () => new Response("too-large", {
				status: 200,
				headers: { "content-length": "9" },
			}),
		});
		await assert.rejects(
			() => downloads.downloadToFile({ url: "https://example.test/update.zip", filePath, expectedBytes: 8 }),
			/size exceeds expected bytes/,
		);
		await assert.rejects(() => stat(filePath), { code: "ENOENT" });
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("NodeDownloads strips sensitive headers and releases redirect bodies across origins", async () => {
	const calls = [];
	let redirectBodyCancelled = false;
	const redirectBody = new ReadableStream({
		cancel() {
			redirectBodyCancelled = true;
		},
	});
	const downloads = new NodeDownloads({
		fetch: async (input, init) => {
			calls.push({ input: String(input), headers: { ...(init?.headers ?? {}) } });
			if (calls.length === 1) return new Response(redirectBody, { status: 302, headers: { location: "https://other.test/update.zip" } });
			return new Response("complete", { status: 200 });
		},
	});
	const tempDir = await mkdtemp(join(tmpdir(), "pideck-download-redirect-headers-"));
	try {
		await downloads.downloadToFile({
			url: "https://example.test/update.zip",
			filePath: join(tempDir, "update.zip"),
			headers: {
				authorization: "Bearer secret",
				cookie: "session=secret",
				"proxy-authorization": "Basic secret",
				"user-agent": "PiDeck",
			},
		});
		assert.equal(calls[1].headers.authorization, undefined);
		assert.equal(calls[1].headers.cookie, undefined);
		assert.equal(calls[1].headers["proxy-authorization"], undefined);
		assert.equal(calls[1].headers["user-agent"], "PiDeck");
		assert.equal(redirectBodyCancelled, true);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("NodeDownloads aborts a response that never returns headers", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pideck-download-header-timeout-"));
	const controllerSignals = [];
	try {
		const downloads = new NodeDownloads({
			fetch: async (_input, init) => new Promise((_, reject) => {
				controllerSignals.push(init?.signal);
				init?.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
			}),
		}, { headerTimeoutMs: 10, totalTimeoutMs: 100 });
		await assert.rejects(
			() => downloads.downloadToFile({ url: "https://example.test/update.zip", filePath: join(tempDir, "update.zip") }),
			/headers timed out/,
		);
		assert.equal(controllerSignals.length, 1);
		assert.equal(controllerSignals[0].aborted, true);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("NodeDownloads aborts a response whose body stays idle", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pideck-download-body-timeout-"));
	try {
		const body = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("partial"));
			},
		});
		const downloads = new NodeDownloads({
			fetch: async () => new Response(body, { status: 200 }),
		}, { bodyIdleTimeoutMs: 10, totalTimeoutMs: 100 });
		await assert.rejects(
			() => downloads.downloadToFile({ url: "https://example.test/update.zip", filePath: join(tempDir, "update.zip") }),
			/Download body timed out/,
		);
		await assert.rejects(() => stat(join(tempDir, "update.zip")), { code: "ENOENT" });
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
