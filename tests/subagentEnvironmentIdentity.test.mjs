import assert from "node:assert/strict";
import test from "node:test";
import {
	isBundledSubagents,
	isSubagent,
} from "../resources/extensions/pideck-q-subagents/src/policy/environment/toolMetadata.ts";

test("isSubagent accepts official pi-subagents and bundled pideck-q-subagents, rejects third-party subagents", () => {
	// 1. 官方 npm 包
	const officialNpmTool = {
		name: "subagent",
		sourceInfo: { source: "npm:pi-subagents", path: "C:/app/node_modules/pi-subagents/dist/index.js" },
	};
	assert.equal(isSubagent(officialNpmTool), true);

	// 2. 打包内置 pideck-q-subagents.ts
	const bundledFileTool = {
		name: "subagent",
		sourceInfo: { source: "file", path: "D:/Users/app/resources/extensions/pideck-q-subagents.ts" },
	};
	assert.equal(isSubagent(bundledFileTool), true);
	assert.equal(isBundledSubagents(bundledFileTool), true);

	// 3. 打包内置目录 pideck-q-subagents/
	const bundledDirTool = {
		name: "subagent",
		sourceInfo: { source: "file", path: "D:/Users/app/resources/extensions/pideck-q-subagents/index.ts" },
	};
	assert.equal(isSubagent(bundledDirTool), true);

	// 4. source 带有 pideck-q-subagents
	const bundledSourceTool = {
		name: "subagent",
		sourceInfo: { source: "file:pideck-q-subagents.ts" },
	};
	assert.equal(isSubagent(bundledSourceTool), true);

	// 5. 第三方 subagent（即使名字叫 subagent，但不是 pi-subagents 且不是 pideck-q-subagents）必须拒绝
	const thirdPartyTool1 = {
		name: "subagent",
		sourceInfo: { source: "npm:custom-subagent", path: "C:/app/node_modules/custom-subagent/index.js" },
	};
	assert.equal(isSubagent(thirdPartyTool1), false, "Third-party subagent package must be rejected");

	const thirdPartyTool2 = {
		name: "subagent",
		sourceInfo: { source: "file", path: "C:/Users/test/.pi/agent/extensions/rogue-subagent.ts" },
	};
	assert.equal(isSubagent(thirdPartyTool2), false, "Unknown path subagent must be rejected");

	// 6. 其他工具名
	const bashTool = {
		name: "bash",
		sourceInfo: { path: "D:/Users/app/resources/extensions/pideck-q-subagents.ts" },
	};
	assert.equal(isSubagent(bashTool), false);
});
