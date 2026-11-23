import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

let availability;

/**
 * Probe AF_UNIX itself before a transport suite starts. A restricted sandbox can deny
 * this syscall even for a short, writable path. Only that permission failure is a
 * capability skip; backend startup, handshake and unexpected probe errors still fail.
 */
export function localSocketSkipReason() {
	if (process.platform === "win32") return Promise.resolve(false);
	availability ??= (async () => {
		const directory = mkdtempSync(join(tmpdir(), "pd-"));
		const endpoint = join(directory, "s");
		const server = createServer();
		try {
			const error = await new Promise((resolve) => {
				server.once("error", resolve);
				server.listen(endpoint, () => resolve(null));
			});
			if (!error) return false;
			if (error.code === "EPERM" || error.code === "EACCES") {
				return `Environment denies AF_UNIX listen (${error.code}); single-instance transport was not exercised`;
			}
			throw error;
		} finally {
			if (server.listening) await new Promise((resolve) => server.close(resolve));
			rmSync(directory, { recursive: true, force: true });
		}
	})();
	return availability;
}
