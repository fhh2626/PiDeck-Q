import { expect, test, type Page } from "@playwright/test";

type Write = { path: string; content: string };
/** Network gates make busy/failure states observable without sleeps. */
function gate() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
}

async function storage(page: Page, options: { failFirst?: boolean; writeGate?: ReturnType<typeof gate>; readGate?: ReturnType<typeof gate> } = {}) {
	const writes: Write[] = [];
	const persisted = new Map<string, string>();
	let creates = 0;
	await page.route("**/prompt-editor-test/**", async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith("/read")) {
			await options.readGate?.promise;
			const filePath = new URL(route.request().url()).searchParams.get("path") ?? "";
			await route.fulfill({ body: persisted.get(filePath) ?? "Template body" });
		} else if (path.endsWith("/create")) {
			creates++;
			persisted.set("/prompts/editable.md", "---\ndescription: Editable template\n---\n");
			await route.fulfill({ status: 204 });
		} else {
			const value: unknown = route.request().postDataJSON();
			if (!value || typeof value !== "object") throw new Error("Invalid write");
			const filePath: unknown = Reflect.get(value, "path");
			const content: unknown = Reflect.get(value, "content");
			if (typeof filePath !== "string" || typeof content !== "string") throw new Error("Invalid write fields");
			writes.push({ path: filePath, content });
			await options.writeGate?.promise;
			const failed = options.failFirst && writes.length === 1;
			if (!failed) persisted.set(filePath, content);
			await route.fulfill(failed ? { status: 500, body: "disk-full" } : { status: 204 });
		}
	});
	return { writes, persisted, get creates() { return creates; } };
}

async function openEditor(page: Page, scope: string, extra = "") {
	await page.goto(`/tests/browser/promptEditorFlows.html?scope=${scope}${extra}`);
	if (scope === "project") await page.getByRole("tab", { name: /Prompts/ }).click();
	await page.getByRole("button", { name: /^\/editable(?:\s|$)/ }).click();
	const editor = page.getByRole("dialog", { name: "editable.md", exact: true });
	await expect(editor.locator(".cm-content")).toContainText("Template body");
	return editor;
}

/** Observe default prevention and background delivery, not merely absence of another write. */
async function saveShortcutResult(page: Page, meta = false) {
	return page.evaluate((metaKey) => {
		const event = new KeyboardEvent("keydown", { key: "s", code: "KeyS", ctrlKey: !metaKey, metaKey, bubbles: true, cancelable: true });
		let reachedBackground = false;
		const background = (received: KeyboardEvent) => { if (received === event) reachedBackground = true; };
		window.addEventListener("keydown", background);
		try {
			(document.activeElement ?? document.body).dispatchEvent(event);
			return { prevented: event.defaultPrevented, reachedBackground };
		} finally {
			window.removeEventListener("keydown", background);
		}
	}, meta);
}
async function expectSaveShortcutCaptured(page: Page) {
	for (const meta of [false, true]) {
		expect(await saveShortcutResult(page, meta)).toEqual({ prevented: true, reachedBackground: false });
	}
}

