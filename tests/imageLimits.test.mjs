import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
const {
	applyImageDisplayBudget,
} = loadTsCommonJs("src/shared/imageLimits.ts");

test("applyImageDisplayBudget: enforces single image size, count, and per-turn budget", () => {
	// 1. 单图超 4 MiB 过滤
	const oversized = [{ type: "image", data: "A".repeat(5 * 1024 * 1024), mimeType: "image/png" }];
	const res1 = applyImageDisplayBudget(oversized);
	assert.equal(res1.images.length, 0);
	assert.equal(res1.notice?.kind, "too-large");

	// 2. 单消息超过 8 张截断
	const nineImages = Array.from({ length: 9 }, () => ({
		type: "image",
		data: "AAAA",
		mimeType: "image/png",
	}));
	const res2 = applyImageDisplayBudget(nineImages);
	assert.equal(res2.images.length, 8);
	assert.equal(res2.notice?.kind, "too-many");
	assert.equal(res2.notice?.omitted, 1);

	// 3. 单轮累计超过 8 MiB 截断
	const twoLargeImages = [
		{ type: "image", data: "A".repeat(3 * 1024 * 1024), mimeType: "image/png" },
	];
	// 假设本轮已经用了 6 MiB，再来 3 MiB 会超出 8 MiB
	const res3 = applyImageDisplayBudget(twoLargeImages, {
		currentTurnUsedBytes: 6 * 1024 * 1024,
	});
	assert.equal(res3.images.length, 0);
	assert.equal(res3.notice?.kind, "too-many");
});
