import { expect, test } from "@playwright/test";
import type { ChatMessage } from "../../src/shared/types";

/** A delayed page must remain in its own session cache when the user switches. */
test("late PC history page cannot inject messages into another selected session", async ({ page }) => {
	page.on("pageerror", (error) => { throw error; });
	let releaseOld = () => {};
	const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
	let markStarted = () => {};
	const started = new Promise<void>((resolve) => { markStarted = resolve; });
	const message = (session: string): ChatMessage => ({
		id: `${session}-user`, agentId: session, role: "user", text: `Prompt ${session}`, timestamp: 1000,
		meta: { entryId: `${session}-entry` },
	});
	await page.route("**/api/**", async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === "/api/state") {
			await route.fulfill({ json: {
				projects: [{ id: "project", name: "project", path: "/project" }],
				sessions: ["old", "new"].map((id) => ({ id, projectId: "project", title: `Session ${id}`, status: "idle", messageCount: 1 })),
				runtimes: [], messagesBySession: {},
			} });
		} else if (path === "/api/models") {
			await route.fulfill({ json: { models: [] } });
		} else if (path.endsWith("/messages/turn-page")) {
			const session = path.includes("/old/") ? "old" : "new";
			if (session === "old") { markStarted(); await oldGate; }
			await route.fulfill({ json: { messages: [message(session)], total: 1, nextBefore: null } });
		} else {
			await route.fulfill({ json: {} });
		}
	});
	await page.goto("/tests/browser/webPcPromptReconciliation.html");
	await page.locator(".project-row").first().click();
	await page.getByRole("button", { name: "Session old", exact: true }).click();
	await started;
	await page.getByRole("button", { name: "Session new", exact: true }).click();
	await expect(page.locator(".user-turn")).toHaveText(["Prompt new"]);
	const returned = page.waitForResponse((response) => response.url().includes("/old/messages/turn-page"));
	releaseOld();
	await returned;
	await expect(page.locator(".user-turn")).toHaveText(["Prompt new"]);
	// Reopening uses the correctly isolated old cache instead of fetching/injecting the new turn.
	await page.getByRole("button", { name: "Session old", exact: true }).click();
	await expect(page.locator(".user-turn")).toHaveText(["Prompt old"]);
});
