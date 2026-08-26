import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { getAppLogger } from "./logging/sharedLogger";

/**
 * Version-isolated single-instance coordination.
 *
 * The lock file is only metadata. Focus delivery uses a per-version named pipe
 * (Unix domain socket on POSIX), so a stale PID cannot be mistaken for a live
 * primary and focus payloads cannot be lost to fs.watch/write races.
 */
export type VersionSingleInstanceResult = {
	isPrimary: boolean;
	dispose: () => void;
};

export type FocusPayload = {
	at: number;
	fromPid: number;
	argv?: string[];
};

type LockPayload = {
	pid: number;
	version: string;
	at: number;
	instanceToken: string;
	endpoint: string;
};

function sanitizeVersion(version: string): string {
	return version.replace(/[^\w.-]+/g, "_") || "unknown";
}

function locksDir(userDataDir: string): string {
	return join(userDataDir, "instance-locks");
}

function lockPathFor(userDataDir: string, version: string): string {
	return join(locksDir(userDataDir), `${sanitizeVersion(version)}.lock`);
}

function endpointFor(userDataDir: string, version: string): string {
	const digest = createHash("sha256")
		.update(`${userDataDir}\0${version}`)
		.digest("hex")
		.slice(0, 32);
	if (process.platform === "win32") return `\\\\.\\pipe\\pideck-${digest}`;
	return join(locksDir(userDataDir), `pideck-${digest}.sock`);
}

function readLock(lockPath: string): LockPayload | null {
	try {
		const raw = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockPayload>;
		if (typeof raw.pid !== "number" || typeof raw.endpoint !== "string") return null;
		return {
			pid: raw.pid,
			version: typeof raw.version === "string" ? raw.version : "",
			at: typeof raw.at === "number" ? raw.at : 0,
			instanceToken: typeof raw.instanceToken === "string" ? raw.instanceToken : "",
			endpoint: raw.endpoint,
		};
	} catch {
		return null;
	}
}

function writeLockAtomic(lockPath: string, payload: LockPayload): boolean {
	try {
		const fd = openSync(lockPath, "wx");
		try {
			writeFileSync(fd, JSON.stringify(payload), "utf8");
		} finally {
			closeSync(fd);
		}
		return true;
	} catch {
		return false;
	}
}

function closeServer(server: Server, endpoint: string): void {
	server.close();
	if (process.platform !== "win32") {
		try { unlinkSync(endpoint); } catch { /* stale endpoint cleanup is best effort */ }
	}
}

function endpointReachable(endpoint: string, timeoutMs = 250): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const socket = createConnection(endpoint);
		const finish = (reachable: boolean) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(reachable);
		};
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
		socket.setTimeout(timeoutMs, () => finish(false));
	});
}

function parseFocusPayload(raw: string): FocusPayload | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		const value = parsed as Partial<FocusPayload>;
		if (typeof value.at !== "number" || typeof value.fromPid !== "number") return null;
		return {
			at: value.at,
			fromPid: value.fromPid,
			argv: Array.isArray(value.argv) ? value.argv.filter((item): item is string => typeof item === "string") : [],
		};
	} catch {
		return null;
	}
}

async function listenFocusEndpoint(endpoint: string, onPayload: (payload: FocusPayload) => void): Promise<Server | null> {
	if (process.platform !== "win32" && existsSync(endpoint) && !(await endpointReachable(endpoint))) {
		try { unlinkSync(endpoint); } catch { /* listen below reports a real failure */ }
	}
	return new Promise((resolve) => {
		const server = createServer((socket: Socket) => {
			const chunks: Buffer[] = [];
			socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
			socket.once("end", () => {
				const payload = parseFocusPayload(Buffer.concat(chunks).toString("utf8"));
				if (payload) onPayload(payload);
			});
			socket.on("error", () => undefined);
		});
		const onError = () => {
			server.removeAllListeners();
			server.close();
			resolve(null);
		};
		server.once("error", onError);
		server.listen(endpoint, () => {
			server.removeListener("error", onError);
			resolve(server);
		});
	});
}

async function sendFocusRequest(endpoint: string, payload: FocusPayload): Promise<void> {
	const raw = JSON.stringify(payload);
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const delivered = await new Promise<boolean>((resolve) => {
			const socket = createConnection(endpoint);
			const finish = (ok: boolean) => {
				socket.destroy();
				resolve(ok);
			};
			socket.once("connect", () => socket.end(raw, () => finish(true)));
			socket.once("error", () => finish(false));
			socket.setTimeout(300, () => finish(false));
		});
		if (delivered) return;
		await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
	}
}

/**
 * Become the primary instance or deliver a focus request to the existing one.
 * The endpoint is claimed before the metadata lock, preventing two processes
 * from both deciding that a startup window without a listening primary is live.
 */
export async function acquireVersionSingleInstance(options: {
	enabled: boolean;
	version: string;
	userDataDir: string;
	argv: string[];
	onFocusRequest: (payload: FocusPayload) => void;
}): Promise<VersionSingleInstanceResult> {
	const { enabled, version, userDataDir, argv, onFocusRequest } = options;
	if (!enabled) return { isPrimary: true, dispose: () => undefined };

	const instanceLocksDir = locksDir(userDataDir);
	mkdirSync(instanceLocksDir, { recursive: true });
	const lockPath = lockPathFor(userDataDir, version);
	const endpoint = endpointFor(userDataDir, version);
	const focusServer = await listenFocusEndpoint(endpoint, onFocusRequest);
	if (!focusServer) {
		void sendFocusRequest(endpoint, {
			at: Date.now(),
			fromPid: process.pid,
			argv: argv.slice(1),
		});
		void getAppLogger()?.info("single-instance", "Secondary instance exiting; focus requested", {
			version,
			fromPid: process.pid,
		});
		return { isPrimary: false, dispose: () => undefined };
	}

	const instanceToken = randomUUID();
	const payload: LockPayload = { pid: process.pid, version, at: Date.now(), instanceToken, endpoint };
	if (!writeLockAtomic(lockPath, payload)) {
		// The endpoint was successfully claimed by this process, so an existing
		// lock cannot belong to a live primary. Reclaim only this version's lock.
		try { unlinkSync(lockPath); } catch { /* concurrent cleanup */ }
		if (!writeLockAtomic(lockPath, payload)) {
			closeServer(focusServer, endpoint);
			void sendFocusRequest(endpoint, { at: Date.now(), fromPid: process.pid, argv: argv.slice(1) });
			return { isPrimary: false, dispose: () => undefined };
		}
	}

	void getAppLogger()?.info("single-instance", "Primary instance lock acquired", {
		version,
		pid: process.pid,
		instanceToken,
	});

	let disposed = false;
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		closeServer(focusServer, endpoint);
		try {
			const current = readLock(lockPath);
			if (current?.instanceToken === instanceToken && existsSync(lockPath)) unlinkSync(lockPath);
		} catch {
			// best effort during process shutdown
		}
	};

	return { isPrimary: true, dispose };
}
