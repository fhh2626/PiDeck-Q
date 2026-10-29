import assert from "node:assert/strict";
import test from "node:test";
import {
	TOOL_GROUP_PAGE_SIZE,
	resolveToolGroupPage,
	findRunningToolPage,
} from "../src/renderer/src/components/session/timeline/toolGroupPage.ts";

test("resolveToolGroupPage handles various total tool counts", () => {
	assert.equal(TOOL_GROUP_PAGE_SIZE, 40);

	// 0 条
	const p0 = resolveToolGroupPage(0, 0);
	assert.deepEqual(p0, {
		pageIndex: 0,
		pageCount: 0,
		startIndex: 0,
		endIndex: 0,
		canPrevious: false,
		canNext: false,
	});

	// 40 条（恰好 1 页）
	const p40 = resolveToolGroupPage(40, 0);
	assert.equal(p40.pageCount, 1);
	assert.equal(p40.startIndex, 0);
	assert.equal(p40.endIndex, 40);
	assert.equal(p40.canNext, false);

	// 41 条（2 页）
	const p41 = resolveToolGroupPage(41, 0);
	assert.equal(p41.pageCount, 2);
	assert.equal(p41.startIndex, 0);
	assert.equal(p41.endIndex, 40);
	assert.equal(p41.canNext, true);

	// 662 条（真实场景：17 页）
	const p662First = resolveToolGroupPage(662, 0);
	assert.equal(p662First.pageCount, 17);
	assert.equal(p662First.startIndex, 0);
	assert.equal(p662First.endIndex, 40);
	assert.equal(p662First.canPrevious, false);
	assert.equal(p662First.canNext, true);

	// 最后一页（第 16 页，0-based）
	const p662Last = resolveToolGroupPage(662, 16);
	assert.equal(p662Last.pageIndex, 16);
	assert.equal(p662Last.startIndex, 640);
	assert.equal(p662Last.endIndex, 662); // 恰好 22 条
	assert.equal(p662Last.canNext, false);
	assert.equal(p662Last.canPrevious, true);
});

test("resolveToolGroupPage sanitizes invalid, negative or oversized page requests", () => {
	// 负数转为 0
	const pNeg = resolveToolGroupPage(100, -5);
	assert.equal(pNeg.pageIndex, 0);

	// 超出末页夹到末页（100 条共 3 页，最大索引 2）
	const pOver = resolveToolGroupPage(100, 99);
	assert.equal(pOver.pageIndex, 2);

	// 非有限数
	const pNaN = resolveToolGroupPage(100, Number.NaN);
	assert.equal(pNaN.pageIndex, 0);
});

test("findRunningToolPage locates first running tool page and respects stopped", () => {
	const statuses = new Array(100).fill("done");
	statuses[65] = "running"; // 属于第 1 页（40..79）

	assert.equal(findRunningToolPage(statuses, false), 1);
	// 若 stopped 为 true，不再提供 locator
	assert.equal(findRunningToolPage(statuses, true), null);

	// 若没有 running
	statuses[65] = "done";
	assert.equal(findRunningToolPage(statuses, false), null);
});
