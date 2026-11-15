#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeSidecarKind, verifyBuildArtifacts } from "./verify-build-artifacts.mjs";

/**
 * `npm run pack` / `verify:build-artifacts` entry point.
 *
 * The packaging gate used to hardcode `--out release/win-unpacked`, while `xmake.lua`
 * already honours `PIDECK_STAGE_DIR`. Measurement runs therefore had to verify a stage
 * they were told not to overwrite, and the two could silently disagree. This wrapper is
 * the single place that maps the environment onto both: `PIDECK_STAGE_DIR` selects the
 * stage (relative values resolve against the repo root, exactly like xmake does), and
 * `PIDECK_SIDECAR_KIND` selects the package definition. With no environment the shipping
 * default - `release/win-unpacked` - is validated as the C++ package, so ordinary
 * `npm run pack` behaviour is unchanged.
 *
 * The library defaults of `verify-build-artifacts.mjs` are deliberately untouched: older
 * callers still hand it a Node layout without naming a kind.
 */
export const DEFAULT_PACK_STAGE = "release/win-unpacked";
export const PACK_SIDECAR_KIND = "cpp";

/**
 * Resolve the stage directory and sidecar kind for a packaging run.
 *
 * Precedence: explicit argument > `PIDECK_STAGE_DIR` > `release/win-unpacked`.
 * An empty/whitespace variable counts as unset so `PIDECK_STAGE_DIR=` cannot silently
 * downgrade to the shipping directory.
 */
export function resolvePackStage({ repoRoot = process.cwd(), outDir, env = process.env } = {}) {
	const root = resolve(repoRoot);
	const fromEnv = typeof env.PIDECK_STAGE_DIR === "string" ? env.PIDECK_STAGE_DIR.trim() : "";
	const requested = outDir ?? (fromEnv || DEFAULT_PACK_STAGE);
	// Relative values resolve against the repo root, matching xmake.lua's `path.join(os.projectdir(), …)`.
	const resolvedOut = resolve(root, requested);
	const requestedKind = String(env.PIDECK_SIDECAR_KIND ?? "").trim() || PACK_SIDECAR_KIND;
	return {
		repoRoot: root,
		outDir: resolvedOut,
		stageSource: outDir ? "argument" : fromEnv ? "PIDECK_STAGE_DIR" : "default",
		requestedSidecarKind: requestedKind,
		sidecarKind: normalizeSidecarKind(requestedKind),
	};
}

/**
 * Verify the selected stage. An unsupported kind fails closed before any filesystem
 * inspection, so a typo can never fall back to the other package definition.
 */
export async function verifyPackStage(options = {}) {
	const stage = resolvePackStage(options);
	if (!stage.sidecarKind) {
		return {
			...stage,
			ok: false,
			checked: [],
			errors: [`Unsupported sidecar kind "${stage.requestedSidecarKind.slice(0, 32)}": expected "cpp" or "node"`],
		};
	}
	const result = await verifyBuildArtifacts({
		repoRoot: stage.repoRoot,
		outDir: stage.outDir,
		sidecarKind: stage.sidecarKind,
	});
	return { ...stage, ...result };
}

function parseArgs(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--json") options.json = true;
		else if (arg === "--help") options.help = true;
		else if (arg === "--repo-root" || arg === "--out") {
			const value = argv[index + 1];
			if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
			options[arg === "--out" ? "outDir" : "repoRoot"] = value;
			index += 1;
		} else throw new Error(`Unknown argument: ${arg}`);
	}
	return options;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
	try {
		const options = parseArgs(process.argv.slice(2));
		if (options.help) {
			console.log(
				"Usage: node scripts/verify-pack-stage.mjs [--repo-root <path>] [--out <path>] [--json]\n"
				+ "  stage: PIDECK_STAGE_DIR (default release/win-unpacked)   kind: PIDECK_SIDECAR_KIND (default cpp)",
			);
		} else {
			const result = await verifyPackStage(options);
			if (options.json) console.log(JSON.stringify(result, null, 2));
			else if (result.ok) {
				console.log(`Build artifacts verified (${result.checked.length} files): ${result.outDir}`);
			} else {
				console.error(`Build artifact verification failed (${result.errors.length}):`);
				for (const error of result.errors) console.error(`- ${error}`);
			}
			if (!result.ok) process.exitCode = 1;
		}
	} catch (error) {
		console.error(`Build artifact verification failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
