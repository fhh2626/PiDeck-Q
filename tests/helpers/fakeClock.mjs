/** Deterministic wall clock and timeout queue; never waits for real heartbeat/TTL windows. */
export function createFakeClock(start = 1_000_000) {
	let now = start;
	let nextId = 0;
	const timers = new Map();
	class FakeDate extends Date {
		constructor(...args) { super(...(args.length ? args : [now])); }
		static now() { return now; }
	}
	return {
		get now() { return now; },
		get pendingTimers() { return timers.size; },
		globals: {
			Date: FakeDate,
			setTimeout(callback, delay = 0) {
				const handle = { id: ++nextId, unref() {} };
				timers.set(handle, { at: now + Math.max(0, delay), callback });
				return handle;
			},
			clearTimeout(handle) { timers.delete(handle); },
		},
		advance(ms) {
			const target = now + ms;
			let iterations = 0;
			while (true) {
				const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
				if (!next) break;
				assertBound(++iterations);
				const [handle, timer] = next;
				now = timer.at;
				timers.delete(handle);
				timer.callback();
			}
			now = target;
		},
	};
}

function assertBound(iterations) {
	if (iterations > 10_000) throw new Error("Fake clock detected a non-advancing timeout loop");
}
