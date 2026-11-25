import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hasGitHubRelease, previewArtifactName, promoteWindowsRelease } from "../scripts/publish-windows-release.mjs";

const sha = "a".repeat(40);
const version = "0.5.1.1";

function fixture(t, { tip = sha, tag = sha, reserveError, existing = [] } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pideck-release-promotion-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const asset = join(dir, `PiDeck-Q-${version}-win.zip`);
	writeFileSync(asset, "smoke-tested bytes");
	const digest = createHash("sha256").update("smoke-tested bytes").digest("hex");
	const calls = [];
	const ref = (commit) => ({ object: { type: "commit", sha: commit } });
	const deps = {
		readMain: () => ref(tip),
		hasRelease: (candidate) => existing.includes(candidate),
		reserveTag: (v, commit) => { calls.push(["reserve", v, commit]); if (reserveError) throw reserveError; },
		readTag: () => ref(tag),
		publish: (release) => { calls.push(["publish", release]); },
	};
	return { asset, calls, deps, args: { dir, digest, sha, notes: "Main changes", prerelease: false } };
}

test("only a successful main preview of the expected workflow and SHA qualifies", () => {
	const preview = { workflow_id: 11, event: "workflow_dispatch", head_branch: "main", head_sha: sha,
		status: "completed", conclusion: "success", run_attempt: 3 };
	assert.equal(previewArtifactName(preview, 11, sha), "windows-release-zip-3");
	for (const wrong of [{ workflow_id: 12 }, { event: "pull_request" }, { head_branch: "native2" },
		{ head_sha: "b".repeat(40) }, { status: "in_progress" }, { conclusion: "failure" }, { run_attempt: 0 }]) {
		assert.throws(() => previewArtifactName({ ...preview, ...wrong }, 11, sha), /successful Windows preview/);
	}
});

test("promote the exact smoke-tested ZIP and pin the release to the tested commit", async (t) => {
	const { asset, calls, deps, args } = fixture(t);
	await promoteWindowsRelease(args, deps);
	assert.deepEqual(calls, [["reserve", version, sha], ["publish", { asset, version, sha, notes: "Main changes", prerelease: false }]]);
});

test("a wrong digest or advanced main cannot reserve a release tag", async (t) => {
	const { calls, deps, args } = fixture(t, { tip: "b".repeat(40) });
	await assert.rejects(promoteWindowsRelease({ ...args, digest: "0".repeat(64) }, deps), /SHA-256/);
	await assert.rejects(promoteWindowsRelease(args, deps), /main has advanced/);
	assert.deepEqual(calls, []);
});

test("an existing draft or tag-only collision never overwrites a release", async (t) => {
	const first = fixture(t, { existing: [version] });
	await assert.rejects(promoteWindowsRelease(first.args, first.deps), /new preview/);
	assert.deepEqual(first.calls, []);
	const second = fixture(t, { reserveError: new Error("Reference already exists") });
	await assert.rejects(promoteWindowsRelease(second.args, second.deps), /new preview/);
	assert.deepEqual(second.calls, [["reserve", version, sha]]);
});

test("the release lookup filters paginated results before buffering the output", () => {
	const longBody = "x".repeat(1024 * 1024 + 1);
	const releases = [{ tag_name: version, draft: true, body: longBody }];
	function fakeGh(args) {
		assert.equal(args[0], "api");
		assert.equal(args[1], "repos/test/pideck/releases?per_page=100");
		assert.ok(args.includes("--paginate"));
		const [filter, target] = (args[args.indexOf("--jq") + 1] ?? "").match(/^\.\[\] \| select\(\.tag_name == ("[0-9.]+")\) \| \.tag_name$/) ?? [];
		if (!filter) throw new Error("Unfiltered release history exceeds the subprocess output buffer");
		return releases.filter((release) => release.tag_name === JSON.parse(target)).map((release) => release.tag_name).join("\n");
	}
	assert.equal(hasGitHubRelease("test/pideck", version, fakeGh), true);
	assert.equal(hasGitHubRelease("test/pideck", "0.5.1.2", fakeGh), false);
});

test("a moved tag is detected before uploading the ZIP", async (t) => {
	const { calls, deps, args } = fixture(t, { tag: "c".repeat(40) });
	await assert.rejects(promoteWindowsRelease(args, deps), /no longer points to the tested commit/);
	assert.deepEqual(calls, [["reserve", version, sha]]);
});
