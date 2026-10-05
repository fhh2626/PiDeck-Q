import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SessionHistoryReader } = loadTsCommonJs("src/main/pi/SessionHistoryReader.ts");

function createReader(logger) {
	return new SessionHistoryReader({
		toHostPath: (path) => path,
		convertMessages: () => [],
		translate: (key) => key,
		logger,
	});
}

test("新建会话的文件尚不存在时，扫描压缩记录返回空且不产生告警", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-scan-missing-"));
	const warnings = [];
	try {
		const reader = createReader({ warn: (...args) => warnings.push(args), info: () => {}, error: () => {} });
		const result = await reader.scanCompactions(join(dir, "not-created-yet.jsonl"));
		assert.equal(JSON.stringify(result), JSON.stringify({ compactions: [] }));
		assert.deepEqual(warnings, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
