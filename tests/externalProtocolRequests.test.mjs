import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// 主进程外部协议 pending 注册表行为测试（4/4 全场景）：
// - 同 guest 去重：A pending 时 B/C 丢弃
// - cancel 后 cooldown：窗口期内新请求拒绝，过期后可进入
// - confirm 只凭 id：主进程打开的是自己保存的 targetUrl
// - guest 销毁：pending 与 cooldown 一并清理
const source = readFileSync("src/main/browser/externalProtocolRequests.ts", "utf8");

function loadGateway(logger, clockOverrides = {}) {
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: "src/main/browser/externalProtocolRequests.ts",
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, {
		module,
		exports: module.exports,
		require,
		console,
		// vm 沙箱有独立全局：模块内 Date.now 调的是这里的 Date，必须注入可控时钟。
		Date: class extends Date {
			static now() {
				return clockOverrides.now ? clockOverrides.now() : super.now();
			}
		},
	}, { filename: "externalProtocolRequests.ts" });
	return module.exports.createExternalProtocolGateway(logger);
}

test("one pending per guest: B and C are dropped while A is pending", () => {
	const warns = [];
	const gw = loadGateway({ warn: (scope, message, detail) => warns.push(message) });
	const first = gw.request(1, "mailto:a@example.com");
	assert.equal(first.url, "mailto:a@example.com");
	assert.equal(typeof first.id, "string");
	assert.ok(first.id.length > 0);

	// 同 guest 的后续请求直接丢弃（不产生新 id）
	assert.equal(gw.request(1, "mailto:b@example.com"), null);
	assert.equal(gw.request(1, "tel:+987"), null);

	// 不同 guest 不受影响
	const other = gw.request(2, "sms:+111");
	assert.ok(other, "different guest gets its own pending slot");
	assert.equal(other.url, "sms:+111");
	assert.equal(warns.filter((m) => m.includes("already pending")).length, 2);
});

test("confirm resolves by id and returns the main-process-saved target URL", () => {
	const gw = loadGateway();
	const pushed = gw.request(1, "mailto:authoritative@example.com");
	// 即使渲染层声称另一个 URL，confirm 也只按 id 取回主进程保存的值
	assert.equal(gw.confirm(pushed.id), "mailto:authoritative@example.com");
	// confirm 后槽位释放：同 guest 可发起新请求
	assert.ok(gw.request(1, "tel:+222"), "slot freed after confirm");
	// 旧 id 已失效
	assert.equal(gw.confirm(pushed.id), null);
	assert.equal(gw.confirm("nonexistent-id"), null);
});

test("cancel starts a cooldown: requests within the window are dropped", () => {
	const warns = [];
	const gw = loadGateway({ warn: (scope, message, detail) => warns.push(message) });
	const pushed = gw.request(1, "mailto:a@example.com");
	gw.cancel(pushed.id);

	// cooldown 内（默认 2s）：新请求直接拒绝
	assert.equal(gw.request(1, "mailto:b@example.com"), null);
	assert.ok(warns.some((m) => m.includes("cooldown")));

	// 其他 guest 不受该 guest 的 cooldown 影响
	assert.ok(gw.request(3, "tel:+333"), "cooldown is per-guest");
});

test("cooldown expiry lets the same guest request again", () => {
	let fakeNow = Date.now();
	const gw = loadGateway(undefined, { now: () => fakeNow });
	const pushed = gw.request(1, "mailto:a@example.com");
	gw.cancel(pushed.id);
	assert.equal(gw.request(1, "mailto:b@example.com"), null, "still cooling down");

	// 推进可控时钟越过 2s cooldown 窗口
	fakeNow += 2001;
	const next = gw.request(1, "mailto:b@example.com");
	assert.ok(next, "cooldown expired: request accepted");
});

test("guest destroy clears both pending and cooldown", () => {
	const gw = loadGateway();
	const pushed = gw.request(1, "mailto:a@example.com");
	gw.forgetGuest(1);
	assert.equal(gw.confirm(pushed.id), null, "pending gone");

	// cooldown 也被清：forget 后立即可重新请求（对比 cancel 的冷却行为）
	assert.ok(gw.request(1, "mailto:b@example.com"), "no cooldown after destroy");
});
