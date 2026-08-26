import { mkdir, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import type {
	AppUpdateAsset,
	AppUpdateDownloadProgress,
	AppUpdateDownloadResult,
	AppUpdateInfo,
} from "../../shared/types";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import type { AppLogger } from "../logging/AppLogger";
import { APP_LATEST_RELEASE_API, APP_RELEASES_URL } from "../../shared/appIdentity.ts";
import { gt as semverGt, valid as semverValid } from "semver";
import type {
	PlatformApplication,
	PlatformDownloads,
	PlatformPaths,
	PlatformShell,
} from "../platform/PlatformServices";

export const RELEASES_URL = APP_RELEASES_URL;
const LATEST_RELEASE_API = APP_LATEST_RELEASE_API;

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
	platformShell: Pick<PlatformShell, "showItemInFolder">;
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

function normalizeVersion(version: string): string | null {
	return semverValid(version.trim().replace(/^v/i, ""));
}

function isWithin(root: string, candidate: string): boolean {
	const rel = relative(resolve(root), resolve(candidate));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function compareVersions(left: string, right: string): number {
	const normalizedLeft = normalizeVersion(left);
	const normalizedRight = normalizeVersion(right);
	if (!normalizedLeft || !normalizedRight) return 0;
	return semverGt(normalizedLeft, normalizedRight) ? 1 : normalizedLeft === normalizedRight ? 0 : -1;
}

function selectRecommendedAsset(assets: AppUpdateAsset[]) {
	const platform = process.platform;
	const arch = process.arch;
	const candidates = assets.map((asset) => ({ ...asset, lowerName: asset.name.toLowerCase() }));
	const archKeywords = arch === "arm64" ? ["arm64", "aarch64"] : ["x64", "amd64", "x86_64"];
	const matchesArch = (name: string) => archKeywords.some((keyword) => name.includes(keyword));
	const isWrongArch = (name: string) => arch === "arm64"
		? /\b(x64|amd64|x86_64)\b/i.test(name)
		: /\b(arm64|aarch64)\b/i.test(name);
	const isMacAsset = (name: string) => /\.(dmg)$/i.test(name) || /(mac|darwin|osx)/i.test(name);
	const isLinuxAsset = (name: string) => /(appimage|\.deb$|\.tar\.gz$|linux)/i.test(name);

	if (platform === "win32") {
		// A portable ZIP is the only supported Windows update artifact. Never recommend
		// Setup.exe or a loose executable that the Qt host cannot install safely.
		const portableCandidates = candidates.filter((asset) =>
			asset.lowerName.endsWith(".zip") &&
			!/(mac|darwin|osx|linux|appimage|deb|tar\.gz)/i.test(asset.lowerName),
		);
		return portableCandidates.find((asset) => matchesArch(asset.lowerName))
			?? portableCandidates.find((asset) => !isWrongArch(asset.lowerName));
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
	/** Assets are accepted for download only after they were returned by GitHub's latest-release response. */
	const knownAssets = new Map<string, AppUpdateAsset>();
	const assetKey = (asset: AppUpdateAsset) => `${asset.name}\u0000${asset.url}\u0000${asset.size}`;

	async function checkForAppUpdate(_installationType?: "portable" | "installed"): Promise<AppUpdateInfo> {
		// A failed/expired check must not leave an older release asset downloadable.
		knownAssets.clear();
		void deps.logger.info("update", "Check for app update", { currentVersion, installationType: "portable" });
		const response = await fetchImpl(LATEST_RELEASE_API, {
			headers: { Accept: "application/vnd.github+json", "User-Agent": `pi-desktop/${currentVersion}` },
		});
		if (!response.ok) {
			void deps.logger.warn("update", "GitHub release check failed", { status: response.status });
			throw new Error(deps.translate("update.checkFailed"));
		}
		const release = parseGitHubRelease(await response.json());
		const latestVersion = normalizeVersion(release.tag_name || currentVersion);
		const normalizedCurrentVersion = normalizeVersion(currentVersion);
		if (!latestVersion || !normalizedCurrentVersion) {
			void deps.logger.warn("update", "Invalid release version metadata", {
				currentVersion,
				tagName: release.tag_name,
			});
			throw new Error(deps.translate("update.checkFailed"));
		}
		const assets = (release.assets ?? []).map((asset) => ({
			name: asset.name,
			url: asset.browser_download_url,
			size: asset.size,
		}));
		for (const asset of assets) knownAssets.set(assetKey(asset), asset);
		const recommendedAsset = selectRecommendedAsset(assets);
		const hasUpdate = compareVersions(latestVersion, normalizedCurrentVersion) > 0;
		void deps.logger.info("update", "App update check completed", {
			currentVersion,
			latestVersion,
			hasUpdate,
			recommendedAsset: recommendedAsset?.name,
		});
		return {
			currentVersion: normalizedCurrentVersion,
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
		const knownAsset = knownAssets.get(assetKey(asset));
		const isWindowsPortableZip = process.platform !== "win32" || /\.zip$/i.test(asset.name);
		if (!knownAsset || !asset.url || !/^https:\/\//i.test(asset.url) || !isWindowsPortableZip) {
			void deps.logger.warn("update", "Rejected update asset not returned by the latest release", {
				assetName: asset.name,
				url: asset.url,
			});
			throw new Error(deps.translate("update.invalidDownloadUrl"));
		}

		const safeName = basename(knownAsset.name).replace(/[<>:"/\\|?*]+/g, "-");
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

	async function openDownloadedUpdate(filePath: string): Promise<void> {
		if (typeof filePath !== "string") {
			throw new Error(deps.translate("update.openFailed"));
		}
		const updatesDir = resolve(join(deps.platformPaths.userData, "updates"));
		const resolvedFilePath = resolve(filePath);
		let realUpdatesDir: string;
		let realFilePath: string;
		try {
			realUpdatesDir = await realpath(updatesDir);
			realFilePath = await realpath(resolvedFilePath);
		} catch {
			throw new Error(deps.translate("update.openFailed"));
		}
		if (!isWithin(realUpdatesDir, realFilePath) || basename(resolvedFilePath) !== basename(filePath)) {
			void deps.logger.warn("update", "Rejected update package outside managed download directory", { filePath });
			throw new Error(deps.translate("update.openFailed"));
		}
		if (process.platform === "win32" && extname(realFilePath).toLowerCase() !== ".zip") {
			void deps.logger.warn("update", "Rejected non-portable Windows update package", { filePath: realFilePath });
			throw new Error(deps.translate("update.openFailed"));
		}
		await deps.logger.info("update", "Reveal downloaded portable update package", { filePath: realFilePath });
		deps.platformShell.showItemInFolder(realFilePath);
	}

	return { checkForAppUpdate, downloadUpdateAsset, openDownloadedUpdate };
}
