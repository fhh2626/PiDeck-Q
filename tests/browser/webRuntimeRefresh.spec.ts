import { expect, test } from "@playwright/test";
import type { ChatMessage } from "../../src/shared/types";
import type { WebState } from "../../src/renderer/src/web/webTypes";

/** Poll gates reproduce a busy cache update without relying on a real Agent or network. */
for (const action of ["wait", "send"] as const) {
	test(`busy snapshot reaches the idle Web timeline without reentry (${action})`, async ({ page }) => {
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		let phase: "initial" | "running" | "idle" = "initial";
		let reads = 0;
		let posts = 0;
		const old: ChatMessage[] = [
			{ id: "user", agentId: "agent", role: "user", text: "Original question", timestamp: 1, meta: { entryId: "entry-user" } },
			{ id: "answer", agentId: "agent", role: "assistant", text: "Original reply", timestamp: 2, meta: { entryId: "entry-answer" } },
		];
		const updated: ChatMessage[] = [...old,
			{ id: "write", agentId: "agent", role: "tool", text: "write", timestamp: 3,
				meta: { toolName: "write", toolCallId: "call-write", args: { path: "synthetic.txt", content: "change" }, status: "success" } },
			{ id: "updated-answer", agentId: "agent", role: "assistant", text: "PC update waiting in cache", timestamp: 4, meta: { entryId: "entry-update" } },
		];
		const state = (): WebState => ({
			projects: [{ id: "project", name: "project", path: "/fixture" }],
			sessions: [{ id: "session", projectId: "project", title: "Target session", status: phase === "running" ? "running" : "idle", messageCount: phase === "initial" ? 2 : 4 }],
			runtimes: [{ sessionId: "session", agentId: "agent", runtimeGeneration: 1, status: phase === "running" ? "running" : "idle", isStreaming: false, isExecutingTool: false }],
			messagesBySession: { session: phase === "initial" ? old : updated },
		});
		await page.route("**/api/**", async (route) => {
			const path = new URL(route.request().url()).pathname;
			if (route.request().method() === "POST") posts++;
			if (path === "/api/state") {
				await route.fulfill({ json: state() });
				reads++;
			} else if (path === "/api/models") {
				await route.fulfill({ json: { models: [] } });
			} else if (path.endsWith("/messages/turn-page")) {
				await route.fulfill({ json: { messages: old, total: 2, nextBefore: null } });
			} else if (path === "/api/chat") {
				const frames = [
					{ type: "start", messageId: "new-response" },
					{ type: "text-start", id: "new-text" },
					{ type: "text-delta", id: "new-text", delta: "New Web response" },
					{ type: "text-end", id: "new-text" }, { type: "finish" },
				];
				await route.fulfill({ contentType: "text/event-stream", headers: { "x-vercel-ai-ui-message-stream": "v1" },
					body: frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n" });
			} else {
				await route.fulfill({ json: {} });
			}
		});
		await page.goto("/tests/browser/webPcPromptReconciliation.html");
		await page.locator(".project-row").first().click();
		await page.getByRole("button", { name: /Target session/ }).click();
		await expect(page.getByText("Original reply", { exact: true })).toBeVisible();
		phase = "running";
		const beforeBusy = reads;
		await expect.poll(() => reads).toBeGreaterThan(beforeBusy);
		// The stop button proves the busy state was committed, not merely that
		// a response was sent. Its callback also merged the PC tail into cache.
		await expect(page.locator("form.composer button[type=button]")).toBeVisible();
		await expect(page.getByText("PC update waiting in cache", { exact: true })).toHaveCount(0);
		phase = "idle";
		const beforeIdle = reads;
		await expect.poll(() => reads).toBeGreaterThan(beforeIdle);
		await expect(page.locator("form.composer button[type=submit]")).toBeVisible();
		if (action === "wait") {
			await expect(page.getByText("PC update waiting in cache", { exact: true })).toBeVisible();
			const beforeRepeat = reads;
			await expect.poll(() => reads).toBeGreaterThan(beforeRepeat);
			await expect(page.getByText("PC update waiting in cache", { exact: true })).toHaveCount(1);
			expect(posts).toBe(0);
		} else {
			await page.locator("#prompt").fill("Synthetic Web prompt");
			await page.locator("#prompt").press("Enter");
			await expect(page.getByText("PC update waiting in cache", { exact: true })).toBeVisible();
			// Neither expanding execution details nor reentering the session should be needed.
			await expect(page.getByText("New Web response", { exact: true })).toBeVisible();
			const body = await page.locator("body").innerText();
			expect(body.indexOf("PC update waiting in cache")).toBeLessThan(body.indexOf("Synthetic Web prompt"));
			expect(posts).toBe(1);
		}
		expect(errors).toEqual([]);
	});
}
