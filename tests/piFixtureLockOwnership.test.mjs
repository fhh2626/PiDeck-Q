import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reapAbandonedLock, withPiFixtureLock } from "../scripts/pi-compatibility-fixture.mjs";
import { FAST, cacheRoot, deadPid, plantLock } from "./helpers/piFixtureLockHelpers.mjs";

test("a lock recorded by a process on another host is never judged dead from here", async (t) => {
	// kill(pid, 0) only means something inside one pid namespace; a Windows/WSL or container peer
	// sharing the checkout would look "dead" here while its install is still running.
	const { fixture } = await cacheRoot(t);
	const lock = await plantLock(fixture, JSON.stringify({ pid: deadPid(), host: `${hostname()}-another-namespace` }));
	let ran = false;
	await assert.rejects(withPiFixtureLock(fixture, async () => { ran = true; }, FAST), /Timed out waiting for Pi fixture preparation/);
	assert.equal(ran, false);
	assert.ok(JSON.parse(await readFile(join(lock, "owner.json"), "utf8")).host.endsWith("another-namespace"), "the foreign lock must be left intact");
});

test("a dead owner recorded on this host is still reaped", async (t) => {
	const { fixture } = await cacheRoot(t);
	await plantLock(fixture, JSON.stringify({ pid: deadPid(), host: hostname() }));
	assert.equal(await withPiFixtureLock(fixture, async () => "ran", FAST), "ran");
});

test("the lock records the owner's pid together with the pid space it lives in", async (t) => {
	const { fixture } = await cacheRoot(t);
	const owner = await withPiFixtureLock(fixture, async () => JSON.parse(await readFile(join(`${fixture}.prepare-lock`, "owner.json"), "utf8")), FAST);
	assert.equal(owner.pid, process.pid);
	assert.equal(owner.host, hostname());
	assert.equal(owner.platform, process.platform);
	assert.ok("pidNamespace" in owner, "pidNamespace is always recorded (null when the platform has none)");
});

test("a peer on another platform is never judged dead even when the host name matches", async (t) => {
	// WSL inherits the Windows host name, so the host alone cannot tell the two pid spaces apart.
	const { fixture } = await cacheRoot(t);
	const otherPlatform = process.platform === "win32" ? "linux" : "win32";
	const lock = await plantLock(fixture, JSON.stringify({ pid: deadPid(), host: hostname(), platform: otherPlatform, pidNamespace: null }));
	await assert.rejects(withPiFixtureLock(fixture, async () => "ran", FAST), /Timed out waiting for Pi fixture preparation/);
	assert.equal(JSON.parse(await readFile(join(lock, "owner.json"), "utf8")).platform, otherPlatform);
});

test("a peer in another pid namespace is never judged dead", async (t) => {
	const { fixture } = await cacheRoot(t);
	await plantLock(fixture, JSON.stringify({ pid: deadPid(), host: hostname(), platform: process.platform, pidNamespace: "pid:[not-this-one]" }));
	await assert.rejects(withPiFixtureLock(fixture, async () => "ran", FAST), /Timed out waiting for Pi fixture preparation/);
});

test("an owner pid outside the int32 range is treated as an unreadable record instead of crashing", async (t) => {
	// process.kill() throws ERR_INVALID_ARG_TYPE for these, which used to abort every later run.
	const { fixture } = await cacheRoot(t);
	const lock = await plantLock(fixture, JSON.stringify({ pid: 2 ** 40, host: hostname() }));
	const old = new Date(Date.now() - 60_000);
	await utimes(lock, old, old);
	assert.equal(await withPiFixtureLock(fixture, async () => "ran", FAST), "ran");
});

test("a reaper that wins the mutex re-checks and refuses to remove a live lock", async (t) => {
	// Deterministic form of "the lock it observed as abandoned was replaced before it got the mutex".
	const { fixture } = await cacheRoot(t);
	const live = await withPiFixtureLock(fixture, async () => reapAbandonedLock(`${fixture}.prepare-lock`, 60, 30_000), FAST);
	assert.equal(live, false);
	assert.deepEqual((await readdir(join(fixture, ".."))).filter((name) => name.includes(".reap") || name.includes(".stale-")), []);
});

