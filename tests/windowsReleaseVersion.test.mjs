import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nativeBuildVersion, nextReleaseVersion } from "../scripts/lib/release-version.mjs";

const base = "0.5.1";

test("an unused package version becomes the release version", () => {
	assert.equal(nextReleaseVersion(base, ["0.5.0", "0.5.10", "0.5.1-beta.1"]), base);
});

test("rebuild numbers follow the highest reserved tag without filling old gaps", () => {
	assert.equal(nextReleaseVersion(base, [base]), `${base}.1`);
	assert.equal(nextReleaseVersion(base, [`v${base}`, `${base}.1`, `v${base}.9`, `${base}.10`]), `${base}.11`);
	assert.equal(nextReleaseVersion(base, [`${base}.2`]), `${base}.3`, "the base tag may have been deleted");
});

test("the native build accepts only a matching release stamp and keeps local builds unchanged", () => {
	assert.equal(nativeBuildVersion(base), base);
	assert.equal(nativeBuildVersion(base, base), base);
	assert.equal(nativeBuildVersion(base, `${base}.2`), `${base}.2`);
	assert.equal(nativeBuildVersion(`${base}-beta.1`), `${base}-beta.1`);
	for (const override of ["", `${base}.0`, `${base}.01`, `${base}.1.2`, "0.5.2", "0.5.2.1"]) {
		assert.throws(() => nativeBuildVersion(base, override), /does not match/);
	}
	assert.throws(() => nextReleaseVersion(`${base}-beta.1`, []), /stable X\.Y\.Z/);
});

test("the release planner emits the historical ZIP filename and matching workflow outputs", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-release-plan-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const output = join(dir, "github-output.txt");
	const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	const result = spawnSync(process.execPath, ["scripts/plan-windows-release.mjs"], {
		encoding: "utf8",
		env: { ...process.env, GITHUB_OUTPUT: output },
		input: `${version}\r\n${version}.1\r\n`,
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(readFileSync(output, "utf8"), `version=${version}.2\nfilename=PiDeck-Q-${version}.2-win.zip\n`);
});
