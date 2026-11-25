import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ZIP_NAME = /^PiDeck-Q-(\d+\.\d+\.\d+(?:\.[1-9]\d*)?)-win\.zip$/;
const RUNTIME_NOTE = "Windows x64 requirements: Microsoft Edge WebView2 Runtime and the [Microsoft Visual C++ x64 Redistributable](https://aka.ms/vc14/vc_redist.x64.exe).";

/** Only a completed preview from this workflow and the requested main commit is eligible. */
export function previewArtifactName(run, workflowId, sha) {
	if (run.workflow_id !== workflowId || run.event !== "workflow_dispatch" || run.head_branch !== "main"
		|| run.head_sha !== sha || run.status !== "completed" || run.conclusion !== "success"
		|| !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) {
		throw new Error("Use a successful Windows preview run for the current main commit.");
	}
	return `windows-release-zip-${run.run_attempt}`;
}

/** Validate the exact ZIP before writing to GitHub; never replace an occupied tag. */
export async function promoteWindowsRelease({ dir, digest, sha, notes, prerelease }, api) {
	if (!/^[0-9a-f]{64}$/i.test(digest ?? "")) throw new Error("Enter the preview ZIP SHA-256.");
	if (!/^[0-9a-f]{40}$/.test(sha ?? "") || !notes?.trim()) throw new Error("A tested commit and release notes are required.");
	const entries = await readdir(dir, { withFileTypes: true });
	const match = entries.length === 1 && entries[0].isFile() && entries[0].name.match(ZIP_NAME);
	if (!match) throw new Error("Expected exactly one PiDeck-Q Windows ZIP from the preview run.");
	const [, version] = match;
	const asset = join(dir, entries[0].name);
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(asset)) hash.update(chunk);
	if (hash.digest("hex") !== digest.toLowerCase()) throw new Error("Preview ZIP SHA-256 does not match the smoke-tested package.");

	if (api.hasRelease(version)) throw new Error(`Release ${version} already exists. Build and test a new preview.`);
	if (api.readMain().object?.sha !== sha) throw new Error("main has advanced since the preview. Build and test a new preview from main.");
	try {
		api.reserveTag(version, sha);
	} catch (error) {
		throw new Error(`Could not reserve ${version}. Check for a leftover tag, a newer main commit, or tag permissions before building a new preview.`, { cause: error });
	}
	const tag = api.readTag(version).object;
	if (tag?.type !== "commit" || tag.sha !== sha) throw new Error(`Tag ${version} no longer points to the tested commit.`);
	api.publish({ asset, version, sha, notes, prerelease });
}

function gh(args) {
	return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

/** Filter each page in gh to keep long release notes out of the Node subprocess buffer. */
export function hasGitHubRelease(repo, version, runGh = gh) {
	return runGh(["api", `repos/${repo}/releases?per_page=100`, "--paginate", "--jq",
		`.[] | select(.tag_name == ${JSON.stringify(version)}) | .tag_name`]).trim() !== "";
}

async function main(command, env) {
	if (env.GITHUB_REF !== "refs/heads/main") throw new Error("Publish from main. Other branches can build a preview ZIP.");
	const { GITHUB_REPOSITORY: repo, GITHUB_SHA: sha, PREVIEW_RUN_ID: runId, ZIP_SHA256: digest, RELEASE_NOTES: notes } = env;
	if (!/^[1-9]\d*$/.test(runId ?? "") || !/^[0-9a-f]{64}$/i.test(digest ?? "") || !notes?.trim()) {
		throw new Error("Enter a preview run ID, the smoke-tested ZIP SHA-256, and the main changes.");
	}
	const api = (suffix, ...options) => gh(["api", `repos/${repo}/${suffix}`, ...options]);
	if (command === "plan") {
		const workflow = JSON.parse(api("actions/workflows/release-windows.yml"));
		const preview = JSON.parse(api(`actions/runs/${runId}`));
		console.log(previewArtifactName(preview, workflow.id, sha));
		return;
	}
	if (command !== "publish") throw new Error("Expected plan or publish.");
	await promoteWindowsRelease({ dir: "release-asset", digest, sha, notes, prerelease: env.PRERELEASE === "true" }, {
		hasRelease: (version) => hasGitHubRelease(repo, version),
		readMain: () => JSON.parse(api("git/ref/heads/main")),
		reserveTag: (version, commit) => api("git/refs", "--silent", "--method", "POST", "-f", `ref=refs/tags/${version}`, "-f", `sha=${commit}`),
		readTag: (version) => JSON.parse(api(`git/ref/tags/${version}`)),
		// gh uploads to a draft, then publishes that release by ID. Explicitly pin
		// the target so even a disappearing tag cannot fall back to the branch tip.
		publish: ({ asset, version, sha, notes, prerelease }) => console.log(gh(["release", "create", version, asset,
			"--repo", repo, "--verify-tag", "--target", sha, "--title", version, "--notes", `${notes}\n\n${RUNTIME_NOTE}`,
			"--generate-notes", prerelease ? "--prerelease" : "--latest"])),
	});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { await main(process.argv[2], process.env); }
	catch (error) { console.error(error.message); process.exitCode = 1; }
}