test("a failure while releasing the lock does not replace the result or the original error", async (t) => {
	const { fixture } = await cacheRoot(t);
	const failingRemove = async () => { throw Object.assign(new Error("EBUSY: simulated antivirus hold"), { code: "EBUSY" }); };
	assert.equal(await withPiFixtureLock(fixture, async () => "installed", { ...FAST, removeDir: failingRemove, warn: () => undefined }), "installed");
	await rm(`${fixture}.prepare-lock`, { recursive: true, force: true });
	await assert.rejects(withPiFixtureLock(fixture, async () => { throw new Error("npm install failed"); }, { ...FAST, removeDir: failingRemove, warn: () => undefined }), /npm install failed/);
});

test("a lock held by an unjudgeable peer still heals once it is far older than any plausible install", async (t) => {
	// Host names and container ids can change after the owner died; "cannot tell" must not mean "never".
	const { fixture } = await cacheRoot(t);
	const lock = await plantLock(fixture, JSON.stringify({ pid: deadPid(), host: `${hostname()}-renamed`, platform: process.platform, pidNamespace: null }));
	const old = new Date(Date.now() - 60_000);
	await utimes(lock, old, old);
	assert.equal(await withPiFixtureLock(fixture, async () => "ran", { ...FAST, timeoutMs: 2000, foreignOwnerStaleMs: 30, foreignConfirmMs: 50 }), "ran");
});

test("a young lock held by an unjudgeable peer is still respected", async (t) => {
	const { fixture } = await cacheRoot(t);
	await plantLock(fixture, JSON.stringify({ pid: deadPid(), host: `${hostname()}-renamed`, platform: process.platform, pidNamespace: null }));
	await assert.rejects(withPiFixtureLock(fixture, async () => "ran", { ...FAST, foreignOwnerStaleMs: 60_000 }), /Timed out waiting for Pi fixture preparation/);
});

test("a lock that could not be released degrades to an ownerless lock, warns, and heals in the same process", async (t) => {
	const { fixture } = await cacheRoot(t);
	const warnings = [];
	const failingRemove = async () => { throw Object.assign(new Error("EBUSY: simulated antivirus hold"), { code: "EBUSY" }); };
	await withPiFixtureLock(fixture, async () => "first", { ...FAST, removeDir: failingRemove, warn: (message) => warnings.push(message) });
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /could not be released \(EBUSY\)/);
	// The recorded owner is this still-running process; without the fallback the next acquisition
	// would wait on its own live pid until the timeout.
	assert.equal(await withPiFixtureLock(fixture, async () => "second", FAST), "second");
});

test("releasing never deletes a lock that has since been taken over by another owner", async (t) => {
	// Models: this owner stalled, a waiter judged it abandoned and re-created the lock, then this owner finishes.
	const { fixture } = await cacheRoot(t);
	const lock = `${fixture}.prepare-lock`;
	await withPiFixtureLock(fixture, async () => {
		await rm(lock, { recursive: true, force: true });
		await mkdir(lock);
		await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname(), platform: process.platform, pidNamespace: null, token: "successor" }));
	}, { ...FAST, warn: () => undefined });
	assert.equal(JSON.parse(await readFile(join(lock, "owner.json"), "utf8")).token, "successor", "the successor's lock must survive");
});

test("a failed release does not drop the owner record of a successor either", async (t) => {
	const { fixture } = await cacheRoot(t);
	const lock = `${fixture}.prepare-lock`;
	const failingRemove = async () => { throw Object.assign(new Error("EBUSY"), { code: "EBUSY" }); };
	await withPiFixtureLock(fixture, async () => {
		await rm(lock, { recursive: true, force: true });
		await mkdir(lock);
		await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname(), platform: process.platform, pidNamespace: null, token: "successor" }));
	}, { ...FAST, removeDir: failingRemove, warn: () => undefined });
	assert.equal(JSON.parse(await readFile(join(lock, "owner.json"), "utf8")).token, "successor");
});

