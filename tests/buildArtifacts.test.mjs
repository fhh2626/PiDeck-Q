import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	extractHtmlResourceReferences,
	verifyBuildArtifacts,
} from "../scripts/verify-build-artifacts.mjs";

async function withTempRepo(run) {
	const repo = await mkdtemp(join(tmpdir(), "pideck-artifacts-test-"));
	try {
		return await run(repo);
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
}

async function put(path, content = "content") {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content, "utf8");
}

async function createBuildFixture(repo) {
	const sourceFiles = [
		join(repo, "src", "main", "backend.ts"),
		join(repo, "src", "native-node", "index.ts"),
		join(repo, "src", "renderer", "src", "main.tsx"),
		join(repo, "vite.config.ts"),
		join(repo, "package.json"),
	];
	for (const source of sourceFiles) await put(source, "source");
	const artifactFiles = [
		join(repo, "out", "native-node", "index.cjs"),
		join(repo, "out", "renderer", "assets", "app.js"),
		join(repo, "out", "renderer", "assets", "web.js"),
		join(repo, "out", "renderer", "assets", "style.css"),
	];
	for (const artifact of artifactFiles) await put(artifact, "artifact");
	const indexHtml = join(repo, "out", "renderer", "index.html");
	const webHtml = join(repo, "out", "renderer", "web.html");
	await put(indexHtml, '<link href="/assets/style.css" rel="stylesheet"><script src="/assets/app.js"></script>');
	await put(webHtml, '<script type="module" src="./assets/web.js?hash=1"></script>');
	artifactFiles.push(indexHtml, webHtml);
	const sourceTime = new Date("2026-01-01T00:00:00Z");
	const artifactTime = new Date("2026-01-01T00:01:00Z");
	await Promise.all(sourceFiles.map((path) => utimes(path, sourceTime, sourceTime)));
	await Promise.all(artifactFiles.map((path) => utimes(path, artifactTime, artifactTime)));
	return { sourceFiles, artifactFiles, indexHtml, webHtml };
}

test("an empty build output fails with all required native entry points", async () => {
	await withTempRepo(async (repo) => {
		await mkdir(join(repo, "out"));
		const result = await verifyBuildArtifacts({ repoRoot: repo });
		assert.equal(result.ok, false);
		assert.equal(result.errors.length, 3);
		assert.match(result.errors.join("\n"), /native-node[/\\]index\.cjs/);
		assert.match(result.errors.join("\n"), /renderer[/\\]index\.html/);
		assert.match(result.errors.join("\n"), /renderer[/\\]web\.html/);
	});
});

test("a complete temporary build fixture passes entry, resource, and freshness checks", async () => {
	await withTempRepo(async (repo) => {
		await createBuildFixture(repo);
		const result = await verifyBuildArtifacts({ repoRoot: repo });
		assert.equal(result.ok, true, result.errors.join("\n"));
		assert.equal(result.checked.length, 6);
	});
});

test("missing and escaping HTML resource references fail verification", async () => {
	await withTempRepo(async (repo) => {
		const fixture = await createBuildFixture(repo);
		await put(fixture.indexHtml, '<script src="/assets/missing.js"></script><link href="../../outside.css">');
		const result = await verifyBuildArtifacts({ repoRoot: repo });
		assert.equal(result.ok, false);
		assert.match(result.errors.join("\n"), /Missing HTML resource/);
		assert.match(result.errors.join("\n"), /escapes renderer output/);
	});
});

test("malformed encoded references and non-regular or empty resources fail verification", async () => {
	await withTempRepo(async (repo) => {
		const fixture = await createBuildFixture(repo);
		await mkdir(join(repo, "out", "renderer", "assets", "directory"), { recursive: true });
		await put(join(repo, "out", "renderer", "assets", "empty.js"), "");
		await put(fixture.indexHtml, '<script src="/assets/%ZZ.js"></script><script src="/assets/empty.js"></script><link href="/assets/directory">');
		const result = await verifyBuildArtifacts({ repoRoot: repo });
		assert.equal(result.ok, false);
		assert.match(result.errors.join("\\n"), /Malformed HTML resource path/);
		assert.match(result.errors.join("\\n"), /Empty or invalid HTML resource/);
	});
});

