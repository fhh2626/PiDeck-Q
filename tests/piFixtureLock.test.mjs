import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { withPiFixtureLock } from "../scripts/pi-compatibility-fixture.mjs";
import { FAST, cacheRoot, deadPid, plantLock } from "./helpers/piFixtureLockHelpers.mjs";

test("a lock left behind by a killed process heals instead of blocking every later run", async (t) => {
	const { fixture } = await cacheRoot(t);
	await plantLock(fixture, JSON.stringify({ pid: deadPid() }));
	assert.equal(await withPiFixtureLock(fixture, async () => "ran", FAST), "ran");
});

test("a lock whose owner crashed before recording itself heals once the grace period passes", async (t) => {
	const { fixture } = await cacheRoot(t);
	const lock = await plantLock(fixture);
	const old = new Date(Date.now() - 60_000);
	await utimes(lock, old, old);
	assert.equal(await withPiFixtureLock(fixture, async () => "ran", FAST), "ran");
});

test("a half-written owner record is treated as ownerless, not as a live owner", async (t) => {
	const { fixture } = await cacheRoot(t);
	const lock = await plantLock(fixture, '{"pid":');
	const old = new Date(Date.now() - 60_000);
	await utimes(lock, old, old);
	assert.equal(await withPiFixtureLock(fixture, async () => "ran", FAST), "ran");
});

test("a brand-new ownerless lock is respected while its creator may still be writing the owner", async (t) => {
	const { fixture } = await cacheRoot(t);
	await plantLock(fixture);
	await assert.rejects(
		withPiFixtureLock(fixture, async () => "ran", { ...FAST, ownerlessGraceMs: 60_000 }),
		/Timed out waiting for Pi fixture preparation/,
	);
});

test("a live owner is never stolen from", async (t) => {
	const { fixture } = await cacheRoot(t);
	const lock = await plantLock(fixture, JSON.stringify({ pid: process.pid }));
	let ran = false;
	await assert.rejects(withPiFixtureLock(fixture, async () => { ran = true; }, FAST), /Timed out waiting for Pi fixture preparation/);
	assert.equal(ran, false);
	assert.equal(JSON.parse(await readFile(join(lock, "owner.json"), "utf8")).pid, process.pid, "the live owner's record must be untouched");
});

test("concurrent waiters reaping the same dead lock never overlap, even over many rounds", async (t) => {
	// The original reaper could rename a live replacement lock away from its owner, so a single
	// round passed by luck. Repeating with several waiters makes that interleaving near-certain.
	const { fixture } = await cacheRoot(t);
	let active = 0;
	let overlaps = 0;
	let completed = 0;
	const job = async () => {
		active++;
		if (active > 1) overlaps++;
		await new Promise((resolve) => setTimeout(resolve, 2));
		active--;
		completed++;
	};
	for (let round = 0; round < 25; round++) {
		await plantLock(fixture, JSON.stringify({ pid: deadPid() }));
		await Promise.all([1, 2, 3, 4, 5, 6].map(() => withPiFixtureLock(fixture, job, { ...FAST, timeoutMs: 10_000 })));
	}
	assert.equal(overlaps, 0, "two waiters were inside the critical section at once");
	assert.equal(completed, 25 * 6);
});

test("a reaper mutex abandoned by a killed reaper is cleared so reaping can proceed", async (t) => {
	const { fixture } = await cacheRoot(t);
	const lock = await plantLock(fixture, JSON.stringify({ pid: deadPid() }));
	const mutex = `${lock}.reap`;
	await mkdir(mutex);
	const old = new Date(Date.now() - 60_000);
	await utimes(mutex, old, old);
	assert.equal(await withPiFixtureLock(fixture, async () => "ran", { ...FAST, reapMutexStaleMs: 1000, timeoutMs: 2000 }), "ran");
});

test("a reaper mutex held by a live reaper is respected until it is released", async (t) => {
	const { root, fixture } = await cacheRoot(t);
	const lock = await plantLock(fixture, JSON.stringify({ pid: deadPid() }));
	const mutex = `${lock}.reap`;
	await mkdir(mutex);
	let entered = false;
	const waiting = withPiFixtureLock(fixture, async () => { entered = true; }, { ...FAST, timeoutMs: 5000, reapMutexStaleMs: 60_000 });
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(entered, false, "must not reap while another reaper holds the mutex");
	await rm(mutex, { recursive: true, force: true });
	await waiting;
	assert.equal(entered, true);
	assert.deepEqual(await readdir(join(root, ".cache")), []);
});
test("reaping and normal release leave no lock or graveyard directories behind", async (t) => {
	const { root, fixture } = await cacheRoot(t);
	await plantLock(fixture, JSON.stringify({ pid: deadPid() }));
	await withPiFixtureLock(fixture, async () => undefined, FAST);
	assert.deepEqual(await readdir(join(root, ".cache")), []);
});

test("the lock is released when the guarded work fails", async (t) => {
	const { root, fixture } = await cacheRoot(t);
	await assert.rejects(withPiFixtureLock(fixture, async () => { throw new Error("boom"); }, FAST), /boom/);
	assert.deepEqual(await readdir(join(root, ".cache")), []);
});

/** Simulates Windows' transient errors for a path that is being deleted (or a genuinely unwritable one). */
function failingMkdir(code, failures) {
	let calls = 0;
	const makeLockDir = async (path) => {
		calls++;
		if (calls <= failures) throw Object.assign(new Error(`${code}: simulated`), { code });
		return mkdir(path);
	};
	return { makeLockDir, calls: () => calls };
}

test("a transient lock-creation error is retried and then succeeds", async (t) => {
	const { fixture } = await cacheRoot(t);
	const seam = failingMkdir("EPERM", 3);
	assert.equal(await withPiFixtureLock(fixture, async () => "ran", { ...FAST, transientRetryLimit: 10, makeLockDir: seam.makeLockDir }), "ran");
	assert.equal(seam.calls(), 4);
});

test("a persistent permission error fails fast with the real error instead of waiting out the lock timeout", async (t) => {
	const { fixture } = await cacheRoot(t);
	const seam = failingMkdir("EACCES", Infinity);
	const started = Date.now();
	await assert.rejects(
		withPiFixtureLock(fixture, async () => "ran", { ...FAST, timeoutMs: 60_000, transientRetryLimit: 5, makeLockDir: seam.makeLockDir }),
		(error) => error.code === "EACCES" && !/Timed out/.test(error.message),
	);
	assert.ok(Date.now() - started < 5000, "must not wait for the lock timeout");
	assert.equal(seam.calls(), 6);
});
