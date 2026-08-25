import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

const RELEASE_ASSET_URL = "https://github.com/fhh2626/PiDeck-Q/releases/download/v2.0.0/PiDeck-Q-2.0.0-win-x64.zip";
const RELEASE_ASSET = {
	name: "PiDeck-Q-2.0.0-win-x64.zip",
	url: RELEASE_ASSET_URL,
	size: 100,
};

function fakeReleaseFetch(asset = RELEASE_ASSET) {
	return async () => ({
		ok: true,
		json: async () => ({
			tag_name: "v2.0.0",
			assets: [{ name: asset.name, browser_download_url: asset.url, size: asset.size }],
		}),
	});
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
			showItemInFolder: () => {},
		},
	});

	await assert.rejects(
		() => service.downloadUpdateAsset({ name: "app.exe", url: "http://example.com/app.exe", size: 100 }),
		/update\.invalidDownloadUrl/,
	);
	assert.equal(downloadCalled, false);
});

test("AppUpdateService only accepts assets returned by the latest GitHub release", async () => {
	let downloadCalled = false;
	const service = createAppUpdateService({
		logger: createFakeLogger(),
		translate: (key) => key,
		emitProgress: () => {},
		platformApp: createFakeApp(),
		platformPaths: createFakePaths(),
		platformShell: { showItemInFolder: () => {} },
		platformDownloads: {
			downloadToFile: async () => {
				downloadCalled = true;
				return { receivedBytes: 1 };
			},
		},
		fetchFn: fakeReleaseFetch(),
	});
	await service.checkForAppUpdate("portable");
	await assert.rejects(
		() => service.downloadUpdateAsset({
			...RELEASE_ASSET,
			url: "https://evil.example/update.zip",
		}),
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
			showItemInFolder: () => {},
		},
		platformDownloads: {
			downloadToFile: async () => {
				throw new PlatformDownloadError("HTTP 404", 404);
			},
		},
		fetchFn: fakeReleaseFetch(),
	});
	await service.checkForAppUpdate("portable");

	await assert.rejects(
		() => service.downloadUpdateAsset(RELEASE_ASSET),
		/update\.downloadFailed/,
	);
	assert.equal(progressEvents.some((p) => p.state === "failed"), true);
});

test("AppUpdateService recommends the Windows portable ZIP instead of an installer", async () => {
	const service = createAppUpdateService({
		logger: createFakeLogger(),
		translate: (key) => key,
		emitProgress: () => {},
		platformApp: createFakeApp(),
		platformPaths: createFakePaths(),
		platformShell: { showItemInFolder: () => {} },
		platformDownloads: { downloadToFile: async () => ({ receivedBytes: 0 }) },
		fetchFn: async () => ({
			ok: true,
			json: async () => ({
				tag_name: "v2.0.0",
				assets: [
					{ name: "PiDeck-Q-Setup.exe", browser_download_url: "https://github.com/fhh2626/PiDeck-Q/releases/download/v2.0.0/PiDeck-Q-Setup.exe", size: 10 },
					{ name: RELEASE_ASSET.name, browser_download_url: RELEASE_ASSET.url, size: RELEASE_ASSET.size },
				],
			}),
		}),
	});
	const info = await service.checkForAppUpdate("installed");
	assert.equal(info.recommendedAsset?.name, RELEASE_ASSET.name);
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
			showItemInFolder: () => {},
		},
		platformDownloads: {
			downloadToFile: async (req) => {
				req.onRedirect?.("https://storage.example.com/app.zip");
				req.onProgress?.({ receivedBytes: 50, totalBytes: 100 });
				req.onProgress?.({ receivedBytes: 100, totalBytes: 100 });
				return { receivedBytes: 100, totalBytes: 100 };
			},
		},
		fetchFn: fakeReleaseFetch(),
	});
	await service.checkForAppUpdate("portable");

	const result = await service.downloadUpdateAsset(RELEASE_ASSET);

	assert.match(result.filePath, /\.zip$/);
	assert.equal(loggedRedirect, "https://storage.example.com/app.zip");

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

test("AppUpdateService openDownloadedUpdate opens the original portable package path once", async () => {
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
			showItemInFolder: (filePath) => {
				openedPaths.push(filePath);
			},
		},
	});
	const filePath = join(updateTestRoot, "userData", "updates", "PiDeck-Q-2.0.0-win-x64.zip");
	await mkdir(join(updateTestRoot, "userData", "updates"), { recursive: true });
	await writeFile(filePath, "installer");

	await service.openDownloadedUpdate(filePath);

	assert.deepEqual(openedPaths, [filePath]);
});

test("AppUpdateService rejects update paths outside the managed user-data directory", async () => {
	let opened = false;
	const service = createAppUpdateService({
		logger: createFakeLogger(),
		translate: (key) => key,
		emitProgress: () => {},
		platformApp: createFakeApp(),
		platformPaths: createFakePaths(),
		platformDownloads: { downloadToFile: async () => ({ receivedBytes: 0 }) },
		platformShell: { showItemInFolder: () => { opened = true; } },
	});
	await assert.rejects(
		() => service.openDownloadedUpdate(join(updateTestRoot, "outside.zip")),
		/update\.openFailed/,
	);
	assert.equal(opened, false);
});

test("AppUpdateService openDownloadedUpdate rejects a non-portable Windows package", async () => {
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
			showItemInFolder: () => { throw new Error("must not reveal installer"); },
		},
	});
	const filePath = join(updateTestRoot, "userData", "updates", "update.exe");
	await mkdir(join(updateTestRoot, "userData", "updates"), { recursive: true });
	await writeFile(filePath, "installer");

	await assert.rejects(
		() => service.openDownloadedUpdate(filePath),
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
		fetchFn: fakeReleaseFetch({ ...RELEASE_ASSET, size: 0 }),
	});
	await service.checkForAppUpdate("portable");

	await service.downloadUpdateAsset({ ...RELEASE_ASSET, size: 0 });

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
		fetchFn: fakeReleaseFetch(),
	});
	await service.checkForAppUpdate("portable");

	await service.downloadUpdateAsset(RELEASE_ASSET);

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
		fetchFn: fakeReleaseFetch({ ...RELEASE_ASSET, size: 88 }),
	});
	await service.checkForAppUpdate("portable");

	await service.downloadUpdateAsset({ ...RELEASE_ASSET, size: 88 });

	const completed = progressEvents.find((p) => p.state === "completed");
	assert.ok(completed, "must emit a completed event");
	assert.equal(completed.receivedBytes, 55);
	assert.equal(completed.totalBytes, 88, "totalBytes should fall back to asset.size when downloader omits it");
});
