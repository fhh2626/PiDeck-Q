import { expect, test } from "@playwright/test";
import { WebEventStreamRouter, type PiEvent } from "../../src/main/web/WebEventStream";
import type { ChatMessage } from "../../src/shared/types";
import type { WebState } from "../../src/renderer/src/web/webTypes";

for (const outcome of ["done", "unknown", "lost"]) {
const withResults = outcome === "done";
test(`opening Web during quiet parent tools restores cards across an assistant boundary (${outcome})`, async ({ page }) => {
	let emit: ((agent: string, event: PiEvent, generation?: number) => void) | undefined;
	const router = new WebEventStreamRouter(() => "session");
	router.bindPiSource((handler) => { emit = handler; return () => {}; });
	const names = ["subagent", "bg_wait", "powershell"];
	const messages: ChatMessage[] = [{ id: "user", agentId: "agent", role: "user", text: "Inspect fixture", timestamp: 1 }];
	for (const name of names) {
		emit?.("agent", { type: "tool_execution_start", toolCallId: name, toolName: name, args: { task: "inspect" } }, 1);
		messages.push({ id: `tool-${name}`, agentId: "agent", role: "tool", text: name, timestamp: 2,
			meta: { status: "running", toolName: name, toolCallId: name, args: '{"task":"inspect"}' } });
	}
	const wires: string[] = [];
	const close = router.add("session", (wire) => { wires.push(wire); return true; }, () => {});
	const initialCount = wires.length;
	let finished = false;
	let idleStateReads = 0;
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	// Route.fulfill cannot hold an SSE body open. Feed the real backend router's
	// wires through a controlled stream so useChat stays busy during assertions.
	await page.addInitScript(({ initialWires }) => {
		const originalFetch = window.fetch.bind(window);
		window.fetch = async (input, init) => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
			if (!/^\/api\/sessions\/[^/]+\/stream$/.test(url.pathname)) return originalFetch(input, init);
			const encoder = new TextEncoder();
			const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
			let cleanup = () => {};
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					const onAbort = () => { cleanup(); controller.error(new DOMException("Aborted", "AbortError")); };
					const onMessage = (event: MessageEvent<unknown>) => {
						const data = event.data;
						if (!data || typeof data !== "object" || Reflect.get(data, "type") !== "fixture-tool-finish") return;
						const incoming: unknown = Reflect.get(data, "wires");
						if (!Array.isArray(incoming)) return;
						for (const wire of incoming) if (typeof wire === "string") controller.enqueue(encoder.encode(wire));
						cleanup();
						controller.close();
					};
					cleanup = () => { window.removeEventListener("message", onMessage); signal?.removeEventListener("abort", onAbort); };
					window.addEventListener("message", onMessage);
					signal?.addEventListener("abort", onAbort, { once: true });
					if (signal?.aborted) { onAbort(); return; }
					for (const wire of initialWires) controller.enqueue(encoder.encode(wire));
				},
				cancel() { cleanup(); },
			});
			return new Response(body, { headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" } });
		};
	}, { initialWires: wires.slice() });
	const state = (): WebState => ({
		projects: [{ id: "project", name: "Fixture", path: "/fixture" }],
		sessions: [{ id: "session", projectId: "project", title: "Mid-tool parent", status: finished ? "idle" : "running", messageCount: messages.length }],
		runtimes: [{ sessionId: "session", agentId: "agent", runtimeGeneration: 1, status: finished ? "idle" : "running", isStreaming: false, isExecutingTool: !finished }],
		messagesBySession: { session: messages },
	});
	await page.route("**/api/**", async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === "/api/state") {
			if (finished) idleStateReads++;
			await route.fulfill({ json: state() });
		}
		else if (path === "/api/models") await route.fulfill({ json: { models: [] } });
		else if (path.endsWith("/messages/turn-page")) await route.fulfill({ json: { messages: [messages[0]], total: 1, nextBefore: null } });
		else await route.fulfill({ json: {} });
	});
	try {
		await page.goto("/tests/browser/webPcPromptReconciliation.html");
		await page.locator(".project-row").first().click();
		await page.getByRole("button", { name: /Mid-tool parent/ }).click();
		await page.locator(".execution-summary-toggle").click();
		await page.locator(".tool-group-card > button").click();
		for (const name of names) {
			const card = page.locator(`[data-tool-name="${name}"]`);
			await expect(card).toHaveCount(1);
			await expect(card).toBeVisible();
			await expect(card).toHaveAttribute("data-status", "running");
		}
		// No new Pi event or tool result has arrived since before the page opened.
		expect(wires.length).toBe(initialCount);
		// A missed end followed by another assistant must not split the recovered
		// calls into a different SDK step and create running + unknown duplicates.
		emit?.("agent", { type: "message_start", message: { role: "assistant", id: "next-assistant" } }, 1);
		if (withResults) for (const name of names) emit?.("agent", { type: "tool_execution_end", toolCallId: name, toolName: name }, 1);
		finished = true;
		const finalStatus = withResults ? "done" : "unknown";
		for (const message of messages) if (message.meta) message.meta.status = finalStatus;
		emit?.("agent", { type: "agent_settled" }, 1);
		// Simulate losing the connection before all terminal frames when no result
		// exists: the next idle snapshot must settle cached spinners truthfully.
		await page.evaluate((terminal) => window.postMessage({ type: "fixture-tool-finish", wires: terminal }, "*"), outcome === "lost" ? [] : wires.slice(initialCount));
		await expect.poll(() => idleStateReads).toBeGreaterThan(0);
		for (const name of names) {
			await expect(page.locator(`[data-tool-name="${name}"]`)).toHaveCount(1);
			await expect(page.locator(`[data-tool-name="${name}"]`)).toHaveAttribute("data-status", finalStatus);
		}
		expect(errors).toEqual([]);
	} finally {
		close();
		router.unbindPiSource();
	}
});
}
