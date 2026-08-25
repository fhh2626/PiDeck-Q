import assert from "node:assert/strict";
import test from "node:test";
import { openExternalLink } from "../src/main/browser/externalLinks.ts";

test("native shell adapter still uses the external-links allowlist", async () => {
	const opened = [];
	await openExternalLink("https://example.com", { openInSystem: async (url) => opened.push(url) });
	await openExternalLink("mailto:user@example.com", { openInSystem: async (url) => opened.push(url) });
	await openExternalLink("file:///C:/secret.txt", { openInSystem: async (url) => opened.push(url) });
	assert.deepEqual(opened, ["https://example.com", "mailto:user@example.com"]);
});
