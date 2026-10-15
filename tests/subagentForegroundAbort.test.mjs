import assert from "node:assert/strict";
import test from "node:test";
import { createForegroundAbortScope } from "../resources/extensions/pideck-q-subagents/src/runs/foreground/foreground-abort.ts";

for (const detached of [false, true]) {
	for (const retained of [false, true]) {
		test(`foreground abort forwarding: detached=${detached}, attached workflow=${retained}`, () => {
			const owner = new AbortController();
			let isDetached = false;
			const scope = createForegroundAbortScope({ origin: owner.signal, isDetached: () => isDetached, retainAbortOnDetach: retained });
			isDetached = detached;
			const reason = new Error("originating workflow deadline reached");
			owner.abort(reason);
			assert.equal(scope.controller.signal.aborted, !detached || retained);
			if (scope.controller.signal.aborted) assert.equal(scope.controller.signal.reason, reason);
			scope.dispose();
		});
	}
}

test("a completed foreground scope removes its origin listener", () => {
	const owner = new AbortController();
	const scope = createForegroundAbortScope({ origin: owner.signal, isDetached: () => true, retainAbortOnDetach: true });
	scope.dispose();
	owner.abort();
	assert.equal(scope.controller.signal.aborted, false);
});

test("a workflow started with an aborted origin cannot hide the cancellation behind detach", () => {
	const owner = new AbortController();
	owner.abort(new Error("already cancelled"));
	const scope = createForegroundAbortScope({ origin: owner.signal, isDetached: () => true, retainAbortOnDetach: true });
	assert.equal(scope.controller.signal.aborted, true);
	assert.equal(scope.controller.signal.reason, owner.signal.reason);
	scope.dispose();
});