test("artifacts older than relevant source inputs are reported as stale", async () => {
	await withTempRepo(async (repo) => {
		const fixture = await createBuildFixture(repo);
		const staleTime = new Date("2025-12-01T00:00:00Z");
		await Promise.all(fixture.artifactFiles.map((path) => utimes(path, staleTime, staleTime)));
		const result = await verifyBuildArtifacts({ repoRoot: repo });
		assert.equal(result.ok, false);
		assert.match(result.errors.join("\n"), /Stale native-node artifact/);
		assert.match(result.errors.join("\n"), /Stale renderer artifact/);
	});
});

// ---- change-pi-prompt 打包门禁（Phase 6）----
//
// 内置扩展默认关闭，所以「缺文件」在源码侧测不出——只有启用后 pi 加载时才发现。
// 这道门禁在产物上把缺文件/空文件提前到发版前暴露。

async function putChangePromptFiles(repo, { withUndici = true } = {}) {
	const base = join(repo, "out", "resources", "extensions");
	if (withUndici) {
		await put(join(base, "node_modules", "undici", "package.json"), "{}");
	}
	for (const file of [
		"pideck-q-change-pi-prompt.ts",
		"pideck-q-change-pi-prompt/runtime.ts",
		"pideck-q-change-pi-prompt/transform.ts",
		"pideck-q-change-pi-prompt/config.ts",
		"pideck-q-change-pi-prompt/defaults.ts",
		"pideck-q-change-pi-prompt/layout.ts",
		"pideck-q-change-pi-prompt/contributions.ts",
	]) {
		await put(join(base, file), "// packaged");
	}
}

test("a build with resources/extensions but no change-pi-prompt files fails", async () => {
	await withTempRepo(async (repo) => {
		await createBuildFixture(repo);
		// 只造 undici，不造扩展文件：应当被本门禁抓到
		await put(join(repo, "out", "resources", "extensions", "node_modules", "undici", "package.json"), "{}");
		const result = await verifyBuildArtifacts({ repoRoot: repo });
		assert.equal(result.ok, false, result.errors.join("\n"));
		assert.match(result.errors.join("\n"), /change-pi-prompt/);
		assert.match(result.errors.join("\n"), /pideck-q-change-pi-prompt\.ts/);
		assert.match(result.errors.join("\n"), /runtime\.ts/);
	});
});

test("a build with the full change-pi-prompt runtime set passes", async () => {
	await withTempRepo(async (repo) => {
		await createBuildFixture(repo);
		await putChangePromptFiles(repo);
		const result = await verifyBuildArtifacts({ repoRoot: repo });
		assert.equal(result.ok, true, result.errors.join("\n"));
		// 7 个扩展文件 + 3 个入口 + 3 个 HTML 资源 + 1 个 undici = 14
		assert.equal(result.checked.length, 14, JSON.stringify(result.checked));
	});
});

test("an empty change-pi-prompt runtime file fails verification", async () => {
	await withTempRepo(async (repo) => {
		await createBuildFixture(repo);
		await putChangePromptFiles(repo);
		// 把 runtime.ts 打成 0 字节：应当报 Empty or invalid
		await put(join(repo, "out", "resources", "extensions", "pideck-q-change-pi-prompt", "runtime.ts"), "");
		const result = await verifyBuildArtifacts({ repoRoot: repo });
		assert.equal(result.ok, false, result.errors.join("\n"));
		assert.match(result.errors.join("\n"), /Empty or invalid change-pi-prompt file.*runtime\.ts/);
	});
});

test("HTML reference extraction ignores remote, data, and fragment URLs", () => {
	assert.deepEqual(extractHtmlResourceReferences(`
		<script src="/assets/app.js"></script>
		<link href="https://example.test/style.css">
		<img src="data:image/png;base64,abc">
		<a href="#section">section</a>
	`), ["/assets/app.js"]);
});
