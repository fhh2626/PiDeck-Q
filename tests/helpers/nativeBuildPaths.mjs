/** Xmake component paths for the running host. An explicit pin is never replaced. */
export function nativeBuildPaths(target, { pinned, platform = process.platform, arch = process.arch } = {}) {
	if (pinned) return [pinned];
	const directory = platform === "win32" ? "windows" : platform === "darwin" ? "macosx" : platform;
	const filename = `${target}${platform === "win32" ? ".exe" : ""}`;
	return ["debug", "release"].map((mode) => `build/${directory}/${arch}/${mode}/${filename}`);
}
