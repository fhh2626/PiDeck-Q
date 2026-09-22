const WINDOWS_DRIVE_PATH_RE = /^\/?[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_RE = /^\\\\[^\\/]+[\\/][^\\/]+/;
const RELATIVE_PATH_RE = /^(?:\.\.?[\\/]|[^\\/:*?"<>|]+[\\/])/;
const FILE_EXTENSION_RE = /\.[A-Za-z0-9][A-Za-z0-9._-]*(?::\d+(?::\d+)?)?$/;

export function isAbsoluteFilePath(path: string): boolean {
	if (!path) return false;
	return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/") || WINDOWS_UNC_PATH_RE.test(path);
}

export function resolveFileLinkPath(path: string, basePath?: string): string {
	if (!path || isAbsoluteFilePath(path) || !basePath) return path;
	const separator = basePath.includes("\\") ? "\\" : "/";
	return `${basePath.replace(/[\\/]+$/, "")}${separator}${path.replace(/^[\\/]+/, "")}`;
}

export function stripFileLocation(path: string): string {
	return path.replace(/:\d+(?::\d+)?$/, "");
}

export function normalizeLocalFilePath(value: string): string | null {
	if (!value) return null;

	const target = normalizeLocalFileTarget(value);
	if (!target.ok) return null;
	let path = target.path;

	// Pi agents commonly emit /C:/... links so one Markdown form works across renderers.
	if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);

	const withoutLocation = stripFileLocation(path);
	const isWindowsPath = WINDOWS_DRIVE_PATH_RE.test(path) || WINDOWS_UNC_PATH_RE.test(path);
	const isUnixPath = path.startsWith("/") && !path.startsWith("//");
	const isRelativePath = RELATIVE_PATH_RE.test(path);
	const isBareFileName =
		!withoutLocation.includes(":") &&
		!withoutLocation.includes("#") &&
		!/[\\/]/.test(withoutLocation) &&
		FILE_EXTENSION_RE.test(path);
	const hasFileName = FILE_EXTENSION_RE.test(path);

	if (isWindowsPath || WINDOWS_UNC_PATH_RE.test(withoutLocation)) return path;
	if ((isUnixPath || isRelativePath) && hasFileName) return path;
	if (isBareFileName) return path;
	return null;
}

/** Internal hrefs now use standard absolute URIs or raw relative paths, never encoded separators. */
export function toInternalFileHref(value: string): string | null {
	const path = normalizeLocalFilePath(value);
	return path === null ? null : filePathToUri(path);
}

export function filePathToUri(filePath: string): string {
	if (!isAbsoluteFilePath(filePath)) return filePath;
	const normalized = filePath.replace(/\\/g, "/");
	if (/^[A-Za-z]:\//.test(normalized)) {
		const drive = normalized.slice(0, 2);
		const rest = normalized.slice(2);
		const encodedRest = rest.split("/").map(encodeURIComponent).join("/");
		return `file:///${drive}${encodedRest}`;
	}
	if (normalized.startsWith("//")) {
		return `file:${normalized.split("/").map(encodeURIComponent).join("/")}`;
	}
	if (normalized.startsWith("/")) {
		const encoded = normalized.split("/").map(encodeURIComponent).join("/");
		return `file://${encoded}`;
	}
	// 相对路径
	return normalized;
}

/** Reject invalid/legacy encoded-separator URLs rather than returning an unopened URL as a path. */
export function filePathFromHref(href: string | null | undefined, platform?: "win32" | "linux" | "darwin"): string | null {
	if (!href) return null;
	const res = normalizeLocalFileTarget(href, platform);
	if (!res.ok) return null;
	return /^file:/i.test(href) ? res.path : normalizeLocalFilePath(res.path);
}

export type LocalFileTargetResult =
	| { ok: true; path: string }
	| { ok: false; error: string; code: "INVALID_URL" | "INVALID_ENCODING" | "ENCODED_SEPARATOR" | "UNSUPPORTED_TARGET" };

/**
 * 平台感知的文件链接与本地路径规范化函数。
 */
export function normalizeLocalFileTarget(
	input: string,
	platform: "win32" | "linux" | "darwin" = typeof process !== "undefined" && process.platform && (process.platform === "win32" || process.platform === "linux" || process.platform === "darwin") ? process.platform : "win32",
): LocalFileTargetResult {
	if (!input || typeof input !== "string") {
		return { ok: false, error: "Empty path target", code: "INVALID_URL" };
	}

	const trimmed = input.trim();

	// 1. 若是 file: 协议
	if (/^file:/i.test(trimmed)) {
		// 检查是否有非法编码分隔符（安全规则拒绝）
		if (platform === "win32") {
			if (/%2f|%5c/i.test(trimmed)) {
				return { ok: false, error: "Encoded path separators are not allowed in file URL", code: "ENCODED_SEPARATOR" };
			}
		} else {
			// POSIX: 仅 / 是路径分隔符，%5c 在文件名中是合法字符
			if (/%2f/i.test(trimmed)) {
				return { ok: false, error: "Encoded path separators are not allowed in file URL", code: "ENCODED_SEPARATOR" };
			}
		}

		// 检查是否为旧版直接拼接格式：file://R:/... 或 file://R:\...
		if (platform === "win32") {
			const legacyWinDriveMatch = trimmed.match(/^file:\/\/([A-Za-z]:[\\/].*)$/);
			if (legacyWinDriveMatch) {
				try {
					const decoded = decodeURIComponent(legacyWinDriveMatch[1]);
					return { ok: true, path: decoded };
				} catch {
					return { ok: false, error: "Invalid percent encoding in legacy file URL", code: "INVALID_ENCODING" };
				}
			}
		}

		// 标准 URL 解析
		let parsed: URL;
		try {
			parsed = new URL(trimmed);
		} catch {
			return { ok: false, error: "Invalid file URL", code: "INVALID_URL" };
		}

		if (parsed.protocol.toLowerCase() !== "file:") {
			return { ok: false, error: "Not a file protocol URL", code: "UNSUPPORTED_TARGET" };
		}

		let pathname = parsed.pathname;
		try {
			pathname = decodeURIComponent(pathname);
		} catch {
			return { ok: false, error: "Invalid percent encoding in pathname", code: "INVALID_ENCODING" };
		}

		if (platform === "win32") {
			// UNC URL: file://server/share/path (parsed.host 非空)
			if (parsed.host && parsed.host !== "localhost") {
				let hostName = parsed.host;
				try {
					hostName = decodeURIComponent(hostName);
				} catch {
					return { ok: false, error: "Invalid host encoding", code: "INVALID_ENCODING" };
				}
				const uncPath = `\\\\${hostName}${pathname.replace(/\//g, "\\")}`;
				return { ok: true, path: uncPath };
			}

			// Windows 盘符路径：如 /R:/Temp/a.png -> R:/Temp/a.png
			if (/^\/[A-Za-z]:\//.test(pathname)) {
				return { ok: true, path: pathname.slice(1) };
			}
			// 或无开头斜杠的盘符（某些 URL 实现）
			if (/^[A-Za-z]:\//.test(pathname)) {
				return { ok: true, path: pathname };
			}

			// 其他 Windows 路径格式，若以 / 开头且后随盘符
			if (/^\/[A-Za-z]:[\\/]/.test(pathname)) {
				return { ok: true, path: pathname.slice(1) };
			}

			return { ok: true, path: pathname };
		} else {
			// POSIX (linux / darwin):
			// 若带远程 host（如 file://server/share/a.png），非本地主机，不能静默变成本地 /share/a.png
			if (parsed.host && parsed.host !== "localhost") {
				return { ok: false, error: "Remote file hosts are not supported on POSIX", code: "UNSUPPORTED_TARGET" };
			}
			// POSIX 必须保留开头的 /
			return { ok: true, path: pathname };
		}
	}

	// 2. 外部链接协议（http, https, mailto 等）拒绝作为本地文件目标
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) || /^(mailto|javascript|data):/i.test(trimmed)) {
		return { ok: false, error: "External URL target cannot be opened as local file", code: "UNSUPPORTED_TARGET" };
	}

	// 3. 普通本地路径（绝对或相对路径，Windows 盘符或 UNC 或 Unix 绝对路径或相对路径）
	// 原因：文件名中的字面量 %20 不应被改为空格，所以不对普通路径执行 decodeURIComponent
	return { ok: true, path: trimmed };
}
