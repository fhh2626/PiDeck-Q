import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { withHookHost } from "./helpers/l5_hookHost.mjs";

const require = createRequire(import.meta.url);
const { Provider, createStore } = require("jotai");

/** Keep the real row presentation store across virtual unmounts and remounts. */
async function withTurnExecution(initial, run) {
	await withHookHost(async ({ React, load, mount, act }) => {
		const presentation = load("src/renderer/src/atoms/timeline-presentation.ts");
		const context = load("src/renderer/src/components/session/timeline/timelinePresentationContext.tsx");
		const { useTurnExecution } = load("src/renderer/src/components/session/turn/useTurnExecution.ts", {
			stubs: {
				"../../../atoms/timeline-presentation": presentation,
				"../timeline/timelinePresentationContext": context,
			},
		});
		const store = createStore();
		const sessionId = "turn-collapse-lifecycle";
		const props = {
			agentRunning: false,
			isComplete: true,
			hasFinalAnswer: true,
			isLatestRun: false,
			collapsePrevRunsOnNewTurn: true,
			newTurnCollapseTick: 3,
			...initial,
		};
		const probe = await mount(useTurnExecution, props, (node) =>
			React.createElement(Provider, { store },
				React.createElement(context.TimelinePresentationProvider, { sessionId, rowKey: "run:answer" }, node)),
		);
		try {
			await run({ probe, props, act });
		} finally {
			await probe.unmount();
			presentation.removeSessionPresentationState(sessionId);
		}
	});
}

test("an optimistic next user cannot replay the latest run's already observed collapse tick", async () => {
	await withTurnExecution({ isLatestRun: true }, async ({ probe, props, act }) => {
		await act(() => probe.result().setStepsVisibleFromUser(true));
		assert.equal(probe.result().stepsVisible, true);
		// The next send appends its local user before delivery has been accepted.
		await probe.rerender({ ...props, isLatestRun: false });
		assert.equal(probe.result().stepsVisible, true);
	});
});

test("a newly accepted turn still collapses a historical run that the user opened", async () => {
	await withTurnExecution({}, async ({ probe, props, act }) => {
		await act(() => probe.result().setStepsVisibleFromUser(true));
		assert.equal(probe.result().stepsVisible, true);
		await probe.rerender({ ...props, newTurnCollapseTick: 4 });
		assert.equal(probe.result().stepsVisible, false);
	});
});

test("enabling automatic collapse does not replay turns observed while the setting was disabled", async () => {
	await withTurnExecution({ collapsePrevRunsOnNewTurn: false }, async ({ probe, props, act }) => {
		await act(() => probe.result().setStepsVisibleFromUser(true));
		await probe.rerender({ ...props, newTurnCollapseTick: 4 });
		assert.equal(probe.result().stepsVisible, true);
		await probe.rerender({ ...props, collapsePrevRunsOnNewTurn: true, newTurnCollapseTick: 4 });
		assert.equal(probe.result().stepsVisible, true);
		await probe.rerender({ ...props, collapsePrevRunsOnNewTurn: true, newTurnCollapseTick: 5 });
		assert.equal(probe.result().stepsVisible, false);
	});
});

test("a latest run remounted as history preserves expansion when no new turn was accepted", async () => {
	await withTurnExecution({ isLatestRun: true }, async ({ probe, props, act }) => {
		await act(() => probe.result().setStepsVisibleFromUser(true));
		await probe.unmount();
		await probe.rerender({ ...props, isLatestRun: false });
		assert.equal(probe.result().stepsVisible, true);
	});
});

test("a virtual remount consumes a missed new turn once and preserves later manual expansion", async () => {
	await withTurnExecution({}, async ({ probe, props, act }) => {
		await act(() => probe.result().setStepsVisibleFromUser(true));
		await probe.unmount();
		await probe.rerender({ ...props, newTurnCollapseTick: 4 });
		assert.equal(probe.result().stepsVisible, false);
		await act(() => probe.result().setStepsVisibleFromUser(true));
		await probe.unmount();
		await probe.rerender({ ...props, newTurnCollapseTick: 4 });
		assert.equal(probe.result().stepsVisible, true);
	});
});
