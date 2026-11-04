/**
 * Pure factory for the Pi-fixture module resolve hook. Side-effect free so tests can
 * register it for a temporary project root; piFixtureResolver.mjs installs it for the repo.
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { getPiFixturePackageDir } from "../../scripts/pi-compatibility-fixture.mjs";

const PI_HOSTED_PACKAGES = ["typebox", "yaml", "@earendil-works"];

function isPiHostedSpecifier(specifier) {
	return PI_HOSTED_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

/** Build the resolve hook for a project root. Only extension sources are redirected. */
export function createPiFixtureResolveHook(projectRoot) {
	// A package.json URL inside the fixture package makes Node search the fixture's
	// node_modules hierarchy, including dependencies nested below the Pi package.
	const fixtureParentUrl = pathToFileURL(join(getPiFixturePackageDir(projectRoot), "package.json")).href;
	return function resolve(specifier, context, nextResolve) {
		const isExtensionSource = (context.parentURL ?? "").includes("/resources/extensions/");
		if (!isExtensionSource || !isPiHostedSpecifier(specifier)) return nextResolve(specifier, context);
		return nextResolve(specifier, { ...context, parentURL: fixtureParentUrl });
	};
}
