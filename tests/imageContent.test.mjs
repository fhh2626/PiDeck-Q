import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { extractImageContent } = loadTsCommonJs("src/shared/imageContent.ts");

const VALID_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("extractImageContent: non-array input returns empty result without throwing", () => {
	const toPlain = (val) => JSON.parse(JSON.stringify(val));
	assert.deepEqual(toPlain(extractImageContent(null)), { images: [], invalidCount: 0 });
	assert.deepEqual(toPlain(extractImageContent(undefined)), { images: [], invalidCount: 0 });
	assert.deepEqual(toPlain(extractImageContent("hello")), { images: [], invalidCount: 0 });
	assert.deepEqual(toPlain(extractImageContent({})), { images: [], invalidCount: 0 });
});

test("extractImageContent: extracts flat Pi format {type: 'image', data, mimeType}", () => {
	const content = [
		{ type: "text", text: "hello" },
		{ type: "image", data: VALID_B64, mimeType: "image/png" },
	];
	const result = extractImageContent(content);
	assert.equal(result.images.length, 1);
	assert.equal(result.invalidCount, 0);
	const toPlain = (val) => JSON.parse(JSON.stringify(val));
	assert.deepEqual(toPlain(result.images[0]), {
		type: "image",
		data: VALID_B64,
		mimeType: "image/png",
	});
});

test("extractImageContent: extracts flat Pi format with mime_type and defaults missing MIME to image/png", () => {
	const content = [
		{ type: "image", data: VALID_B64, mime_type: "image/jpeg" },
		{ type: "image", data: VALID_B64 }, // missing mime
	];
	const result = extractImageContent(content);
	assert.equal(result.images.length, 2);
	assert.equal(result.invalidCount, 0);
	assert.equal(result.images[0].mimeType, "image/jpeg");
	assert.equal(result.images[1].mimeType, "image/png");
});

test("extractImageContent: extracts nested source format", () => {
	const content = [
		{
			type: "image",
			source: {
				type: "base64",
				data: VALID_B64,
				media_type: "image/webp",
			},
		},
	];
	const result = extractImageContent(content);
	assert.equal(result.images.length, 1);
	assert.equal(result.invalidCount, 0);
	const toPlain = (val) => JSON.parse(JSON.stringify(val));
	assert.deepEqual(toPlain(result.images[0]), {
		type: "image",
		data: VALID_B64,
		mimeType: "image/webp",
	});
});

test("extractImageContent: rejects invalid MIME or malformed base64, counting invalid without dropping valid siblings", () => {
	const content = [
		{ type: "image", data: VALID_B64, mimeType: "image/svg+xml" }, // unsupported MIME
		{ type: "image", data: VALID_B64, mimeType: "" }, // explicitly empty MIME
		{ type: "image", data: "not-valid-base64!", mimeType: "image/png" }, // invalid base64 chars
		{ type: "image", data: "A_B-", mimeType: "image/png" }, // URL-safe base64 rejected
		{ type: "image", data: "A====", mimeType: "image/png" }, // invalid padding
		{ type: "image", data: "", mimeType: "image/png" }, // empty data
		{ type: "image", data: VALID_B64, mimeType: "IMAGE/GIF" }, // case-insensitive valid
		{ type: "image", data: VALID_B64, mimeType: null }, // explicit null MIME rejected
	];
	const result = extractImageContent(content);
	assert.equal(result.images.length, 1);
	assert.equal(result.invalidCount, 7);
	assert.equal(result.images[0].mimeType, "image/gif");
});

test("extractImageContent: large 5 MiB and 8 MiB base64 payloads parsed without stack overflow", () => {
	// 5 MiB = 5 * 1024 * 1024 bytes (multiple of 4)
	const fiveMbB64 = "A".repeat(5 * 1024 * 1024);
	const res5 = extractImageContent([{ type: "image", data: fiveMbB64, mimeType: "image/png" }]);
	assert.equal(res5.images.length, 1);
	assert.equal(res5.invalidCount, 0);

	// 8 MiB = 8 * 1024 * 1024 bytes
	const eightMbB64 = "A".repeat(8 * 1024 * 1024);
	const res8 = extractImageContent([{ type: "image", data: eightMbB64, mimeType: "image/png" }]);
	assert.equal(res8.images.length, 1);
	assert.equal(res8.invalidCount, 0);

	// Valid padding forms: 4k chars with '=' and '==' (total length must be multiple of 4)
	const pad1 = "A".repeat(4092) + "AAA=";
	const pad2 = "A".repeat(4092) + "AA==";
	const resPad = extractImageContent([
		{ type: "image", data: pad1, mimeType: "image/png" },
		{ type: "image", data: pad2, mimeType: "image/png" },
	]);
	assert.equal(resPad.images.length, 2);
	assert.equal(resPad.invalidCount, 0);

	// Large string with invalid character at end returns invalidCount without throwing
	const invalidEnd = "A".repeat(4 * 1024 * 1024 - 1) + "!";
	const resInvalid = extractImageContent([{ type: "image", data: invalidEnd, mimeType: "image/png" }]);
	assert.equal(resInvalid.images.length, 0);
	assert.equal(resInvalid.invalidCount, 1);

	// One valid and one invalid large block: valid sibling retained
	const mixed = extractImageContent([
		{ type: "image", data: fiveMbB64, mimeType: "image/png" },
		{ type: "image", data: invalidEnd, mimeType: "image/png" },
	]);
	assert.equal(mixed.images.length, 1);
	assert.equal(mixed.invalidCount, 1);
});
