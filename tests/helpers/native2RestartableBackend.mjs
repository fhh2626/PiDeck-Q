// Restartable backend fixture for the scan/cache suites.
//
// `startBackendSession` creates a brand-new temp fixture per call, which cannot express
// "the same userData and session tree, a second process": the summary cache is a *disk*
// contract, so the test must stop a backend and start another one against the same
// directories. This helper keeps the public-wire contract identical (Qt host bridge +
// loopback RPC) and only adds explicit stop/start around one shared fixture.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	backendEnvFor,
	backendFixtureSettings,
	FakeHost,
	resolveBackendExecutable,
	rpc,
	spawnBackend,
	waitForRendererReady,
} from "./native2BackendHarness.mjs";

const TOKEN = "scan-cache-token";

/** Directories a backend needs, all under one root that survives a restart. */
export function createSharedFixture({ projects = [], settings = {} } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pideck-native2-scan-"));
	const fixture = {
		root,
		userData: join(root, "user-data"),
		renderer: join(root, "renderer"),
		backgrounds: join(root, "backgrounds"),
		sessions: join(root, "sessions"),
		prompts: join(root, "prompts"),
		skills: join(root, "skills"),
		project: join(root, "project"),
	};
	for (const directory of [
		fixture.userData,
		join(fixture.renderer, "assets"),
		fixture.backgrounds,
		fixture.sessions,
		fixture.prompts,
		fixture.skills,
		fixture.project,
	]) {
		mkdirSync(directory, { recursive: true });
	}
	writeFileSync(join(fixture.renderer, "index.html"), "<!doctype html><html><body>PiDeck shell</body></html>");
	writeFileSync(join(fixture.renderer, "assets/app.js"), "export const marker = 'pideck-app';\n");
	writeFileSync(join(fixture.userData, "settings.json"), JSON.stringify(backendFixtureSettings(settings)));
	if (projects.length > 0) {
		writeFileSync(
			join(fixture.userData, "projects.json"),
			JSON.stringify(
				projects.map((project, index) => ({
					id: project.id,
					name: project.name ?? `project-${index}`,
					path: project.path,
					lastOpenedAt: 1_700_000_000_000 + index,
					sortOrder: index,
					environment: project.environment ?? "windows",
				})),
			),
		);
	}
	return fixture;
}

/**
 * Start one backend against `fixture` and return a bound RPC helper.
 * `t.after` tears the process down, so a test that forgets to stop cannot leak a child.
 */
export async function startBackend(t, fixture, { settings = {}, env = {} } = {}) {
	writeFileSync(join(fixture.userData, "settings.json"), JSON.stringify(backendFixtureSettings(settings)));
	const host = new FakeHost({
		token: TOKEN,
		handlers: {
			"clipboard.metadataSnapshot": () => ({
				result: { text: "", html: "", filePaths: [], hasImage: false, sequence: 0 },
			}),
			"shell.trashItem": () => ({ result: null }),
			"shell.openPath": () => ({ result: { ok: true } }),
			"shell.showItemInFolder": () => ({ result: { ok: true } }),
		},
	});
	const hostPort = await host.start();
	const backend = spawnBackend({
		executable: resolveBackendExecutable(),
		hostPort,
		token: TOKEN,
		env: backendEnvFor(fixture, env),
	});
	const handle = { host, backend, stopped: false };
	t.after(async () => {
		await stopBackend(handle);
		rmSync(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	});
	const ready = await waitForRendererReady(host);
	return {
		...handle,
		baseUrl: ready.url,
		token: ready.token,
		invoke: (channel, args = []) => rpc(ready.url, ready.token, channel, args),
	};
}

/** Ask the backend to quit and wait for the process, so the next start is a real restart. */
export async function stopBackend(handle) {
	if (handle.stopped) return;
	handle.stopped = true;
	if (handle.backend.child.exitCode === null) {
		try {
			handle.host.emit("application.prepareQuit");
		} catch {
			// host socket already gone
		}
		const exited = await Promise.race([
			handle.backend.exited.then(() => true),
			new Promise((resolve) => setTimeout(() => resolve(false), 8_000)),
		]);
		if (!exited && handle.backend.child.exitCode === null) handle.backend.child.kill();
	}
	await handle.host.stop();
}

/** Poll `predicate` until it returns a truthy value. */
export async function waitFor(predicate, message, timeoutMs = 15_000, intervalMs = 100) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await predicate();
		if (value) return value;
		if (Date.now() >= deadline) throw new Error(message);
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

/** Parsed `session-summary-cache.json`, or null when it is missing or not valid JSON. */
export function readSummaryCache(fixture) {
	const cachePath = join(fixture.userData, "session-summary-cache.json");
	if (!existsSync(cachePath)) return null;
	try {
		return JSON.parse(readFileSync(cachePath, "utf8"));
	} catch {
		return null;
	}
}

export const summaryCachePath = (fixture) => join(fixture.userData, "session-summary-cache.json");
