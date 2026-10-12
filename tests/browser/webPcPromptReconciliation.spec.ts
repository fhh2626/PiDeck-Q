import { expect, test } from "@playwright/test";
import type { ChatMessage } from "../../src/shared/types";
import type { WebState } from "../../src/renderer/src/web/webTypes";

/** Gates let the test choose order without sleeping or relying on network timing. */
function gate() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
}

function transcript(history: boolean): ChatMessage[] {
	const offset = history ? 5 : 0;
	const prefix = history ? "session-history" : "pc-live";
	return [
		{ id: `${prefix}-user`, agentId: "agent", role: "user", text: "PC prompt", timestamp: 1000 + offset,
			...(history ? { meta: { entryId: "entry-user" } } : {}) },
		{ id: `${prefix}-answer`, agentId: "agent", role: "assistant", text: "Intermediate response", timestamp: 1100 + offset,
			...(history ? { meta: { entryId: "entry-answer" } } : {}) },
		{ id: `${prefix}-tool`, agentId: "agent", role: "tool", text: "read", timestamp: 1200 + offset,
			meta: { toolName: "read", toolCallId: "call-read", args: { path: "file.txt" }, status: history ? "success" : "running",
				...(history ? { entryId: "entry-tool", detailText: "read result" } : {}) } },
	];
}