test("an explicit undefined option falls back to the default instead of disabling it", async (t) => {
	const { fixture } = await cacheRoot(t);
	// timeoutMs: undefined used to become NaN and make the wait unbounded; removeDir: undefined made every release "fail".
	const warnings = [];
	assert.equal(await withPiFixtureLock(fixture, async () => "ran", { ...FAST, timeoutMs: undefined, removeDir: undefined, warn: (m) => warnings.push(m) }), "ran");
	assert.deepEqual(warnings, []);
	await assert.rejects(stat(`${fixture}.prepare-lock`), { code: "ENOENT" });
});

test("a warn callback that throws cannot replace the outcome of the work", async (t) => {
	const { fixture } = await cacheRoot(t);
	const failingRemove = async () => { throw Object.assign(new Error("EBUSY"), { code: "EBUSY" }); };
	const result = await withPiFixtureLock(fixture, async () => "installed", { ...FAST, removeDir: failingRemove, warn: () => { throw new Error("logger broke"); } });
	assert.equal(result, "installed");
});

test("the lock records an ownership token", async (t) => {
	const { fixture } = await cacheRoot(t);
	const owner = await withPiFixtureLock(fixture, async () => JSON.parse(await readFile(join(`${fixture}.prepare-lock`, "owner.json"), "utf8")), FAST);
	assert.equal(typeof owner.token, "string");
	assert.ok(owner.token.length >= 16);
});

test("a live owner refreshes its lock mtime on its own, whatever the lock looked like before", async (t) => {
	// Polling for the refresh (instead of sampling ages) keeps this independent of CI stalls.
	const { fixture } = await cacheRoot(t);
	const lock = `${fixture}.prepare-lock`;
	let refreshed = false;
	await withPiFixtureLock(fixture, async () => {
		const longAgo = new Date(Date.now() - 600_000);
		await utimes(lock, longAgo, longAgo);
		for (let i = 0; i < 300 && !refreshed; i++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			refreshed = Date.now() - (await stat(lock)).mtimeMs < 60_000;
		}
	}, { ...FAST, heartbeatMs: 10 });
	assert.equal(refreshed, true, "the heartbeat never refreshed the lock");
});

test("a long-running owner in another pid space is never preempted while its heartbeat is alive", async (t) => {
	// Regression for: age-based preemption of an unjudgeable owner broke mutual exclusion after the
	// owner ran longer than the threshold, and its release then deleted the successor's lock.
	const { fixture } = await cacheRoot(t);
	const lock = `${fixture}.prepare-lock`;
	let overlaps = 0;
	let active = 0;
	const enter = async (ms) => {
		if (active > 0) overlaps++;
		active++;
		await new Promise((resolve) => setTimeout(resolve, ms));
		active--;
	};
	const options = { ...FAST, timeoutMs: 20_000, heartbeatMs: 15, foreignOwnerStaleMs: 300, foreignConfirmMs: 100 };
	let ownerHasLock;
	const aIsInside = new Promise((resolve) => { ownerHasLock = resolve; });
	const owner = withPiFixtureLock(fixture, async () => {
		// From a peer's point of view this owner lives elsewhere: rewrite its record, keeping the token.
		const record = JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
		await writeFile(join(lock, "owner.next"), JSON.stringify({ ...record, host: `${hostname()}-elsewhere` }));
		await rename(join(lock, "owner.next"), join(lock, "owner.json")); // atomic: a heartbeat never sees a torn file
		ownerHasLock();
		await enter(1500); // several times longer than the staleness threshold
	}, options);
	await aIsInside; // B and C start only once A really holds the lock
	await Promise.all([owner, withPiFixtureLock(fixture, () => enter(5), options), withPiFixtureLock(fixture, () => enter(5), options)]);
	assert.equal(overlaps, 0, "no waiter may enter while A is still working");
	await assert.rejects(stat(lock), { code: "ENOENT" });
});

