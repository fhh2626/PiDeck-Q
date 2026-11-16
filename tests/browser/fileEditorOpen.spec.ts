import { expect, test, type Page } from "@playwright/test";
import type {} from "./fileEditorOpen.fixture";

function gate() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
}
type Write = { path: string; content: string };

/** Real renderer calls use local intercepted storage. No native or external request is simulated as measured I/O. */
async function storage(page: Page, readGates = new Map<string, ReturnType<typeof gate>>(), writeGate?: ReturnType<typeof gate>) {
	const writes: Write[] = [];
	const readPaths: string[] = [];
	const disk = new Map([
		["/project/a.txt", "First plain file"], ["/project/b.txt", "Second plain file"],
		["/project/a.json", '{"first":true}'], ["/project/b.json", '{"second":true}'],
	]);
	await page.route("**/file-editor-test/**", async (route) => {
		const url = new URL(route.request().url());
		if (url.pathname.endsWith("/read")) {
			const path = url.searchParams.get("path") ?? "";
			readPaths.push(path);
			await readGates.get(path)?.promise;
			await route.fulfill({ body: disk.get(path) ?? "" });
		} else {
			const body: unknown = route.request().postDataJSON();
			if (!body || typeof body !== "object") throw new Error("Invalid write");
			const path: unknown = Reflect.get(body, "path");
			const content: unknown = Reflect.get(body, "content");
			if (typeof path !== "string" || typeof content !== "string") throw new Error("Invalid write fields");
			writes.push({ path, content });
			if (path === "/project/a.txt") await writeGate?.promise;
			disk.set(path, content);
			await route.fulfill({ status: 204 });
		}
	});
	return { writes, disk, readPaths };
}

async function openFixture(page: Page) {
	await page.goto("/tests/browser/fileEditorOpen.html");
	await expect(page.getByRole("link", { name: "a.txt", exact: true })).toBeVisible();
	await expect.poll(() => page.evaluate(() => Boolean(window.fileEditorOpenFixture))).toBe(true);
}

test("JSON text is editable while a cold parser request is held, and its read overlaps parser loading", async ({ page }) => {
	const language = gate();
	const read = gate();
	let languageRequested = false;
	await page.route(/(?:codemirror_lang-json|@codemirror\/lang-json)/, async (route) => {
		languageRequested = true;
		await language.promise;
		await route.continue();
	});
	const server = await storage(page, new Map([["/project/a.json", read]]));
	try {
		await openFixture(page);
		await page.getByRole("link", { name: "a.json", exact: true }).click();
		await expect.poll(() => server.readPaths).toEqual(["/project/a.json"]);
		await expect.poll(() => languageRequested).toBe(true);
		await expect(page.locator(".cm-content")).toHaveCount(0);
		read.release();
		await expect(page.locator(".cm-content")).toContainText('{"first":true}', { timeout: 1000 });
		await page.locator(".cm-content").fill('{"edited":true}');
		await expect.poll(() => server.writes.length).toBe(1);
		expect(server.writes[0]).toEqual({ path: "/project/a.json", content: '{"edited":true}' });
		language.release();
		await expect(page.locator(".cm-content")).toContainText('{"edited":true}');
		await test.info().attach("controlled-file-read-to-dom", {
			body: JSON.stringify(await page.evaluate(() => window.fileEditorOpenFixture?.reads())), contentType: "application/json",
		});
	} finally {
		read.release(); language.release();
	}
});

test("a late file read cannot replace the file selected by a newer link click", async ({ page }) => {
	const first = gate();
	const server = await storage(page, new Map([["/project/a.txt", first]]));
	try {
		await openFixture(page);
		await page.getByRole("link", { name: "a.txt", exact: true }).click();
		await expect.poll(() => server.readPaths.length).toBe(1);
		await page.getByRole("link", { name: "b.txt", exact: true }).click();
		await expect(page.locator(".cm-content")).toContainText("Second plain file");
		first.release();
		await expect.poll(() => page.evaluate(() => window.fileEditorOpenFixture?.reads().filter((entry) => entry.returnedAt !== undefined).length)).toBe(2);
		await expect(page.locator(".cm-content")).toContainText("Second plain file");
		expect(await page.evaluate(() => window.fileEditorOpenFixture?.originalReads())).toBe(0);
	} finally { first.release(); }
});

test("an old save reply preserves newer input after switching files", async ({ page }) => {
	const firstWrite = gate();
	const server = await storage(page, new Map(), firstWrite);
	try {
		await openFixture(page);
		await page.getByRole("link", { name: "a.txt", exact: true }).click();
		await expect(page.locator(".cm-content")).toContainText("First plain file");
		await page.locator(".cm-content").fill("Edited first file");
		await page.keyboard.press("Control+s");
		await expect.poll(() => server.writes.length).toBe(1);
		await page.getByRole("link", { name: "b.txt", exact: true }).click();
		await expect(page.locator(".cm-content")).toContainText("Second plain file");
		await page.locator(".cm-content").fill("Edited second file");
		firstWrite.release();
		await expect.poll(() => server.disk.get("/project/b.txt")).toBe("Edited second file");
		await expect(page.locator(".cm-content")).toContainText("Edited second file");
		await page.getByRole("button", { name: "Close editor", exact: true }).click();
		await expect(page.locator(".cm-editor")).toHaveCount(0);
	} finally { firstWrite.release(); }
});
