#!/usr/bin/env node

import { access, readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_ENTRIES = {
	index: "renderer/index.html",
	// Web 服务入口：外部端（浏览器访问 http://host:port）加载的就是它。
	// 产物缺失时 WebServiceManager 会静默回退到 A1 旧内嵌页（功能可用但体验是旧版），
	// 因此必须纳入门禁，防止构建配置变更导致外部端悄悄变回旧页面。
	web: "renderer/web.html",
};

/**
 * PiDeck-Q-Change-Pi-Prompt 打包产物清单（运行时文件）。
 *
 * 这些文件由 pi 扩展加载器按相对路径 require，任何一个缺失/为空，打包版里
 * 该内置扩展在运行时就会崩溃（内置扩展默认开启，因此所有运行时文件必须完整随包发布）。
 * 注意：这里只列运行时文件；tests/ 是否随包走由源码侧
 * tests/extensionPackagingDeps.test.mjs 单独把关，不在此处强制。
 */
const CHANGE_PROMPT_FILES = [
	"extensions/pideck-q-change-pi-prompt.ts",
	"extensions/pideck-q-change-pi-prompt/runtime.ts",
	"extensions/pideck-q-change-pi-prompt/transform.ts",
	"extensions/pideck-q-change-pi-prompt/config.ts",
	"extensions/pideck-q-change-pi-prompt/defaults.ts",
	"extensions/pideck-q-change-pi-prompt/layout.ts",
	"extensions/pideck-q-change-pi-prompt/contributions.ts",
	"extensions/pideck-q-change-pi-prompt/shellAvailability.ts",
	"extensions/pideck-q-change-pi-prompt/shellProbe.ts",
	"extensions/pideck-q-change-pi-prompt/windowsShellDiscovery.ts",
	"extensions/pideck-q-change-pi-prompt/childShellPolicy.ts",
	"extensions/pideck-q-change-pi-prompt/childReconciliation.ts",
	"extensions/pideck-q-change-pi-prompt/subagentCatalog.ts",
	"extensions/pideck-q-change-pi-prompt/workflowValidation.ts",
];

const WEBFETCH_FILES = [
	"extensions/pideck-q-webfetch.ts",
	"extensions/pideck-q-webfetch/dist/index.mjs",
];

const WEBFETCH_ALLOWED_EXTERNALS = new Set([
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"@sinclair/typebox",
	"undici",
]);

async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function walkFiles(root) {
	if (!(await exists(root))) return [];
	const files = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) files.push(...await walkFiles(path));
		else if (entry.isFile()) files.push(path);
	}
	return files;
}

function isWithin(candidate, root) {
	const rel = relative(resolve(root), resolve(candidate));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function extractHtmlResourceReferences(html) {
	const references = [];
	const attribute = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
	for (const match of html.matchAll(attribute)) {
		const value = match[1].trim();
		if (!value || value.startsWith("#") || value.startsWith("data:") || value.startsWith("javascript:")) continue;
		if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("//")) continue;
		references.push(value);
	}
	return references;
}

