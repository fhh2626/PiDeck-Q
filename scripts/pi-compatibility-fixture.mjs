import { randomUUID } from "node:crypto";
import { existsSync, readlinkSync } from "node:fs";
import { hostname } from "node:os";
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { performance } from "node:perf_hooks";

export const PI_PACKAGE = "@earendil-works/pi-coding-agent";
export const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const FIXTURE_NAME = "pideck-pi-latest-fixture";

/**
 * timeoutMs: how long a waiter tolerates a live owner (a slow npm install).
 * ownerlessGraceMs: a lock directory is created before its owner record is written, so an
 * ownerless lock is only abandoned once it is older than this window.
 * reapMutexStaleMs: age after which a reaper mutex is assumed to belong to a reaper that died.
 * transientRetryLimit / makeLockDir: bounded retry of transient lock-creation errors; makeLockDir
 * is a test seam for simulating them.
 * heartbeatMs: while it works, the owner touches the lock directory this often, so the directory's
 * mtime is a liveness signal that does not depend on how long the install takes.
 * foreignOwnerStaleMs / foreignConfirmMs: a lock whose owner lives in another pid space cannot be
 * probed, so it is only treated as abandoned once its heartbeat has been silent this long (many
 * missed beats) AND its mtime then stays unchanged for the confirmation window. The confirmation
 * matters because a machine that slept jumps the wall clock: every lock looks ancient on wake-up,
 * but a live owner proves itself with its next heartbeat. Without any such rule a host rename or
 * a fresh container would leave a dead lock that no run could ever clear.
 * removeDir / readText / warn: how the lock is released, how this process re-reads its own owner
 * record to verify ownership (heartbeat and release), and where problems are reported (test
 * seams; a release problem never masks the real outcome).
 */
const DEFAULT_LOCK_OPTIONS = {
	timeoutMs: 10 * 60 * 1000,
	pollMs: 50,
	ownerlessGraceMs: 10_000,
	reapMutexStaleMs: 30_000,
	// Consecutive transient mkdir failures tolerated before they are reported as the real error
	// (a genuinely read-only cache directory must fail fast, not wait out the lock timeout).
	transientRetryLimit: 100,
	makeLockDir: mkdir,
	heartbeatMs: 30_000,
	foreignOwnerStaleMs: 5 * 60 * 1000,
	foreignConfirmMs: 60 * 1000,
	readText: (path) => readFile(path, "utf8"),
	removeDir: (path) => rm(path, REMOVE_OPTIONS),
	warn: (message) => console.warn(message),
};

/**
 * Windows reports these transiently: while antivirus/indexers touch a directory, and for any
 * path another process has just deleted but whose handles are still closing ("delete pending").
 */
const TRANSIENT_FS_ERRORS = new Set(["EBUSY", "EPERM", "EACCES"]);

/** Removals race with other waiters on Windows, so retry briefly instead of failing the run. */
const REMOVE_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 20 };

/** Largest pid process.kill() accepts (int32); anything else would throw instead of answering. */
const MAX_PID = 2 ** 31 - 1;

/**
 * Identity of the pid space this process lives in. A pid is only meaningful to a process in the
 * same space: Windows and WSL (which shares the Windows host name) or a container can share this
 * checkout, and kill(pid, 0) from one side says nothing about the other.
 */
function currentPidSpace() {
	let pidNamespace = null;
	try {
		pidNamespace = readlinkSync("/proc/self/ns/pid"); // Linux only; absent elsewhere
	} catch {
		// No namespace information available: platform + host are the best identity we have.
	}
	return { host: hostname(), platform: process.platform, pidNamespace };
}

/** Whether a recorded owner shares our pid space, i.e. whether kill(pid, 0) means anything for it. */
function samePidSpace(owner, local) {
	return owner.host === local.host && owner.platform === local.platform && owner.pidNamespace === local.pidNamespace;
}

/** Resolve from this script's repository, not the caller's working directory. */
export function getPiFixtureDir(projectRoot = PROJECT_ROOT) {
	return join(resolve(projectRoot), ".cache", "pi-latest");
}

