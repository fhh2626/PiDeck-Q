import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Shared fixtures for the Pi fixture lock tests (timings are short on purpose; see each test). */
export const FAST = { pollMs: 5, timeoutMs: 400, ownerlessGraceMs: 60 };

/** A throwaway project root (cleaned up with the test) and the fixture path the lock would guard in it. */
export async function cacheRoot(t) {
	const root = await mkdtemp(join(tmpdir(), "pideck-pi-lock-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return { root, fixture: join(root, ".cache", "pi-latest") };
}

/** A pid that was real a moment ago. It is re-checked so a fast pid reuse cannot make a "dead" owner alive. */
export function deadPid() {
	for (let attempt = 0; attempt < 20; attempt++) {
		const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8", timeout: 10000 });
		assert.equal(child.status, 0, child.stderr);
		const pid = Number(child.stdout);
		try {
			process.kill(pid, 0);
		} catch (error) {
			if (error.code === "ESRCH") return pid;
			throw error;
		}
	}
	throw new Error("could not obtain a pid that is not in use");
}

/** Leave a lock directory behind as a crashed run would, optionally with an owner record (raw text). */
export async function plantLock(fixture, owner) {
	const lock = `${fixture}.prepare-lock`;
	await mkdir(lock, { recursive: true });
	if (owner !== undefined) await writeFile(join(lock, "owner.json"), owner);
	return lock;
}
