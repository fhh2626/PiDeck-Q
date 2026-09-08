import { access, copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Native sidecar runtime files that are loaded by node-pty on Windows.
 * Build products such as PDB/OBJ files and the source tree are deliberately
 * excluded because they are not consulted by node-pty at runtime.
 */
export const NODE_PTY_RUNTIME_FILES = Object.freeze([
	"build/Release/conpty_console_list.node",
	"build/Release/conpty.node",
	"build/Release/pty.node",
	"build/Release/winpty-agent.exe",
	"build/Release/winpty.dll",
	"build/Release/conpty/conpty.dll",
	"build/Release/conpty/OpenConsole.exe",
]);

/** sql.js uses the default WASM build and locates exactly this sibling WASM file. */
export const SQL_JS_RUNTIME_FILES = Object.freeze([
	"package.json",
	"dist/sql-wasm.js",
	"dist/sql-wasm.wasm",
]);

/**
 * Copy only JavaScript implementation files from a dependency library. Source
 * maps and test modules are useful while developing but are not runtime input.
 */
async function copyJavaScriptTree(sourceRoot, destinationRoot) {
	let copied = 0;
	const entries = await readdir(sourceRoot, { withFileTypes: true });
	for (const entry of entries) {
		const sourcePath = join(sourceRoot, entry.name);
		const destinationPath = join(destinationRoot, entry.name);
		if (entry.isDirectory()) {
			copied += await copyJavaScriptTree(sourcePath, destinationPath);
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".js") || entry.name.endsWith(".test.js")) continue;
		await mkdir(dirname(destinationPath), { recursive: true });
		await copyFile(sourcePath, destinationPath);
		copied += 1;
	}
	return copied;
}

async function copyFiles(sourceRoot, destinationRoot, files, label) {
	for (const file of files) {
		const sourcePath = join(sourceRoot, file);
		try {
			await access(sourcePath);
		} catch {
			throw new Error(`Missing ${label} runtime file: ${sourcePath}`);
		}
		const destinationPath = join(destinationRoot, file);
		await mkdir(dirname(destinationPath), { recursive: true });
		await copyFile(sourcePath, destinationPath);
	}
	return files.length;
}

async function resetDirectory(directory) {
	await rm(directory, { recursive: true, force: true });
	await mkdir(directory, { recursive: true });
}

async function stageNodePty(projectRoot, stageRoot) {
	const sourceRoot = join(projectRoot, "node_modules", "node-pty");
	const destinationRoot = join(stageRoot, "app", "node_modules", "node-pty");
	await resetDirectory(destinationRoot);
	let copied = await copyFiles(sourceRoot, destinationRoot, ["package.json"], "node-pty");
	copied += await copyJavaScriptTree(join(sourceRoot, "lib"), join(destinationRoot, "lib"));
	copied += await copyFiles(sourceRoot, destinationRoot, NODE_PTY_RUNTIME_FILES, "node-pty");
	return copied;
}

async function stageSqlJs(projectRoot, stageRoot) {
	const sourceRoot = join(projectRoot, "node_modules", "sql.js");
	const destinationRoot = join(stageRoot, "app", "node_modules", "sql.js");
	await resetDirectory(destinationRoot);
	return copyFiles(sourceRoot, destinationRoot, SQL_JS_RUNTIME_FILES, "sql.js");
}

async function stageUndiciAt(projectRoot, destinationRoot) {
	const sourceRoot = join(projectRoot, "node_modules", "undici");
	await resetDirectory(destinationRoot);
	let copied = await copyFiles(sourceRoot, destinationRoot, ["package.json", "index.js"], "undici");
	copied += await copyJavaScriptTree(join(sourceRoot, "lib"), join(destinationRoot, "lib"));
	return copied;
}

/**
 * Stage only runtime files for the Node sidecar and built-in extensions.
 * Keeping this boundary explicit prevents a local npm build directory from
 * silently becoming part of the portable release.
 */
export async function stageNativeRuntime({ projectRoot = process.cwd(), stageRoot } = {}) {
	const root = resolve(projectRoot);
	const output = resolve(stageRoot ?? join(root, "release", "win-unpacked"));
	const counts = {
		nodePty: await stageNodePty(root, output),
		sqlJs: await stageSqlJs(root, output),
		undici: await stageUndiciAt(root, join(output, "app", "node_modules", "undici")),
		extensionUndici: await stageUndiciAt(
			root,
			join(output, "resources", "extensions", "node_modules", "undici"),
		),
	};
	return { projectRoot: root, stageRoot: output, counts };
}

function parseArgs(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--project-root" || arg === "--stage-root") {
			const value = argv[index + 1];
			if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
			options[arg === "--project-root" ? "projectRoot" : "stageRoot"] = value;
			index += 1;
		} else if (arg === "--help") {
			options.help = true;
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return options;
}

const isMain = process.argv[1]
	&& resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
	try {
		const options = parseArgs(process.argv.slice(2));
		if (options.help) {
			console.log("Usage: node scripts/stage-native-runtime.mjs [--project-root <path>] [--stage-root <path>]");
		} else {
			const result = await stageNativeRuntime(options);
			const total = Object.values(result.counts).reduce((sum, count) => sum + count, 0);
			console.log(`Staged native runtime allowlist (${total} files): ${result.stageRoot}`);
		}
	} catch (error) {
		console.error(`Native runtime staging failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