/** Directory of the Pi SDK package inside the isolated fixture (never the repository's own node_modules). */
export function getPiFixturePackageDir(projectRoot = PROJECT_ROOT) {
	return join(getPiFixtureDir(projectRoot), "node_modules", ...PI_PACKAGE.split("/"));
}

/** Fail closed instead of silently exercising an SDK hoisted into the root node_modules. */
export function piFixtureFileUrl(relativePath, projectRoot = PROJECT_ROOT) {
	const file = join(getPiFixturePackageDir(projectRoot), relativePath);
	if (!existsSync(file)) throw new Error(`Pi compatibility fixture is missing ${file}; run npm run prepare:pi-latest`);
	return pathToFileURL(file).href;
}

/** Give npm a real, private package boundary even on the very first install. */
export async function initializePiFixture(fixtureDir) {
	await mkdir(fixtureDir, { recursive: true });
	const manifest = join(fixtureDir, "package.json");
	try {
		await writeFile(manifest, `${JSON.stringify({ name: FIXTURE_NAME, private: true })}\n`, { flag: "wx" });
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		const existing = JSON.parse(await readFile(manifest, "utf8"));
		if (existing.name !== FIXTURE_NAME || existing.private !== true) {
			throw new Error(`Refusing to install Pi into an unowned fixture: ${fixtureDir}`);
		}
	}
}

/**
 * The recorded owner ({ pid, host, platform, pidNamespace }), or null when the record is missing,
 * still being written, or carries a pid that cannot be probed. Fields missing from an older
 * record are assumed to match this process, which keeps such a lock reclaimable. Unexpected I/O
 * errors (for example the record being a directory) are rethrown: a damaged lock directory
 * should stop the run loudly, and the lock path in the timeout message says what to remove.
 */
async function readLockOwner(lock) {
	try {
		const owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
		if (!Number.isInteger(owner?.pid) || owner.pid <= 0 || owner.pid > MAX_PID) return null;
		const local = currentPidSpace();
		return {
			pid: owner.pid,
			host: typeof owner.host === "string" ? owner.host : local.host,
			platform: typeof owner.platform === "string" ? owner.platform : local.platform,
			pidNamespace: owner.pidNamespace === undefined ? local.pidNamespace : owner.pidNamespace,
		};
	} catch (error) {
		if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
		throw error;
	}
}

/** Whether a process with this pid exists in our pid space (EPERM means it exists but is not ours). */
function isProcessAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error.code === "ESRCH") return false;
		if (error.code === "EPERM") return true; // exists but belongs to someone else
		throw error;
	}
}

/** Decide whether a held lock can no longer have a working owner. */
async function inspectLock(lock, ownerlessGraceMs, foreignOwnerStaleMs) {
	let owner;
	try {
		owner = await readLockOwner(lock);
	} catch (error) {
		// Another waiter is deleting this lock right now; look again on the next poll.
		if (TRANSIENT_FS_ERRORS.has(error.code)) return { abandoned: false };
		throw error;
	}
	if (owner !== null) {
		// A peer in another pid space (other host, Windows vs WSL, container) cannot be probed, so
		// the heartbeat age is the only evidence; the caller confirms it before acting on it.
		if (samePidSpace(owner, currentPidSpace())) return { abandoned: !isProcessAlive(owner.pid) };
		try {
			const { mtimeMs } = await stat(lock);
			return { abandoned: Date.now() - mtimeMs > foreignOwnerStaleMs, foreignMtimeMs: mtimeMs };
		} catch (error) {
			if (error.code === "ENOENT" || TRANSIENT_FS_ERRORS.has(error.code)) return { abandoned: false };
			throw error;
		}
	}
	let info;
	try {
		info = await stat(lock);
	} catch (error) {
		// Released meanwhile (retry mkdir) or being deleted right now (look again next poll).
		if (error.code === "ENOENT" || TRANSIENT_FS_ERRORS.has(error.code)) return { abandoned: false };
		throw error;
	}
	return { abandoned: Date.now() - info.mtimeMs > ownerlessGraceMs };
}

/** Best-effort cleanup that must never replace the outcome (or the error) of the work it follows. */
async function removeQuietly(path, remove = (target) => rm(target, REMOVE_OPTIONS)) {
	try {
		await remove(path);
	} catch {
		// Debris is reclaimed later: a dead owner or an expired mutex is reaped by the next waiter.
	}
}