test("a stale-looking foreign lock is not reaped while its owner proves it is alive during the confirmation window", async (t) => {
	// Models a machine that slept past the threshold: the wall clock jumps, so the mtime looks
	// ancient, but the owner's very next heartbeat after wake-up refreshes it.
	const { fixture } = await cacheRoot(t);
	const lock = await plantLock(fixture, JSON.stringify({ pid: deadPid(), host: `${hostname()}-elsewhere`, platform: process.platform, pidNamespace: null }));
	const longAgo = new Date(Date.now() - 600_000);
	await utimes(lock, longAgo, longAgo);
	const wake = setTimeout(() => {
		const beat = setInterval(() => { const now = new Date(); utimes(lock, now, now).catch(() => undefined); }, 40);
		t.after(() => clearInterval(beat));
	}, 120);
	t.after(() => clearTimeout(wake));
	let entered = false;
	await assert.rejects(
		withPiFixtureLock(fixture, async () => { entered = true; }, { ...FAST, timeoutMs: 2500, foreignOwnerStaleMs: 150, foreignConfirmMs: 1500 }),
		/Timed out waiting for Pi fixture preparation/,
	);
	assert.equal(entered, false);
});

test("a preempted owner stops refreshing the successor's lock and says so", async (t) => {
	const { fixture } = await cacheRoot(t);
	const lock = `${fixture}.prepare-lock`;
	const warnings = [];
	let successorMtime;
	await withPiFixtureLock(fixture, async () => {
		await rm(lock, { recursive: true, force: true });
		await mkdir(lock);
		await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname(), platform: process.platform, pidNamespace: null, token: "successor" }));
		await new Promise((resolve) => setTimeout(resolve, 100)); // a beat that read the old record before the swap may still land
		const longAgo = new Date(Date.now() - 600_000);
		await utimes(lock, longAgo, longAgo);
		await new Promise((resolve) => setTimeout(resolve, 150)); // many heartbeats
		successorMtime = (await stat(lock)).mtimeMs;
	}, { ...FAST, heartbeatMs: 10, warn: (message) => warnings.push(message) });
	assert.ok(Date.now() - successorMtime > 300_000, "the zombie heartbeat must not keep the successor's lock fresh");
	assert.ok(warnings.some((message) => /no longer owned/i.test(message)), `expected a warning, got ${JSON.stringify(warnings)}`);
});

test("a transient error while verifying ownership is retried before the release is judged", async (t) => {
	const { fixture } = await cacheRoot(t);
	let reads = 0;
	const readText = async (path) => {
		if (path.endsWith("owner.json") && ++reads <= 2) throw Object.assign(new Error("EBUSY: simulated"), { code: "EBUSY" });
		return readFile(path, "utf8");
	};
	await withPiFixtureLock(fixture, async () => "ran", { ...FAST, readText, warn: () => undefined });
	await assert.rejects(stat(`${fixture}.prepare-lock`), { code: "ENOENT" });
});

test("when ownership cannot be verified at all the lock is left alone and the problem is reported", async (t) => {
	const { fixture } = await cacheRoot(t);
	const warnings = [];
	const readText = async (path) => {
		if (path.endsWith("owner.json")) throw Object.assign(new Error("EBUSY: simulated"), { code: "EBUSY" });
		return readFile(path, "utf8");
	};
	await withPiFixtureLock(fixture, async () => "ran", { ...FAST, readText, warn: (message) => warnings.push(message) });
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /could not verify/i);
	assert.ok((await stat(`${fixture}.prepare-lock`)).isDirectory(), "nothing may be deleted on an inconclusive check");
});

