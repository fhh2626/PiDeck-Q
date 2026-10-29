import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("步骤5测试: SessionMessageTimeline 动效 pin 接线及 useTimelineInteractionPins 参数放宽验证", async () => {
	const timelineSrc = await fs.readFile("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");
	const pinsHookSrc = await fs.readFile("src/renderer/src/hooks/useTimelineInteractionPins.ts", "utf8");

	// 1. SessionMessageTimeline 必须调用 pinAnimationByMessageId
	assert.ok(
		timelineSrc.includes("pinAnimationByMessageId("),
		"SessionMessageTimeline.tsx 必须调用 pinAnimationByMessageId",
	);

	// 2. SessionMessageTimeline 不得再调用 acquirePin 或 releasePin
	assert.equal(
		timelineSrc.includes("acquirePin("),
		false,
		"SessionMessageTimeline.tsx 严禁直接调用 acquirePin",
	);
	assert.equal(
		timelineSrc.includes("releasePin("),
		false,
		"SessionMessageTimeline.tsx 严禁直接调用 releasePin",
	);

	// 3. useTimelineInteractionPins 中 pinAnimationByMessageId 声明与实现的参数类型必须包含 ReadonlyMap
	assert.ok(
		pinsHookSrc.includes("rowKeyByMessageId: ReadonlyMap<string, TimelineRowKey>"),
		"useTimelineInteractionPins.ts 中 rowKeyByMessageId 参数类型必须为 ReadonlyMap",
	);
});