/**
 * Whether the lock directory still carries this owner's token (it may have been reaped and
 * re-created): "yes", "no", or "unknown". Only hard evidence counts as "no" - the record is gone
 * or parses with someone else's token. A torn read, I/O error or descriptor shortage proves
 * nothing, so it is retried briefly and then reported as "unknown". Only "yes" permits deleting.
 */
async function ownsLock(lock, token, readText) {
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			return JSON.parse(await readText(join(lock, "owner.json"))).token === token ? "yes" : "no";
		} catch (error) {
			if (error.code === "ENOENT") return "no";
			await sleep(20); // transient or torn: look again
		}
	}
	return "unknown";
}

/** Report a problem without ever letting a failing logger replace the outcome of the work. */
function warnQuietly(warn, message) {
	try {
		warn(message);
	} catch {
		// Nothing sensible left to do with a broken logger.
	}
}

/**
 * Release the lock without ever replacing the outcome of the work it guarded.
 *
 * Only a lock that still carries our token is removed. If this owner stalled long enough to be
 * judged abandoned, a waiter may already hold a new lock at the same path, and deleting by name
 * would break that waiter's mutual exclusion. (What remains is the instant between this check
 * and the removal, which would need a reclaim to land exactly inside it.)
 *
 * If the directory cannot be removed (Windows keeps handles open briefly), the owner record -
 * which names this still-running process - is dropped so the leftover reads as an ownerless lock
 * and heals after the grace period instead of blocking later acquisitions until this process exits.
 */
async function releaseLock(lock, token, removeDir, readText, warn) {
	const ownership = await ownsLock(lock, token, readText);
	if (ownership === "no") {
		warnQuietly(warn, `Pi fixture lock is no longer owned by this process (it was reclaimed while work was running): ${lock}`);
		return;
	}
	if (ownership === "unknown") {
		warnQuietly(warn, `Pi fixture lock could not verify ownership, leaving it in place; if it lingers, remove it: ${lock}`);
		return;
	}
	try {
		await removeDir(lock);
		return;
	} catch (error) {
		warnQuietly(warn, `Pi fixture lock could not be released (${error.code ?? "unknown error"}); if it lingers, remove it: ${lock}`);
	}
	await removeQuietly(join(lock, "owner.json"));
}

/**
 * Remove the lock if, and only if, it is still abandoned.
 *
 * Reapers are serialized by a short-lived mutex directory. While we hold it, the stale lock
 * directory keeps existing, so nobody else can create a new lock at that path, and the only
 * other party that could remove it is its owner, who is dead or no longer in a position to
 * release it (a suspended owner is the accepted exception): "inspect, then move away" cannot
 * hit a freshly created lock. Without the mutex, a second waiter that observed the same stale lock
 * could rename a live replacement out from under its owner and break mutual exclusion.
 * Returns true when the lock was reaped.
 */
export async function reapAbandonedLock(lock, ownerlessGraceMs, reapMutexStaleMs, foreignOwnerStaleMs = DEFAULT_LOCK_OPTIONS.foreignOwnerStaleMs) {
	const mutex = `${lock}.reap`;
	try {
		await mkdir(mutex);
	} catch (error) {
		if (error.code !== "EEXIST" && !TRANSIENT_FS_ERRORS.has(error.code)) throw error;
		// Another waiter is reaping. Its mutex only outlives it if it died within milliseconds
		// of taking it, so a long-lived one is debris and safe to clear (age, not a racy owner read).
		try {
			if (Date.now() - (await stat(mutex)).mtimeMs > reapMutexStaleMs) await rm(mutex, REMOVE_OPTIONS);
		} catch (statError) {
			if (statError.code !== "ENOENT" && !TRANSIENT_FS_ERRORS.has(statError.code)) throw statError;
		}
		return false;
	}
	try {
		// Re-inspect under the mutex: the earlier observation may belong to a lock that is gone.
		if (!(await inspectLock(lock, ownerlessGraceMs, foreignOwnerStaleMs)).abandoned) return false;
		const graveyard = `${lock}.stale-${process.pid}-${randomUUID()}`;
		try {
			await rename(lock, graveyard);
		} catch (error) {
			if (error.code === "ENOENT") return true; // already gone, which is what we wanted
			throw error;
		}
		await removeQuietly(graveyard); // the lock itself is already gone; leftovers are only debris
		return true;
	} finally {
		await removeQuietly(mutex); // a leftover mutex expires by age (reapMutexStaleMs)
	}
}