function resolveRendererReference(rendererRoot, htmlPath, reference) {
	const clean = decodeURIComponent(reference.split(/[?#]/, 1)[0]);
	return clean.startsWith("/")
		? resolve(rendererRoot, `.${clean}`)
		: resolve(htmlPath, "..", clean);
}

async function latestMtime(paths) {
	let latest = 0;
	for (const path of paths) {
		if (!(await exists(path))) continue;
		const info = await stat(path);
		if (info.isFile()) {
			latest = Math.max(latest, info.mtimeMs);
			continue;
		}
		for (const file of await walkFiles(path)) latest = Math.max(latest, (await stat(file)).mtimeMs);
	}
	return latest;
}

export async function verifyBuildArtifacts({ repoRoot = process.cwd(), outDir } = {}) {
	const root = resolve(repoRoot);
	const output = resolve(outDir ?? join(root, "release", "win-unpacked"));
	const errors = [];
	const checked = [];
	if (!(await exists(output))) {
		return { ok: false, repoRoot: root, outDir: output, checked, errors: [`Build output directory is missing: ${output}`] };
	}
	// Resolve renderer resources in the package's app directory, or a synthetic test stage.
	const artifactRoot = await exists(join(output, "app", EXPECTED_ENTRIES.index))
		? join(output, "app")
		: output;
	const extensionUndiciPackage = join(output, "resources", "extensions", "node_modules", "undici", "package.json");
	const extensionAcornPackage = join(output, "resources", "extensions", "node_modules", "acorn", "package.json");
	const extensionAcornDist = join(output, "resources", "extensions", "node_modules", "acorn", "dist", "acorn.js");
	if (await exists(join(output, "resources", "extensions"))) {
		if (!(await exists(extensionUndiciPackage))) {
			errors.push(`Missing packaged extension dependency: ${extensionUndiciPackage}`);
		} else {
			checked.push(extensionUndiciPackage);
		}
		if (!(await exists(extensionAcornPackage))) {
			errors.push(`Missing packaged extension dependency: ${extensionAcornPackage}`);
		} else {
			checked.push(extensionAcornPackage);
		}
		if (!(await exists(extensionAcornDist))) {
			errors.push(`Missing packaged extension dependency: ${extensionAcornDist}`);
		} else {
			const acornDistInfo = await stat(extensionAcornDist);
			if (!acornDistInfo.isFile() || acornDistInfo.size === 0) {
				errors.push(`Empty or invalid acorn runtime file: ${extensionAcornDist}`);
			} else {
				checked.push(extensionAcornDist);
			}
		}
		// PiDeck-Q-Change-Pi-Prompt 的运行时文件必须完整落进产物；缺一个 = 启用即崩。
		for (const file of CHANGE_PROMPT_FILES) {
			const path = join(output, "resources", file);
			if (!(await exists(path))) {
				errors.push(`Missing packaged change-pi-prompt file: ${relative(root, path)}`);
				continue;
			}
			const info = await stat(path);
			if (!info.isFile() || info.size === 0) errors.push(`Empty or invalid change-pi-prompt file: ${relative(root, path)}`);
			else checked.push(path);
		}
		// PiDeck-Q-WebFetch 运行时文件必须完整落进产物，离线环境下必不可少
		for (const file of WEBFETCH_FILES) {
			const path = join(output, "resources", file);
			if (!(await exists(path))) {
				errors.push(`Missing packaged webfetch file: ${relative(root, path)}`);
				continue;
			}
			const info = await stat(path);
			if (!info.isFile() || info.size === 0) {
				errors.push(`Empty or invalid webfetch file: ${relative(root, path)}`);
				continue;
			}
			if (file.endsWith("dist/index.mjs")) {
				const content = await readFile(path, "utf8");
				const importMatches = [
					...content.matchAll(/^\s*(?:import|export)\s+(?:[\w*\s{},]*from\s+)?["']([^"']+)["']/gm),
				].map((m) => m[1]);
				for (const specifier of importMatches) {
					if (specifier.startsWith("node:")) continue;
					if (WEBFETCH_ALLOWED_EXTERNALS.has(specifier)) continue;
					errors.push(
						`Unbundled external import in packaged webfetch: ${specifier}. All normal npm dependencies must be bundled.`,
					);
				}
			}
			checked.push(path);
		}
	}
	const entryPaths = Object.fromEntries(
		Object.entries(EXPECTED_ENTRIES)
			.map(([name, path]) => [name, join(artifactRoot, path)]),
	);
	for (const [name, path] of Object.entries(entryPaths)) {
		if (!(await exists(path))) errors.push(`Missing ${name} entry: ${path}`);
		else {
			const info = await stat(path);
			if (!info.isFile() || info.size === 0) errors.push(`Empty or invalid ${name} entry: ${path}`);
			else checked.push(path);
		}
	}
	// Reused by the native artifact freshness groups: the backend binary
	// is the artifact whose build inputs live in `native/backend`.
	let cppBackendArtifact = "";
	const backendNames = process.platform === "win32"
		? ["PiDeckBackend.exe"]
		: ["PiDeckBackend"];
	let foundBackend = "";
	for (const name of backendNames) {
		const path = join(output, name);
		if (await exists(path)) {
			foundBackend = path;
			break;
		}
	}
	cppBackendArtifact = foundBackend;
	if (!foundBackend) errors.push(`Missing C++ sidecar executable in ${output}`);
	else {
		const info = await stat(foundBackend);
		if (!info.isFile() || info.size === 0) errors.push(`Empty C++ sidecar executable: ${foundBackend}`);
		else checked.push(foundBackend);
		// The sidecar imports Qt modules the host does not (Qt6Sql: OpenCode import,
		// prompt store, model specs). A stage that only deployed the host's Qt set starts
		// the window and then fails to load the backend with STATUS_DLL_NOT_FOUND, so the
		// package gate must prove every Qt DLL the sidecar imports is present.
		const binary = await readFile(foundBackend);
		const qtImports = new Set(binary.toString("latin1").match(/Qt6[A-Za-z0-9]+\.dll/g) ?? []);
		if (qtImports.size === 0) errors.push(`C++ sidecar has no inspectable Qt imports: ${foundBackend}`);
		for (const dll of qtImports) {
			const dllPath = join(output, dll);
			if (!(await exists(dllPath))) {
				errors.push(`C++ sidecar Qt dependency missing from package: ${dll}`);
				continue;
			}
			checked.push(dllPath);
		}
	}
	const bundledNode = (await walkFiles(output)).filter((file) => file.toLowerCase().endsWith("node.exe") || file.toLowerCase().endsWith("/node") || file.toLowerCase().endsWith("\\node"));
	if (bundledNode.length > 0) errors.push(`C++ package must not contain a Node runtime: ${bundledNode.join(", ")}`);

	// Plan §11.2 item 1: a C++ package carries no business Node at all - not the
	// bundled sidecar, not its npm runtime, not even the (empty) `node/` directory the
	// Node layout uses for node.exe. Only `resources/extensions/node_modules` stays,
	// because pi loads the built-in TS extensions with its own runtime.
	const businessNodeLeftovers = [];
	for (const leftover of ["app/native-node", "app/node_modules", "node"]) {
		if (await exists(join(output, leftover))) businessNodeLeftovers.push(leftover);
	}
	if (businessNodeLeftovers.length > 0) {
		errors.push(`C++ package must not contain business Node leftovers: ${businessNodeLeftovers.join(", ")}`);
	}

	const rendererRoot = join(artifactRoot, "renderer");
	const resourcePaths = new Set();
	for (const htmlPath of [entryPaths.index, entryPaths.web]) {
		if (!(await exists(htmlPath))) continue;
		const html = await readFile(htmlPath, "utf8");
		for (const reference of extractHtmlResourceReferences(html)) {
			let resourcePath;
			try {
				resourcePath = resolveRendererReference(rendererRoot, htmlPath, reference);
			} catch (error) {
				errors.push(`Malformed HTML resource path: ${reference} (${htmlPath}): ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			if (!isWithin(resourcePath, rendererRoot)) {
				errors.push(`HTML resource escapes renderer output: ${reference} (${htmlPath})`);
				continue;
			}
			try {
				const info = await stat(resourcePath);
				if (!info.isFile() || info.size === 0) {
					errors.push(`Empty or invalid HTML resource: ${reference} (${htmlPath})`);
					continue;
				}
				resourcePaths.add(resourcePath);
				checked.push(resourcePath);
			} catch {
				errors.push(`Missing HTML resource: ${reference} (${htmlPath})`);
			}
		}
	}

	// Inputs of the TypeScript bundles. `xmake.lua` is deliberately absent here: it only
	// defines the native targets, so treating a native build-definition edit as a renderer /
	// Sidecar input reported "stale renderer" for a bundle whose content was current.
	const commonInputs = [join(root, "vite.config.ts"), join(root, "package.json")];
	// A C++ package publishes two native binaries whose sources live outside the renderer
	// tree (`native/backend/**` builds PiDeckBackend.exe, `native/src/**` + the target
	// definition build PiDeck-Q.exe). Without freshness groups for them a stage whose
	// binaries predated their own sources still passed because "the exe exists" - exactly
	// the blind spot that let an old stage satisfy the packaged gate. `xmake.lua` is the
	// build definition of both targets (kind default, defines, source lists) and the host
	// embeds the package version, so those files are inputs for the matching artifact only.
	// A package that does not ship the host binary (a plain `out/` dev tree) simply has no
	// artifact for the host group and is not judged by it.
	const cppHostNames = process.platform === "win32" ? ["PiDeck-Q.exe"] : ["PiDeck-Q"];
	const cppHostArtifacts = [];
	for (const name of cppHostNames) {
		for (const base of [output, join(output, "app")]) {
			const candidate = join(base, name);
			if (await exists(candidate)) cppHostArtifacts.push(candidate);
		}
	}
	const freshnessGroups = [
		{
			name: "cpp-backend",
			inputs: [join(root, "native", "backend"), join(root, "xmake.lua")],
			artifacts: cppBackendArtifact ? [cppBackendArtifact] : [],
		},
		{
			name: "cpp-host",
			inputs: [join(root, "native", "src"), join(root, "native", "PiDeck-Q.rc"), join(root, "xmake.lua"), join(root, "package.json")],
			artifacts: cppHostArtifacts,
		},
		{
			name: "renderer",
			inputs: [join(root, "src", "renderer"), ...commonInputs],
			artifacts: [entryPaths.index, entryPaths.web, ...resourcePaths],
		},
	];
	for (const group of freshnessGroups) {
		const inputMtime = await latestMtime(group.inputs);
		if (inputMtime === 0) continue;
		for (const artifact of new Set(group.artifacts)) {
			if (!(await exists(artifact))) continue;
			const artifactMtime = (await stat(artifact)).mtimeMs;
			if (artifactMtime + 1_000 < inputMtime) {
				errors.push(`Stale ${group.name} artifact: ${artifact}`);
			}
		}
	}

	return { ok: errors.length === 0, repoRoot: root, outDir: output, checked: [...new Set(checked)], errors };
}

function parseArgs(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--json") options.json = true;
		else if (arg === "--repo-root" || arg === "--out") {
			const value = argv[index + 1];
			if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
			options[arg === "--out" ? "outDir" : "repoRoot"] = value;
			index += 1;
		} else if (arg === "--help") options.help = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return options;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
	try {
		const options = parseArgs(process.argv.slice(2));
		if (options.help) {
			console.log("Usage: node scripts/verify-build-artifacts.mjs [--repo-root <path>] [--out <path>] [--json]");
		} else {
			const result = await verifyBuildArtifacts(options);
			if (options.json) console.log(JSON.stringify(result, null, 2));
			else if (result.ok) console.log(`Build artifacts verified (${result.checked.length} files): ${result.outDir}`);
			else {
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
