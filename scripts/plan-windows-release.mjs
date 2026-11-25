import { readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { nextReleaseVersion } from "./lib/release-version.mjs";

// stdin contains one occupied tag per line, from both Git refs and GitHub Releases.
const { version: base } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const tags = readFileSync(0, "utf8").split(/\r?\n/).map((tag) => tag.trim()).filter(Boolean);
const version = nextReleaseVersion(base, tags);
const filename = `PiDeck-Q-${version}-win.zip`;
if (process.env.GITHUB_OUTPUT) {
	await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\nfilename=${filename}\n`);
}
console.log(`${version}: ${filename}`);
