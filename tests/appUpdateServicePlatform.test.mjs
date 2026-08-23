import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppUpdateService } from "../src/main/update/AppUpdateService.ts";
import { PlatformDownloadError } from "../src/main/platform/PlatformServices.ts";

const updateTestRoot = await mkdtemp(join(tmpdir(), "pideck-update-service-"));
after(async () => {
	await rm(updateTestRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function createFakeLogger() {
	return {
		info: () => {},
		warn: () => {},
		error: () => {},
	};
}

function createFakeApp() {
	return {
		name: "PiDeck",
		version: "1.0.0",
		isPackaged: false,
		getLocale: () => "zh-CN",
		getPreferredSystemLanguages: () => ["zh-CN"],
		hideApplicationMenu: () => {},
	};
}

function createFakePaths() {
	return {
		home: join(updateTestRoot, "home"),
		userData: join(updateTestRoot, "userData"),
		appPath: join(updateTestRoot, "app"),
		resourcesPath: join(updateTestRoot, "resources"),
	};
}

test("AppUpdateService rejects invalid non-https url without calling downloads", async () => {
	let downloadCalled = false;
	const service = createAppUpdateService({
		logger: createFakeLogger(),
		translate: (key) => key,
		emitProgress: () => {},
		platformApp: createFakeApp(),
		platformPaths: createFakePaths(),
		platformDownloads: {
			downloadToFile: async () => {
				downloadCalled = true;
				return { receivedBytes: 100 };
			},
		},
		platformShell: {
			openPath: async () => ({ ok: true }),
		},
	});

	await assert.rejects(
		() => service.downloadUpdateAsset({ name: "app.exe", url: "http://example.com/app.exe", size: 100 }),
		/update\.invalidDownloadUrl/,
	);
	assert.equal(downloadCalled, false);
});

test("AppUpdateService translates download failure when downloader throws PlatformDownloadError", async () => {
	const progressEvents = [];
	const service = createAppUpdateService({
		logger: createFakeLogger(),
		translate: (key) => key,
		emitProgress: (p) => progressEvents.push(p),
		platformApp: createFakeApp(),
		platformPaths: createFakePaths(),
		platformShell: {
			openPath: async () => ({ ok: true }),
		},
		platformDownloads: {
			downloadToFile: async () => {
				throw new PlatformDownloadError("HTTP 404", 404);
			},
		},
	});

	await assert.rejects(
		() => service.downloadUpdateAsset({ name: "app.exe", url: "https://example.com/app.exe", size: 100 }),
		/update\.downloadFailed/,
	);
	assert.equal(progressEvents.some((p) => p.state === "failed"), true);
});

test("AppUpdateService downloads successfully and emits progress and completed event", async () => {
	const progressEvents = [];
	let loggedRedirect = "";
	const service = createAppUpdateService({
		logger: {
			info: () => {},
			warn: () => {},
			error: () => {},
			debug: (_cat, _msg, meta) => {
				if (meta?.redirectUrl) loggedRedirect = meta.redirectUrl;
			},
		},
		translate: (key) => key,
		emitProgress: (p) => progressEvents.push(p),
		platformApp: createFakeApp(),
		platformPaths: createFakePaths(),
		platformShell: {
			openPath: async () => ({ ok: true }),
		},
		platformDownloads: {
			downloadToFile: async (req) => {
				req.onRedirect?.("https://storage.example.com/app.exe");
				req.onProgress?.({ receivedBytes: 50, totalBytes: 100 });
				req.onProgress?.({ receivedBytes: 100, totalBytes: 100 });
				return { receivedBytes: 100, totalBytes: 100 };
			},
		},
	});

	const result = await service.downloadUpdateAsset({
		name: "app.exe",
		url: "https://example.com/app.exe",
		size: 100,
	});

	assert.match(result.filePath, /app\.exe$/);
	assert.equal(loggedRedirect, "https://storage.example.com/app.exe");

	const downloading = progressEvents.filter((progress) => progress.state === "downloading");
	assert.equal(downloading.length, 2);
	assert.deepEqual(
		downloading.map(({ receivedBytes, totalBytes, percent }) => ({ receivedBytes, totalBytes, percent })),
		[
			{ receivedBytes: 50, totalBytes: 100, percent: 50 },
			{ receivedBytes: 100, totalBytes: 100, percent: 100 },
		],
	);
	for (const progress of downloading) {
		assert.equal(typeof progress.bytesPerSecond, "number");
		assert.equal(Number.isFinite(progress.bytesPerSecond), true);
		assert.equal(progress.bytesPerSecond > 0, true);
	}

	const completed = progressEvents.find((progress) => progress.state === "completed");
	assert.ok(completed, "must emit a completed event");
	assert.equal(completed.receivedBytes, 100);
	assert.equal(completed.totalBytes, 100);
	assert.equal(completed.percent, 100);
	assert.equal(completed.filePath, result.filePath);
});

test("AppUpdateService installDownloadedUpdate opens the original package path once", async () => {
	const openedPaths = [];
	const service = createAppUpdateService({
		logger: createFakeLogger(),
		translate: (key) => key,
		emitProgress: () => {},
		platformApp: createFakeApp(),
		platformPaths: createFakePaths(),
		platformDownloads: {
			downloadToFile: async () => ({ receivedBytes: 0 }),
		},
		platformShell: {
			openPath: async (filePath) => {
				openedPaths.push(filePath);
				return { ok: true };
			},
		},
	});
	const filePath = join(updateTestRoot, "downloads", "PiDeck Setup.exe");

	await service.installDownloadedUpdate(filePath);

	assert.deepEqual(openedPaths, [filePath]);
});

test("AppUpdateService installDownloadedUpdate translates failure when openPath fails", async () => {
	const service = createAppUpdateService({
		logger: createFakeLogger(),
		translate: (key) => key,
		emitProgress: () => {},
		platformApp: createFakeApp(),
		platformPaths: createFakePaths(),
		platformDownloads: {
			downloadToFile: async () => ({ receivedBytes: 0 }),
		},
		platformShell: {
			openPath: async () => ({ ok: false, error: "Access denied" }),
		},
	});

	await assert.rejects(
		() => service.installDownloadedUpdate("/path/to/update.exe"),
		/update\.openFailed/,
	);
});

test("AppUpdateService completed event uses downloader return value when onProgress never fires", async () => {
	const progressEvents = [];
	const service = createAppUpdateService({
		logger: createFakeLogger(),
		translate: (key) => key,
		emitProgress: (p) => progressEvents.push(p),
		platformApp: createFakeApp(),
		platformPaths: createFakePaths(),
		platformDownloads: {
			// 不调用 onProgress，只返回最终统计
			downloadToFile: async () => ({ receivedBytes: 1234, totalBytes: 1234 }),
		},
	});

	await service.downloadUpdateAsset({
		name: "app.exe",
		url: "https://example.com/app.exe",
		size: 0,
	});

	const completed = progressEvents.find((p) => p.state === "completed");
	assert.ok(completed, "must emit a completed event");
	assert.equal(completed.receivedBytes, 1234);
	assert.equal(completed.totalBytes, 1234);
});

test("AppUpdateService completed event prefers returned bytes over stale last onProgress", async () => {
	const progressEvents = [];
	const service = createAppUpdateService({
		logger: createFakeLogger(),
		translate: (key) => key,
		emitProgress: (p) => progressEvents.push(p),
		platformApp: createFakeApp(),
		platformPaths: createFakePaths(),
		platformDownloads: {
			downloadToFile: async (req) => {
				// 最后一次 onProgress 只报告了 100，但最终写入 120
				req.onProgress?.({ receivedBytes: 100, totalBytes: 100 });
				return { receivedBytes: 120, totalBytes: 120 };
			},
		},
	});

	await service.downloadUpdateAsset({
		name: "app.exe",
		url: "https://example.com/app.exe",
		size: 100,
	});

	const completed = progressEvents.find((p) => p.state === "completed");
	assert.ok(completed, "must emit a completed event");
	assert.equal(completed.receivedBytes, 120, "completed must use returned value, not stale onProgress");
	assert.equal(completed.totalBytes, 120);
});

test("AppUpdateService completed event keeps asset.size as total when downloader returns no total", async () => {
	const progressEvents = [];
	const service = createAppUpdateService({
		logger: createFakeLogger(),
		translate: (key) => key,
		emitProgress: (p) => progressEvents.push(p),
		platformApp: createFakeApp(),
		platformPaths: createFakePaths(),
		platformDownloads: {
			// 返回 receivedBytes 但不带 totalBytes：应保留 asset.size 作为总大小
			downloadToFile: async () => ({ receivedBytes: 55 }),
		},
	});

	await service.downloadUpdateAsset({
		name: "app.exe",
		url: "https://example.com/app.exe",
		size: 88,
	});

	const completed = progressEvents.find((p) => p.state === "completed");
	assert.ok(completed, "must emit a completed event");
	assert.equal(completed.receivedBytes, 55);
	assert.equal(completed.totalBytes, 88, "totalBytes should fall back to asset.size when downloader omits it");
});
