import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { startInputLatencyMonitor } = loadTsCommonJs("src/renderer/src/inputLatencyMonitor.ts");

function createHarness({ supported = ["event", "longtask"] } = {}) {
	const observers = [];
	class FakeObserver {
		static supportedEntryTypes = supported;
		constructor(callback) {
			this.callback = callback;
			this.type = null;
			this.disconnected = false;
			observers.push(this);
		}
		observe(options) {
			this.type = options.type;
			this.options = options;
		}
		disconnect() {
			this.disconnected = true;
		}
		emit(entries) {
			this.callback({ getEntries: () => entries });
		}
	}
	let clock = 1_000;
	const timers = [];
	const reports = [];
	const stop = startInputLatencyMonitor({
		report: (report) => reports.push(report),
		PerformanceObserverImpl: FakeObserver,
		now: () => clock,
		setTimer: (callback, delayMs) => timers.push({ callback, delayMs }),
		countDomNodes: () => 27_000,
	});
	const byType = (type) => observers.find((observer) => observer.type === type);
	return {
		stop,
		reports,
		timers,
		advance: (ms) => { clock += ms; },
		events: (entries) => byType("event").emit(entries),
		tasks: (entries) => byType("longtask")?.emit(entries),
		observers,
	};
}

function eventEntry(name, startTime, duration, processing = 5) {
	return { name, startTime, duration, processingStart: startTime + 2, processingEnd: startTime + 2 + processing };
}

test("slow keyboard/IME events are aggregated into one report per window without input content", () => {
	const h = createHarness();
	h.tasks([{ startTime: 900, duration: 75 }]); // 早于第一条慢事件到达，但在回看窗口内
	h.events([
		eventEntry("keydown", 1_000, 120),
		eventEntry("compositionupdate", 1_050, 180, 3),
		eventEntry("pointermove", 1_060, 400), // 非输入事件忽略
		eventEntry("input", 1_100, 40), // 低于阈值忽略
	]);
	h.events([eventEntry("compositionend", 1_200, 110)]);
	assert.equal(h.timers.length, 1, "一个窗口只安排一次汇总");
	assert.equal(h.timers[0].delayMs, 10_000);
	h.advance(10_000);
	h.timers[0].callback();
	assert.equal(h.reports.length, 1);
	const [report] = h.reports;
	assert.equal(report.slowEvents, 3);
	assert.equal(JSON.stringify(report.byType), JSON.stringify({ keydown: 1, compositionupdate: 1, compositionend: 1 }));
	assert.equal(report.worst.name, "compositionupdate");
	assert.equal(report.worst.durationMs, 180);
	assert.equal(report.worst.inputDelayMs, 2);
	assert.equal(report.worst.processingMs, 3);
	assert.equal(report.worst.presentationDelayMs, 175);
	assert.equal(report.longTasks, 1);
	assert.equal(report.longestTaskMs, 75);
	assert.equal(report.domNodes, 27_000);
	assert.ok(!("key" in report.worst) && !("data" in report.worst), "不记录按键内容");
});

test("no report is produced when nothing is slow, and a new window starts after a flush", () => {
	const h = createHarness();
	h.events([eventEntry("keydown", 1_000, 30)]);
	assert.equal(h.timers.length, 0);
	h.events([eventEntry("keyup", 1_000, 150)]);
	h.timers[0].callback();
	h.events([eventEntry("keydown", 20_000, 130)]);
	assert.equal(h.timers.length, 2, "上一窗口汇总后，新的慢事件开启新窗口");
	h.timers[1].callback();
	assert.equal(h.reports.length, 2);
	assert.equal(h.reports[1].slowEvents, 1);
});

test("unsupported environments are a silent no-op; stop disconnects observers and suppresses pending reports", () => {
	const unsupported = createHarness({ supported: ["longtask"] });
	assert.equal(unsupported.observers.length, 0);
	unsupported.stop();

	const h = createHarness();
	h.events([eventEntry("keydown", 1_000, 200)]);
	h.stop();
	assert.ok(h.observers.every((observer) => observer.disconnected));
	h.timers[0].callback();
	assert.equal(h.reports.length, 0);
});

test("a throwing reporter never breaks input handling", () => {
	const observers = [];
	class FakeObserver {
		static supportedEntryTypes = ["event"];
		constructor(callback) { this.callback = callback; observers.push(this); }
		observe() {}
		disconnect() {}
	}
	const timers = [];
	startInputLatencyMonitor({
		report: () => { throw new Error("log failed"); },
		PerformanceObserverImpl: FakeObserver,
		now: () => 0,
		setTimer: (callback) => timers.push(callback),
		countDomNodes: () => 1,
	});
	observers[0].callback({ getEntries: () => [eventEntry("keydown", 0, 200)] });
	assert.doesNotThrow(() => timers[0]());
});