/**
 * Serialize typecheck/test prepares across processes. A killed process (Ctrl+C, CI timeout)
 * cannot run `finally`, so locks whose owner is gone are reaped instead of blocking forever.
 */
export async function withPiFixtureLock(fixtureDir, run, options = {}) {
	// An explicit `undefined` must mean "use the default", not "disable" (timeoutMs would become NaN).
	const defined = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
	const { timeoutMs, pollMs, ownerlessGraceMs, reapMutexStaleMs, transientRetryLimit, makeLockDir, heartbeatMs, foreignOwnerStaleMs, foreignConfirmMs, removeDir, readText, warn } = { ...DEFAULT_LOCK_OPTIONS, ...defined };
	await mkdir(dirname(fixtureDir), { recursive: true });
	const lock = `${fixtureDir}.prepare-lock`;
	const deadline = performance.now() + timeoutMs; // monotonic: a clock jump must not shorten or extend the wait
	let transientFailures = 0;
	let foreignWatch = null; // { mtimeMs, since }: the unchanged foreign heartbeat we are confirming
	while (true) {
		try {
			await makeLockDir(lock);
			break;
		} catch (error) {
			if (error.code === "EEXIST") {
				transientFailures = 0; // held by someone: normal contention
			} else if (TRANSIENT_FS_ERRORS.has(error.code)) {
				// Usually the previous lock is still being deleted; persistent means a real permission problem.
				if (++transientFailures > transientRetryLimit) throw error;
			} else {
				throw error;
			}
		}
		const state = await inspectLock(lock, ownerlessGraceMs, foreignOwnerStaleMs);
		let reapable = state.abandoned;
		if (state.abandoned && state.foreignMtimeMs !== undefined) {
			// Looks dead by age only. Act on it once the mtime has stayed put for the whole window:
			// any heartbeat in between (e.g. right after the machine woke up) restarts the clock.
			if (foreignWatch?.mtimeMs !== state.foreignMtimeMs) foreignWatch = { mtimeMs: state.foreignMtimeMs, since: performance.now() };
			reapable = performance.now() - foreignWatch.since >= foreignConfirmMs;
		} else {
			foreignWatch = null;
		}
		if (reapable) {
			try {
				if (await reapAbandonedLock(lock, ownerlessGraceMs, reapMutexStaleMs, foreignOwnerStaleMs)) continue;
			} catch (error) {
				if (!TRANSIENT_FS_ERRORS.has(error.code)) throw error;
			}
		}
		// A live owner (or a still-young ownerless lock) is never stolen from.
		if (performance.now() >= deadline) {
			throw new Error(`Timed out waiting for Pi fixture preparation. If no prepare is running, remove ${lock} and retry.`);
		}
		await sleep(pollMs);
	}
	const token = randomUUID();
	try {
		await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, ...currentPidSpace(), token }));
	} catch (error) {
		// We created this directory a moment ago and nobody can have reaped it yet, so removing it
		// by name is safe here (unlike on release); otherwise it would linger for the grace period.
		await removeQuietly(lock);
		throw error;
	}
	// mtime is the only liveness evidence peers in another pid space can read, so keep it fresh.
	// A beat first re-checks ownership: an owner that was reclaimed must not keep its successor's
	// lock looking alive.
	const heartbeat = setInterval(() => {
		ownsLock(lock, token, readText).then((ownership) => {
			if (ownership === "no") return clearInterval(heartbeat); // reclaimed: stop touching the successor's lock
			// "unknown" keeps beating: a transient glitch is far likelier than a lost lock, and a missed beat is worse.
			const now = new Date();
			return utimes(lock, now, now);
		}).catch(() => undefined); // best effort; a missed beat is tolerated
	}, heartbeatMs);
	heartbeat.unref(); // never keep the process alive just for the heartbeat
	try {
		return await run();
	} finally {
		clearInterval(heartbeat);
		await releaseLock(lock, token, removeDir, readText, warn);
	}
}