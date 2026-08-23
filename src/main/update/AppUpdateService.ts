import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
	AppUpdateAsset,
	AppUpdateDownloadProgress,
	AppUpdateDownloadResult,
	AppUpdateInfo,
} from "../../shared/types";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import type { AppLogger } from "../logging/AppLogger";
import type {
	PlatformApplication,
	PlatformDownloads,
	PlatformPaths,
	PlatformShell,
} from "../platform/PlatformServices";

export const RELEASES_URL = "https://github.com/ayuayue/pi-desktop/releases";
const LATEST_RELEASE_API = "https://api.github.com/repos/ayuayue/pi-desktop/releases/latest";

type GitHubRelease = {
	tag_name?: string;
	name?: string;
	body?: string;
	html_url?: string;
	published_at?: string;
	assets?: Array<{ name: string; browser_download_url: string; size: number }>;
};

type AppUpdateServiceDeps = {
	logger: AppLogger;
	translate: (key: MainProcessTranslationKey) => string;
	emitProgress: (progress: AppUpdateDownloadProgress) => void;
	platformApp: PlatformApplication;
	platformPaths: PlatformPaths;
	platformShell: Pick<PlatformShell, "openPath">;
	platformDownloads: PlatformDownloads;
	fetchFn?: typeof globalThis.fetch;
};

function parseGitHubRelease(value: unknown): GitHubRelease {
	if (typeof value !== "object" || value === null) return {};
	const tagName = "tag_name" in value && typeof value.tag_name === "string" ? value.tag_name : undefined;
	const name = "name" in value && typeof value.name === "string" ? value.name : undefined;
	const body = "body" in value && typeof value.body === "string" ? value.body : undefined;
	const htmlUrl = "html_url" in value && typeof value.html_url === "string" ? value.html_url : undefined;
	const publishedAt = "published_at" in value && typeof value.published_at === "string" ? value.published_at : undefined;
	const assets: NonNullable<GitHubRelease["assets"]> = [];
	if ("assets" in value && Array.isArray(value.assets)) {
		for (const asset of value.assets) {
			if (
				typeof asset === "object" && asset !== null &&
				"name" in asset && typeof asset.name === "string" &&
				"browser_download_url" in asset && typeof asset.browser_download_url === "string" &&
				"size" in asset && typeof asset.size === "number"
			) {
				assets.push({ name: asset.name, browser_download_url: asset.browser_download_url, size: asset.size });
			}
		}
	}
	return { tag_name: tagName, name, body, html_url: htmlUrl, published_at: publishedAt, assets };
}

function normalizeVersion(version: string) {
	return version.trim().replace(/^v/i, "");
}