for (const { historyFirst, earlyRows } of [
	{ historyFirst: false, earlyRows: 0 },
	{ historyFirst: true, earlyRows: 0 },
	{ historyFirst: false, earlyRows: 1 },
	{ historyFirst: false, earlyRows: 2 },
]) {
	const early = earlyRows > 0;
	test(`PC snapshot/history/SSE reconcile in real WebChatApp (${early ? `${earlyRows === 1 ? "user-only" : "intermediate-answer"} race then tools` : historyFirst ? "history first" : "snapshot first"})`, async ({ page }) => {
		page.on("pageerror", (error) => { throw error; });
		const historyGate = gate();
		const streamGate = gate();
		const historyStarted = gate();
		const streamStarted = gate();
		let idle = false;
		let stateReads = 0;
		let toolsAvailable = !early;
		let posts = 0;
		const state = (): WebState => ({
			projects: [{ id: "project", name: "project", path: "/project" }],
			sessions: [{ id: "session", projectId: "project", title: "PC session", status: idle ? "idle" : "running", messageCount: 3 }],
			runtimes: [{ sessionId: "session", agentId: "agent", runtimeGeneration: 1, status: idle ? "idle" : "running", isStreaming: !idle }],
			messagesBySession: { session: historyFirst && stateReads === 1 ? []
				: toolsAvailable ? transcript(idle && !early) : transcript(false).slice(0, earlyRows) },
		});
		await page.route("**/api/**", async (route) => {
			const path = new URL(route.request().url()).pathname;
			if (route.request().method() === "POST") posts++;
			if (path === "/api/state") {
				stateReads++;
				await route.fulfill({ json: state() });
			} else if (path === "/api/models") {
				await route.fulfill({ json: { models: [] } });
			} else if (path.endsWith("/messages/turn-page")) {
				historyStarted.release();
				await historyGate.promise;
				await route.fulfill({ json: { messages: early ? transcript(true).slice(0, earlyRows) : transcript(true), total: 3, nextBefore: null } });
			} else if (path.endsWith("/stream")) {
				streamStarted.release();
				await streamGate.promise;
				const frames = [
					{ type: "start", messageId: "sse-run" },
					{ type: "text-start", id: "text-1" },
					{ type: "text-delta", id: "text-1", delta: "Intermediate response" },
					{ type: "text-end", id: "text-1" },
					{ type: "tool-input-available", toolCallId: "call-read", toolName: "read", input: { path: "file.txt" } },
					{ type: "tool-output-available", toolCallId: "call-read", output: "read result" },
					{ type: "finish" },
				];
				await route.fulfill({ contentType: "text/event-stream", headers: { "x-vercel-ai-ui-message-stream": "v1" },
					body: frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n" });
			} else {
				await route.fulfill({ json: {} });
			}
		});
		await page.goto("/tests/browser/webPcPromptReconciliation.html");
		await page.locator(".project-row").first().click();
		await page.getByRole("button", { name: /PC session/ }).first().click();
		await historyStarted.promise;
		await streamStarted.promise;
		if (historyFirst) {
			historyGate.release();
			await expect.poll(() => stateReads).toBeGreaterThan(1);
		} else {
			await expect.poll(() => stateReads).toBeGreaterThan(1);
			historyGate.release();
		}
		if (early) {
			// Give the early disk page a full polling cycle to enter the real cache
			// before the identifying tool arrives; releasing both responses at once
			// would accidentally test only the easy first-merge path.
			const beforeEarlyPoll = stateReads;
			await expect.poll(() => stateReads).toBeGreaterThan(beforeEarlyPoll);
		}
		idle = true;
		toolsAvailable = true;
		streamGate.release();
		await expect(page.locator(".user-turn")).toHaveCount(1);
		await expect(page.locator(".user-turn")).toHaveText(["PC prompt"]);
		// A later poll must not put the original runtime UUID back below the intermediate reply.
		const before = stateReads;
		await expect.poll(() => stateReads).toBeGreaterThan(before);
		await expect(page.locator(".user-turn")).toHaveCount(1);
		await expect(page.locator(".execution-summary-toggle")).toHaveCount(1);
		await page.locator(".execution-summary-toggle").click();
		await expect(page.getByText("Intermediate response", { exact: true })).toHaveCount(1);
		await expect(page.locator('[data-tool-name="read"]')).toHaveCount(1);
		await expect(page.locator('[data-tool-name="read"]')).toHaveAttribute("data-status", "done");
		expect(posts).toBe(0);
	});
}

/** Exercise final-frame cache commit followed by repeated stale idle polls and catch-up. */
test("stale idle snapshots keep final SSE text and tools until the snapshot catches up", async ({ page }) => {
	page.on("pageerror", (error) => { throw error; });
	const streamGate = gate();
	const streamStarted = gate();
	const historyDelivered = gate();
	let idle = false;
	let complete = false;
	let stateReads = 0;
	let posts = 0;
	const finalRows: ChatMessage[] = [
		{ id: "final-thinking", agentId: "agent", role: "assistant", text: "", thinking: "Late reasoning", timestamp: 1300 },
		{ id: "final-write", agentId: "agent", role: "tool", text: "write", timestamp: 1400,
			meta: { toolName: "write", toolCallId: "call-write", args: { path: "result.txt" }, status: "success", detailText: "write result" } },
		{ id: "final-answer", agentId: "agent", role: "assistant", text: "Final answer absent from old snapshot", timestamp: 1500 },
	];
	const state = (): WebState => ({
		projects: [{ id: "project", name: "project", path: "/project" }],
		sessions: [{ id: "session", projectId: "project", title: "PC session", status: idle ? "idle" : "running", messageCount: 3 }],
		runtimes: [{ sessionId: "session", agentId: "agent", runtimeGeneration: 1, status: idle ? "idle" : "running", isStreaming: !idle }],
		messagesBySession: { session: [...transcript(idle), ...(complete ? finalRows : [])] },
	});
	await page.route("**/api/**", async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (route.request().method() === "POST") posts++;
		if (path === "/api/state") {
			await route.fulfill({ json: state() });
			stateReads++;
		} else if (path === "/api/models") {
			await route.fulfill({ json: { models: [] } });
		} else if (path.endsWith("/messages/turn-page")) {
			await route.fulfill({ json: { messages: transcript(true), total: 3, nextBefore: null } });
			historyDelivered.release();
		} else if (path.endsWith("/stream")) {
			streamStarted.release();
			await streamGate.promise;
			const frames = [
				{ type: "start", messageId: "sse-final" },
				{ type: "text-start", id: "intermediate" },
				{ type: "text-delta", id: "intermediate", delta: "Intermediate response" },
				{ type: "text-end", id: "intermediate" },
				{ type: "tool-input-available", toolCallId: "call-read", toolName: "read", input: { path: "file.txt" } },
				{ type: "tool-output-available", toolCallId: "call-read", output: "read result" },
				{ type: "reasoning-start", id: "reasoning" },
				{ type: "reasoning-delta", id: "reasoning", delta: "Late reasoning" },
				{ type: "reasoning-end", id: "reasoning" },
				{ type: "tool-input-available", toolCallId: "call-write", toolName: "write", input: { path: "result.txt" } },
				{ type: "tool-output-available", toolCallId: "call-write", output: "write result" },
				{ type: "text-start", id: "final" },
				{ type: "text-delta", id: "final", delta: "Final answer absent from old snapshot" },
				{ type: "text-end", id: "final" },
				{ type: "finish" },
			];
			await route.fulfill({ contentType: "text/event-stream", headers: { "x-vercel-ai-ui-message-stream": "v1" },
				body: frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n" });
		} else {
			await route.fulfill({ json: {} });
		}
	});
	await page.goto("/tests/browser/webPcPromptReconciliation.html");
	await page.locator(".project-row").first().click();
	await page.getByRole("button", { name: /PC session/ }).first().click();
	await historyDelivered.promise;
	await streamStarted.promise;
	const beforeStream = stateReads;
	await expect.poll(() => stateReads).toBeGreaterThan(beforeStream);
	idle = true;
	streamGate.release();
	await expect(page.getByText("Final answer absent from old snapshot", { exact: true })).toHaveCount(1);
	for (let i = 0; i < 2; i++) {
		const before = stateReads;
		await expect.poll(() => stateReads).toBeGreaterThan(before);
		await expect(page.getByText("Final answer absent from old snapshot", { exact: true })).toHaveCount(1);
	}
	await expect(page.locator(".user-turn")).toHaveCount(1);
	await page.locator(".execution-summary-toggle").click();
	await expect(page.locator('[data-tool-name="write"]')).toHaveCount(1);
	await expect(page.locator('[data-tool-name="write"]')).toHaveAttribute("data-status", "done");
	await expect(page.getByText("Late reasoning", { exact: true })).toHaveCount(1);
	complete = true;
	const beforeCatchUp = stateReads;
	await expect.poll(() => stateReads).toBeGreaterThan(beforeCatchUp);
	await expect(page.getByText("Final answer absent from old snapshot", { exact: true })).toHaveCount(1);
	await expect(page.locator('[data-tool-name="write"]')).toHaveCount(1);
	await expect(page.locator('[data-tool-name="write"]')).toHaveAttribute("data-status", "done");
	expect(posts).toBe(0);
});
