#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBuildArtifacts } from "./verify-build-artifacts.mjs";

/** `npm run pack` and the artifact gate validate the same native staging directory. */
export const DEFAULT_PACK_STAGE = "release/win-unpacked";

/**
 * Resolve the native stage directory for a packaging run.
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
	return {
		repoRoot: root,
		outDir: resolvedOut,
		stageSource: outDir ? "argument" : fromEnv ? "PIDECK_STAGE_DIR" : "default",
	};
}

/** Verify the selected native package without a legacy backend mode. */
export async function verifyPackStage(options = {}) {
	const stage = resolvePackStage(options);
	const result = await verifyBuildArtifacts({ repoRoot: stage.repoRoot, outDir: stage.outDir });
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
				+ "  stage: PIDECK_STAGE_DIR (default release/win-unpacked)",
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
