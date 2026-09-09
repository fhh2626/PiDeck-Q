import { build } from "esbuild";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 普通 WebFetch npm dependencies 必须 bundle，
// 避免 packaged extension 依赖仓库根 node_modules。

const ALLOWED_EXTERNALS = new Set([
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"@sinclair/typebox",
]);

const inlinedDependenciesPlugin = {
	name: "inlined-dependencies",
	setup(build) {
		// linkedom 依赖的 uhyphen 微工具（单行代码，直接内联）
		build.onResolve({ filter: /^uhyphen$/ }, () => ({
			path: "uhyphen",
			namespace: "inlined-dep",
		}));
		build.onLoad({ filter: /^uhyphen$/, namespace: "inlined-dep" }, () => ({
			contents: "export default camel => camel.replace(/(([A-Z0-9])([A-Z0-9][a-z]))|(([a-z0-9]+)([A-Z]))/g, '$2$5-$3$6').toLowerCase();",
			loader: "js",
		}));

		// turndown 的可选无 DOM 环境兜底 domino（webfetch 始终通过 linkedom 解析 DOM，不会调用此模块）
		build.onResolve({ filter: /^@mixmark-io\/domino$/ }, () => ({
			path: "@mixmark-io/domino",
			namespace: "inlined-dep",
		}));
		build.onLoad({ filter: /^@mixmark-io\/domino$/, namespace: "inlined-dep" }, () => ({
			contents: "module.exports = { createDocument() { throw new Error('domino is not available; webfetch uses linkedom'); } };",
			loader: "js",
		}));
	},
};

export async function bundleWebfetch({ projectRoot = process.cwd() } = {}) {
	const root = resolve(projectRoot);
	const pkgDir = join(root, "resources", "extensions", "pideck-q-webfetch");
	const srcPath = join(pkgDir, "src", "index.mjs");
	const distPath = join(pkgDir, "dist", "index.mjs");

	// 若尚未归档源码 src/index.mjs，先以当前 dist 作为源文件镜像
	if (!existsSync(srcPath)) {
		await mkdir(dirname(srcPath), { recursive: true });
		await copyFile(distPath, srcPath);
	}

	const result = await build({
		entryPoints: [srcPath],
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node20",
		write: false,
		external: [...ALLOWED_EXTERNALS],
		mainFields: ["module", "main"],
		plugins: [inlinedDependenciesPlugin],
	});

	if (!result.outputFiles || result.outputFiles.length === 0) {
		throw new Error("esbuild bundling produced no output files");
	}

	const bundledCode = result.outputFiles[0].text;

	// 提取顶层 import / export from 模块说明符
	const importMatches = [
		...bundledCode.matchAll(/^\s*(?:import|export)\s+(?:[\w*\s{},]*from\s+)?["']([^"']+)["']/gm),
	].map((m) => m[1]);

	for (const specifier of importMatches) {
		if (specifier.startsWith("node:")) continue;
		if (ALLOWED_EXTERNALS.has(specifier)) continue;
		throw new Error(
			`Disallowed external import found in bundled webfetch: ${specifier}. All regular npm dependencies must be bundled.`,
		);
	}

	await mkdir(dirname(distPath), { recursive: true });
	await writeFile(distPath, bundledCode, "utf8");

	return {
		distPath,
		size: bundledCode.length,
		externals: [...new Set(importMatches)],
	};
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
	try {
		const res = await bundleWebfetch();
		console.log(`Bundled WebFetch successfully (${res.size} bytes). Externals:`, res.externals);
	} catch (error) {
		console.error("Bundle failed:", error);
		process.exitCode = 1;
	}
}