test("a failure while recording the owner removes the lock that was just created", async (t) => {
	const { fixture } = await cacheRoot(t);
	// Pre-create owner.json as a directory so writing the record fails after the lock exists.
	const makeLockDir = async (path) => {
		await mkdir(path);
		await mkdir(join(path, "owner.json"));
	};
	await assert.rejects(withPiFixtureLock(fixture, async () => "ran", { ...FAST, makeLockDir }));
	await assert.rejects(stat(`${fixture}.prepare-lock`), { code: "ENOENT" });
});

test("any change of a foreign lock's mtime restarts the confirmation window, even if it still looks old", async (t) => {
	const { fixture } = await cacheRoot(t);
	const lock = await plantLock(fixture, JSON.stringify({ pid: deadPid(), host: `${hostname()}-elsewhere`, platform: process.platform, pidNamespace: null }));
	const longAgo = new Date(Date.now() - 600_000);
	await utimes(lock, longAgo, longAgo);
	// A late heartbeat: the mtime moves, but only to another moment that is still beyond the threshold.
	const touch = setTimeout(() => { const stillOld = new Date(Date.now() - 500_000); utimes(lock, stillOld, stillOld).catch(() => undefined); }, 250);
	t.after(() => clearTimeout(touch));
	const started = Date.now();
	await withPiFixtureLock(fixture, async () => undefined, { ...FAST, timeoutMs: 10_000, foreignOwnerStaleMs: 100, foreignConfirmMs: 400 });
	// Confirmation starts over at the change (~250ms), so entry cannot come before ~650ms. Only a lower
	// bound is asserted: a slow machine can make it later, never earlier.
	assert.ok(Date.now() - started >= 600, `reaped after only ${Date.now() - started}ms`);
});

test("a corrupt or torn read of the owner record never stops the heartbeat", async (t) => {
	// Only a missing record or a different token is proof of lost ownership; anything unreadable is inconclusive.
	const { fixture } = await cacheRoot(t);
	const lock = `${fixture}.prepare-lock`;
	let failuresLeft = 3;
	const readText = async (path) => (path.endsWith("owner.json") && failuresLeft-- > 0 ? '{"pi' : readFile(path, "utf8"));
	let refreshed = false;
	await withPiFixtureLock(fixture, async () => {
		const longAgo = new Date(Date.now() - 600_000);
		await utimes(lock, longAgo, longAgo);
		for (let i = 0; i < 300 && !refreshed; i++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			refreshed = Date.now() - (await stat(lock)).mtimeMs < 60_000;
		}
	}, { ...FAST, heartbeatMs: 10, readText, warn: () => undefined });
	assert.equal(refreshed, true, "the heartbeat died after an unreadable record");
});

test("an unreadable owner record at release is inconclusive, so nothing is deleted", async (t) => {
	const { fixture } = await cacheRoot(t);
	const warnings = [];
	const readText = async (path) => (path.endsWith("owner.json") ? "" : readFile(path, "utf8"));
	await withPiFixtureLock(fixture, async () => "ran", { ...FAST, readText, warn: (message) => warnings.push(message) });
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /could not verify/i);
	assert.ok((await stat(`${fixture}.prepare-lock`)).isDirectory());
});

test("a transient read failure that lasts tens of milliseconds is waited out, not treated as unverifiable", async (t) => {
	// Failures counted per read cannot tell a real backoff from a tight retry loop; a time window can.
	const { fixture } = await cacheRoot(t);
	let firstRead = null;
	const readText = async (path) => {
		if (path.endsWith("owner.json")) {
			firstRead ??= Date.now();
			if (Date.now() - firstRead < 60) throw Object.assign(new Error("EBUSY: simulated antivirus scan"), { code: "EBUSY" });
		}
		return readFile(path, "utf8");
	};
	const warnings = [];
	await withPiFixtureLock(fixture, async () => "ran", { ...FAST, readText, warn: (message) => warnings.push(message) });
	assert.deepEqual(warnings, []);
	await assert.rejects(stat(`${fixture}.prepare-lock`), { code: "ENOENT" });
});