for (const scope of ["global", "project"]) {
	test(`${scope} prompt editor saves by click and shortcut without closing`, async ({ page }) => {
		const server = await storage(page);
		const editor = await openEditor(page, scope);
		const save = editor.getByRole("button", { name: "Save", exact: true });
		await expect(save).toBeVisible();
		await expect(save).toBeDisabled();
		await editor.locator(".cm-content").fill("First edit");
		await save.click();
		await expect(editor).toBeVisible();
		await expect(editor.getByRole("status")).toContainText("Saved");
		await expect(save).toBeDisabled();
		await editor.locator(".cm-content").fill("Second edit");
		await page.keyboard.press("Control+s");
		await expect.poll(() => server.writes.length).toBe(2);
		await expect(editor.getByRole("status")).toContainText("Saved");
		await expect(editor.locator(".cm-content")).toBeFocused();
		expect(server.writes.map((write) => write.content)).toEqual(["First edit", "Second edit"]);
		expect(server.writes.every((write) => write.path === (scope === "project" ? "/project/.pi/prompts/editable.md" : "/prompts/editable.md"))).toBe(true);
		await page.keyboard.press("Escape");
		await expect(editor).toBeHidden();
	});

	test(`${scope} prompt save failure remains visible in the editor and can retry`, async ({ page }) => {
		const server = await storage(page, { failFirst: true });
		const editor = await openEditor(page, scope);
		await editor.locator(".cm-content").fill("Keep this draft");
		await editor.getByRole("button", { name: "Save", exact: true }).click();
		await expect(editor.getByRole("alert")).toContainText("disk-full");
		await expect(editor.getByRole("status")).not.toContainText("Saved");
		await expect(editor.locator(".cm-content")).toContainText("Keep this draft");
		await editor.getByRole("button", { name: "Save", exact: true }).click();
		await expect(editor.getByRole("alert")).toHaveCount(0);
		await expect(editor.getByRole("status")).toContainText("Saved");
		expect(server.writes).toHaveLength(2);
	});

	test(`${scope} prompt dirty close confirms discard, cancellation keeps the draft`, async ({ page }) => {
		const server = await storage(page);
		const editor = await openEditor(page, scope);
		await editor.locator(".cm-content").fill("Unsaved draft");
		await page.keyboard.press("Escape");
		const confirmation = page.getByRole("alertdialog", { name: "Unsaved Changes", exact: true });
		await expect(confirmation).toBeVisible();
		await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect(editor.locator(".cm-content")).toContainText("Unsaved draft");
		await editor.getByRole("button", { name: "Close", exact: true }).last().click();
		await confirmation.getByRole("button", { name: "Discard Changes", exact: true }).click();
		await expect(editor).toBeHidden();
		expect(server.writes).toHaveLength(0);
	});

	test(`${scope} prompt save blocks close, input and duplicate keyboard submits`, async ({ page }) => {
		const pending = gate();
		const server = await storage(page, { writeGate: pending });
		const editor = await openEditor(page, scope);
		await editor.locator(".cm-content").fill("Single write");
		await editor.getByRole("button", { name: "Save", exact: true }).click();
		await expect.poll(() => server.writes.length).toBe(1);
		await expect(editor.getByRole("button", { name: "Saving...", exact: true })).toBeDisabled();
		await expect(editor.getByRole("button", { name: "Close", exact: true }).last()).toBeDisabled();
		await expect.poll(() => editor.evaluate((element) => element.contains(document.activeElement))).toBe(true);
		await page.keyboard.press("Escape");
		await expectSaveShortcutCaptured(page);
		await expect(editor).toBeVisible();
		await expect(page.getByRole("alertdialog")).toHaveCount(0);
		// CodeMirror keeps its DOM focusable in read-only mode; assert the actual
		// editing behavior, not the browser's contenteditable implementation detail.
		await expect(editor.locator(".cm-content")).toHaveAttribute("aria-readonly", "true");
		await editor.locator(".cm-content").click();
		await page.keyboard.type("Must not change the draft");
		await expect(editor.locator(".cm-content")).toHaveText("Single write");
		pending.release();
		await expect(editor.getByRole("status")).toContainText("Saved");
		await expect.poll(() => editor.evaluate((element) => element.contains(document.activeElement))).toBe(true);
		await expectSaveShortcutCaptured(page);
		expect(server.writes).toHaveLength(1);
	});

	test(`${scope} prompt shortcut is scoped to loading, clean and discard-confirmation states and cleaned up on close`, async ({ page }) => {
		const pending = gate();
		const server = await storage(page, { readGate: pending });
		await page.goto(`/tests/browser/promptEditorFlows.html?scope=${scope}`);
		if (scope === "project") await page.getByRole("tab", { name: /Prompts/ }).click();
		await page.getByRole("button", { name: /^\/editable(?:\s|$)/ }).click();
		const editor = page.getByRole("dialog", { name: "editable.md", exact: true });
		await expect(editor.getByText("Loading...", { exact: true })).toBeVisible();
		await expectSaveShortcutCaptured(page);
		expect(server.writes).toHaveLength(0);
		pending.release();
		await expect(editor.locator(".cm-content")).toHaveText("Template body");
		await expectSaveShortcutCaptured(page);
		expect(server.writes).toHaveLength(0);
		await editor.locator(".cm-content").fill("Unsaved draft");
		await page.keyboard.press("Escape");
		const confirmation = page.getByRole("alertdialog", { name: "Unsaved Changes", exact: true });
		await expect(confirmation).toBeVisible();
		await expectSaveShortcutCaptured(page);
		expect(server.writes, "confirmation must not save behind the user's back").toHaveLength(0);
		await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
		await editor.getByRole("button", { name: "Save", exact: true }).click();
		await expect(editor.getByRole("status")).toContainText("Saved");
		await expectSaveShortcutCaptured(page);
		await editor.getByRole("button", { name: "Close", exact: true }).last().click();
		await expect(editor).toBeHidden();
		expect(await saveShortcutResult(page)).toEqual({ prevented: false, reachedBackground: true });
		expect(server.writes).toHaveLength(1);
	});

	test(`${scope} prompt save preserves the editor undo history`, async ({ page }) => {
		await storage(page);
		const editor = await openEditor(page, scope);
		await editor.locator(".cm-content").click();
		await page.keyboard.press("Control+End");
		await page.keyboard.type(" appended");
		await editor.getByRole("button", { name: "Save", exact: true }).click();
		await expect(editor.getByRole("status")).toContainText("Saved");
		await editor.locator(".cm-content").click();
		await page.keyboard.press("Control+z");
		await expect(editor.locator(".cm-content")).toHaveText("Template body");
		await expect(editor.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
	});
}

test("builtin prompt retains its user-copy identity across a failed save and multiple saves", async ({ page }) => {
	const server = await storage(page, { failFirst: true });
	const editor = await openEditor(page, "global", "&builtin=1");
	await editor.locator(".cm-content").fill("Builtin draft");
	await editor.getByRole("button", { name: "Save", exact: true }).click();
	const copyEditor = page.getByRole("dialog", { name: "editable.md", exact: true });
	await expect(copyEditor.getByRole("alert")).toContainText("disk-full");
	await copyEditor.getByRole("button", { name: "Save", exact: true }).click();
	await expect(copyEditor.getByRole("status")).toContainText("Saved");
	await copyEditor.locator(".cm-content").fill("Next builtin edit");
	await page.keyboard.press("Meta+s");
	await expect.poll(() => server.writes.length).toBe(3);
	await expect(copyEditor.getByRole("status")).toContainText("Saved");
	expect(server.creates).toBe(1);
	expect(server.writes.every((write) => write.path === "/prompts/editable.md")).toBe(true);
});

test("builtin copy write failure followed by undo still requires save and dirty-close confirmation", async ({ page }) => {
	const server = await storage(page, { failFirst: true });
	const editor = await openEditor(page, "global", "&builtin=1");
	await editor.locator(".cm-content").click();
	await page.keyboard.press("Control+End");
	await page.keyboard.type(" appended");
	await editor.getByRole("button", { name: "Save", exact: true }).click();
	await expect(editor.getByRole("alert")).toContainText("disk-full");
	expect(server.persisted.get("/prompts/editable.md")).toBe("---\ndescription: Editable template\n---\n");
	await editor.locator(".cm-content").click();
	await page.keyboard.press("Control+z");
	await expect(editor.locator(".cm-content")).toHaveText("Template body");
	await expect(editor.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
	await editor.getByRole("button", { name: "Close", exact: true }).last().click();
	const confirmation = page.getByRole("alertdialog", { name: "Unsaved Changes", exact: true });
	await expect(confirmation).toBeVisible();
	await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
	await editor.locator(".cm-content").click();
	await page.keyboard.press("Control+s");
	await expect(editor.getByRole("status")).toContainText("Saved");
	expect(server.creates).toBe(1);
	expect(server.writes).toHaveLength(2);
	expect(server.persisted.get("/prompts/editable.md")).toBe("Template body");
	await editor.getByRole("button", { name: "Close", exact: true }).last().click();
	await expect(editor).toBeHidden();
	await page.getByRole("button", { name: /^\/editable(?:\s|$)/ }).click();
	await expect(editor.locator(".cm-content")).toHaveText("Template body");
});