function compareVersions(left: string, right: string) {
	const leftParts = normalizeVersion(left).split(/[.-]/).map((part) => Number(part) || 0);
	const rightParts = normalizeVersion(right).split(/[.-]/).map((part) => Number(part) || 0);
	const length = Math.max(leftParts.length, rightParts.length);
	for (let index = 0; index < length; index += 1) {
		const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

function selectRecommendedAsset(
	assets: AppUpdateAsset[],
	installationType?: "portable" | "installed",
) {
	const platform = process.platform;
	const arch = process.arch;
	// Windows 便携版以运行时环境为准，兼容旧设置中残留的安装形态。
	const isPortable = platform === "win32"
		? process.env.PORTABLE_EXECUTABLE_DIR !== undefined || installationType === "portable"
		: installationType === "portable";
	const candidates = assets.map((asset) => ({ ...asset, lowerName: asset.name.toLowerCase() }));
	const archKeywords = arch === "arm64" ? ["arm64", "aarch64"] : ["x64", "amd64", "x86_64"];
	const matchesArch = (name: string) => archKeywords.some((keyword) => name.includes(keyword));
	const isWrongArch = (name: string) => arch === "arm64"
		? /\b(x64|amd64|x86_64)\b/i.test(name)
		: /\b(arm64|aarch64)\b/i.test(name);
	const isWindowsAsset = (name: string) =>
		/\.(exe|msi)$/i.test(name) || (name.endsWith(".zip") && !/(mac|darwin|osx|linux|appimage|deb|tar\.gz)/i.test(name));
	const isMacAsset = (name: string) => /\.(dmg)$/i.test(name) || /(mac|darwin|osx)/i.test(name);
	const isLinuxAsset = (name: string) => /(appimage|\.deb$|\.tar\.gz$|linux)/i.test(name);

	if (platform === "win32") {
		const platformCandidates = candidates.filter((asset) => isWindowsAsset(asset.lowerName));
		if (isPortable) {
			return platformCandidates.find((asset) => !asset.lowerName.includes("setup") && asset.lowerName.endsWith(".exe") && matchesArch(asset.lowerName))
				?? platformCandidates.find((asset) => !asset.lowerName.includes("setup") && asset.lowerName.endsWith(".exe") && !isWrongArch(asset.lowerName))
				?? platformCandidates.find((asset) => asset.lowerName.endsWith(".zip") && matchesArch(asset.lowerName))
				?? platformCandidates.find((asset) => asset.lowerName.endsWith(".zip") && !isWrongArch(asset.lowerName));
		}
		return platformCandidates.find((asset) => asset.lowerName.includes("setup") && asset.lowerName.endsWith(".exe") && matchesArch(asset.lowerName))
			?? platformCandidates.find((asset) => asset.lowerName.includes("setup") && asset.lowerName.endsWith(".exe") && !isWrongArch(asset.lowerName))
			?? platformCandidates.find((asset) => asset.lowerName.endsWith(".exe") && matchesArch(asset.lowerName))
			?? platformCandidates.find((asset) => asset.lowerName.endsWith(".exe") && !isWrongArch(asset.lowerName))
			?? platformCandidates.find((asset) => asset.lowerName.endsWith(".zip") && matchesArch(asset.lowerName))
			?? platformCandidates.find((asset) => asset.lowerName.endsWith(".zip") && !isWrongArch(asset.lowerName));
	}

	if (platform === "darwin") {
		const platformCandidates = candidates.filter((asset) => isMacAsset(asset.lowerName));
		return platformCandidates.find((asset) => asset.lowerName.endsWith(".dmg") && matchesArch(asset.lowerName))
			?? platformCandidates.find((asset) => asset.lowerName.endsWith(".dmg") && !isWrongArch(asset.lowerName))
			?? platformCandidates.find((asset) => asset.lowerName.endsWith(".zip") && matchesArch(asset.lowerName))
			?? platformCandidates.find((asset) => asset.lowerName.endsWith(".zip") && !isWrongArch(asset.lowerName));
	}

	if (platform === "linux") {
		const platformCandidates = candidates.filter((asset) => isLinuxAsset(asset.lowerName));
		return platformCandidates.find((asset) => asset.lowerName.includes("appimage") && matchesArch(asset.lowerName))
			?? platformCandidates.find((asset) => asset.lowerName.includes("appimage") && !isWrongArch(asset.lowerName))
			?? platformCandidates.find((asset) => asset.lowerName.endsWith(".deb") && matchesArch(asset.lowerName))
			?? platformCandidates.find((asset) => asset.lowerName.endsWith(".deb") && !isWrongArch(asset.lowerName))
			?? platformCandidates.find((asset) => asset.lowerName.endsWith(".tar.gz") && matchesArch(asset.lowerName))
			?? platformCandidates.find((asset) => asset.lowerName.endsWith(".tar.gz") && !isWrongArch(asset.lowerName));
	}

	return candidates.find((asset) => matchesArch(asset.lowerName)) ?? candidates[0];
}

/** Owns update discovery, download progress, and handing packages to the OS. */
export function createAppUpdateService(deps: AppUpdateServiceDeps) {
	const currentVersion = deps.platformApp.version;
	const fetchImpl = deps.fetchFn ?? globalThis.fetch;

	async function checkForAppUpdate(installationType?: "portable" | "installed"): Promise<AppUpdateInfo> {
		void deps.logger.info("update", "Check for app update", { currentVersion, installationType });
		const response = await fetchImpl(LATEST_RELEASE_API, {
			headers: { Accept: "application/vnd.github+json", "User-Agent": `pi-desktop/${currentVersion}` },
		});
		if (!response.ok) {
			void deps.logger.warn("update", "GitHub release check failed", { status: response.status });
			throw new Error(deps.translate("update.checkFailed"));
		}
		const release = parseGitHubRelease(await response.json());
		const latestVersion = normalizeVersion(release.tag_name || currentVersion);
		const assets = (release.assets ?? []).map((asset) => ({
			name: asset.name,
			url: asset.browser_download_url,
			size: asset.size,
		}));
		const recommendedAsset = selectRecommendedAsset(assets, installationType);
		const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
		void deps.logger.info("update", "App update check completed", {
			currentVersion,
			latestVersion,
			hasUpdate,
			recommendedAsset: recommendedAsset?.name,
		});
		return {
			currentVersion,
			latestVersion,
			hasUpdate,
			releaseName: release.name || `v${latestVersion}`,
			releaseNotes: release.body || "",
			releaseUrl: release.html_url || RELEASES_URL,
			publishedAt: release.published_at,
			assets,
			recommendedAsset,
		};
	}

	async function downloadUpdateAsset(asset: AppUpdateAsset): Promise<AppUpdateDownloadResult> {
		if (!asset.url || !/^https:\/\//i.test(asset.url)) {
			void deps.logger.warn("update", "Rejected invalid update download URL", { assetName: asset.name, url: asset.url });
			throw new Error(deps.translate("update.invalidDownloadUrl"));
		}

		const safeName = basename(asset.name).replace(/[<>:"/\\|?*]+/g, "-");
		const userDataDir = deps.platformPaths.userData;
		const downloadDir = join(userDataDir, "updates");
		await mkdir(downloadDir, { recursive: true });
		const filePath = join(downloadDir, safeName);
		const startedAt = Date.now();
		let receivedBytes = 0;
		let totalBytes = asset.size > 0 ? asset.size : undefined;

		void deps.logger.info("update", "Download update asset started", { assetName: asset.name, url: asset.url });

		try {
			const downloaded = await deps.platformDownloads.downloadToFile({
				url: asset.url,
				filePath,
				headers: { "User-Agent": `pi-desktop/${currentVersion}` },
				expectedBytes: asset.size > 0 ? asset.size : undefined,
				onRedirect: (redirectUrl) => {
					void deps.logger.debug("update", "Follow update download redirect", { redirectUrl });
				},
				onProgress: (progress) => {
					receivedBytes = progress.receivedBytes;
					if (progress.totalBytes) totalBytes = progress.totalBytes;
					const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
					deps.emitProgress({
						assetName: asset.name,
						receivedBytes,
						totalBytes,
						percent: totalBytes ? Math.min(100, (receivedBytes / totalBytes) * 100) : undefined,
						bytesPerSecond: receivedBytes / elapsedSeconds,
						state: "downloading",
					});
				},
			});
			// 下载完成：以 downloader 的返回值为最终权威字节统计。
			// onProgress 是实时回调，最后一次 callback 可能早于最终写入，
			// 或某些实现根本不调用 onProgress；返回值才是最终收到的字节数。
			receivedBytes = downloaded.receivedBytes;
			// 仅当 downloader 报告了总字节数时才覆盖，
			// 否则保留 asset.size / onProgress 解析出的 totalBytes。
			if (downloaded.totalBytes !== undefined) {
				totalBytes = downloaded.totalBytes;
			}
			deps.emitProgress({ assetName: asset.name, receivedBytes, totalBytes, percent: 100, state: "completed", filePath });
			void deps.logger.info("update", "Download update asset completed", { assetName: asset.name, filePath, receivedBytes });
			return { filePath, assetName: asset.name };
		} catch (error: unknown) {
			void deps.logger.warn("update", "Update download request failed", { assetName: asset.name, error: error instanceof Error ? error.message : String(error) });
			const publicError = new Error(deps.translate("update.downloadFailed"));
			deps.emitProgress({ assetName: asset.name, receivedBytes, totalBytes, state: "failed", error: publicError.message });
			throw publicError;
		}
	}

	async function installDownloadedUpdate(filePath: string): Promise<void> {
		await deps.logger.info("update", "Open downloaded update package", { filePath });
		const result = await deps.platformShell.openPath(filePath);
		if (result.ok) return;
		await deps.logger.warn("update", "Failed to open downloaded update package", { filePath, error: result.error });
		throw new Error(deps.translate("update.openFailed"));
	}

	return { checkForAppUpdate, downloadUpdateAsset, installDownloadedUpdate };
}
