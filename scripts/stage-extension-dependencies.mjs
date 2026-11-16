import { access, copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

async function stageUndiciAt(projectRoot, destinationRoot) {
	const sourceRoot = join(projectRoot, "node_modules", "undici");
	await resetDirectory(destinationRoot);
	let copied = await copyFiles(sourceRoot, destinationRoot, ["package.json", "index.js"], "undici");
	copied += await copyJavaScriptTree(join(sourceRoot, "lib"), join(destinationRoot, "lib"));
	return copied;
}

async function stageAcornAt(projectRoot, destinationRoot) {
	const sourceRoot = join(projectRoot, "node_modules", "acorn");
	await resetDirectory(destinationRoot);
	let copied = await copyFiles(sourceRoot, destinationRoot, ["package.json"], "acorn");
	copied += await copyJavaScriptTree(join(sourceRoot, "dist"), join(destinationRoot, "dist"));
	return copied;
}

/** Stage only the libraries resolved externally by built-in Agent extensions. */
export async function stageExtensionDependencies({ projectRoot = process.cwd(), stageRoot } = {}) {
  const root = resolve(projectRoot);
  const output = resolve(stageRoot ?? join(root, "release", "win-unpacked"));
  const dependencies = join(output, "resources", "extensions", "node_modules");
  const counts = {
    extensionUndici: await stageUndiciAt(root, join(dependencies, "undici")),
    extensionAcorn: await stageAcornAt(root, join(dependencies, "acorn")),
  };
  return { projectRoot: root, stageRoot: output, counts };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--project-root" || arg === "--stage-root") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      options[arg === "--project-root" ? "projectRoot" : "stageRoot"] = value;
    } else if (arg === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log("Usage: node scripts/stage-extension-dependencies.mjs [--project-root <path>] [--stage-root <path>]");
    else {
      const result = await stageExtensionDependencies(options);
      const total = Object.values(result.counts).reduce((sum, count) => sum + count, 0);
      console.log(`Staged extension dependencies (${total} files): ${result.stageRoot}`);
    }
  } catch (error) {
    console.error(`Extension staging failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
