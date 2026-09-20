import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

test("Phase 0.1: extractResendContent correctly extracts flat and nested Pi images", () => {
	const { extractResendContent } = loadTsCommonJs("src/main/pi/SessionHistoryReader.ts");
	assert.equal(typeof extractResendContent, "function", "extractResendContent must be an exported function");

	const flatImageContent = [
		{ type: "text", text: "请看图" },
		{ type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", mimeType: "image/png" },
	];
	const flatResult = extractResendContent(flatImageContent);
	assert.equal(flatResult.text, "请看图");
	assert.equal(flatResult.images?.length, 1);
	assert.equal(flatResult.images[0].mimeType, "image/png");

	const nestedImageContent = [
		{ type: "text", text: "嵌套格式" },
		{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" } },
	];
	const nestedResult = extractResendContent(nestedImageContent);
	assert.equal(nestedResult.text, "嵌套格式");
	assert.equal(nestedResult.images?.length, 1);
	assert.equal(nestedResult.images[0].mimeType, "image/jpeg");
});

test("Phase 0.2: SessionScanner preserves image-only user messages with image placeholder", async () => {
	const { SessionScanner } = loadTsCommonJs("src/main/sessions/SessionScanner.ts");
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-scanner-test-"));

	try {
		const filePath = join(tempDir, "test-session.jsonl");
		const lines = [
			JSON.stringify({ type: "session", id: "sess-1", timestamp: "2026-01-01T00:00:00.000Z" }),
			JSON.stringify({
				type: "message",
				id: "msg-1",
				timestamp: "2026-01-01T00:00:01.000Z",
				message: {
					role: "user",
					content: [
						{ type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", mimeType: "image/png" },
					],
				},
			}),
		];
		writeFileSync(filePath, lines.join("\n") + "\n", "utf8");

		const scanner = new SessionScanner((key) => (key === "session.imagePlaceholder" ? "[图片]" : key), tempDir);
		const messages = await scanner.readChatMessages(filePath);

		assert.equal(messages.length, 1, "Image-only user message must not be dropped");
		assert.equal(messages[0].role, "user");
		assert.equal(messages[0].text, "[图片]");
		assert.equal(messages[0].images?.length, 1);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("Phase 0.3: ExternalFileCapabilityStore rejects unissued picker paths", () => {
	const { ExternalFileCapabilityStore, ExternalFileCapabilityError } = loadTsCommonJs(
		"src/main/fs/ExternalFileCapabilityStore.ts",
	);
	const store = new ExternalFileCapabilityStore();

	assert.throws(
		() => {
			store.consumeRead("non-existent-cap", "C:\\fake\\unauthorized.png");
		},
		ExternalFileCapabilityError,
	);
});
