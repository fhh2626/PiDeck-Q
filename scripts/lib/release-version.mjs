const CORE_VERSION = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2}$/;
const NATIVE_VERSION = /^\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/;
const REBUILD_NUMBER = /^[1-9]\d*$/;

/** Choose the next release tag in this manifest's series, including retired tag-only builds. */
export function nextReleaseVersion(base, occupiedTags) {
	if (typeof base !== "string" || !CORE_VERSION.test(base)) {
		throw new Error(`Expected a stable X.Y.Z package version, got ${String(base)}`);
	}

	let highest = -1n; // No base (0) or numbered rebuild has been released yet.
	for (const rawTag of occupiedTags) {
		const tag = rawTag.startsWith("v") ? rawTag.slice(1) : rawTag;
		if (tag === base) {
			if (highest < 0n) highest = 0n;
		} else if (tag.startsWith(`${base}.`)) {
			const suffix = tag.slice(base.length + 1);
			if (REBUILD_NUMBER.test(suffix) && BigInt(suffix) > highest) highest = BigInt(suffix);
		}
	}
	return highest < 0n ? base : `${base}.${highest + 1n}`;
}

/** The packaging-only stamp can add a rebuild number; it cannot change the base version. */
export function nativeBuildVersion(base, releaseVersion) {
	if (typeof base !== "string" || !NATIVE_VERSION.test(base)) {
		throw new Error(`Invalid package version: ${String(base)}`);
	}
	if (releaseVersion == null || releaseVersion === base) return base;
	if (typeof releaseVersion === "string" && CORE_VERSION.test(base) && releaseVersion.startsWith(`${base}.`)
		&& REBUILD_NUMBER.test(releaseVersion.slice(base.length + 1))) return releaseVersion;
	throw new Error(`PIDECK_RELEASE_VERSION ${releaseVersion} does not match ${base} or ${base}.<positive number>`);
}
