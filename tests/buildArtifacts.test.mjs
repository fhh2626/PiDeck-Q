import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	extractHtmlResourceReferences,
	verifyBuildArtifacts as verifyArtifacts,
} from "../scripts/verify-build-artifacts.mjs";

// Fixtures use an explicit isolated stage, independent of the shipping default.
function verifyBuildArtifacts(options) {
  return verifyArtifacts({ ...options, outDir: join(options.repoRoot, "out") });
}

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
		join(repo, "native", "backend", "backend.cpp"),
		join(repo, "src", "renderer", "src", "main.tsx"),
		join(repo, "vite.config.ts"),
		join(repo, "package.json"),
	];
	for (const source of sourceFiles) await put(source, "source");
	const artifactFiles = [
		join(repo, "out", process.platform === "win32" ? "PiDeckBackend.exe" : "PiDeckBackend"),
		join(repo, "out", "renderer", "assets", "app.js"),
		join(repo, "out", "renderer", "assets", "web.js"),
		join(repo, "out", "renderer", "assets", "style.css"),
	];
	for (const artifact of artifactFiles) await put(artifact, "artifact");
	await put(artifactFiles[0], "MZfixture\0Qt6Core.dll\0");
	await put(join(repo, "out", "Qt6Core.dll"), "MZfixture");
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
		assert.match(result.errors.join("\n"), /Missing C\+\+ sidecar/);
		assert.match(result.errors.join("\n"), /renderer[/\\]index\.html/);
		assert.match(result.errors.join("\n"), /renderer[/\\]web\.html/);
	});
});

test("a complete temporary build fixture passes entry, resource, and freshness checks", async () => {
	await withTempRepo(async (repo) => {
		await createBuildFixture(repo);
		const result = await verifyBuildArtifacts({ repoRoot: repo });
		assert.equal(result.ok, true, result.errors.join("\n"));
		assert.equal(result.checked.length, 7);
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
		assert.match(result.errors.join("\n"), /Stale cpp-backend artifact/);
		assert.match(result.errors.join("\n"), /Stale renderer artifact/);
	});
});

// ---- change-pi-prompt 打包门禁（Phase 6）----
//
// 内置扩展默认关闭，所以「缺文件」在源码侧测不出——只有启用后 pi 加载时才发现。
// 这道门禁在产物上把缺文件/空文件提前到发版前暴露。

async function putChangePromptFiles(repo, { withUndici = true, withAcorn = true, withWebfetch = true } = {}) {
	const base = join(repo, "out", "resources", "extensions");
	if (withUndici) {
		await put(join(base, "node_modules", "undici", "package.json"), "{}");
	}
	if (withAcorn) {
		await put(join(base, "node_modules", "acorn", "package.json"), "{}");
		await put(join(base, "node_modules", "acorn", "dist", "acorn.js"), "// acorn");
	}
	if (withWebfetch) {
		await put(join(base, "pideck-q-webfetch.ts"), "// webfetch");
		await put(join(base, "pideck-q-webfetch", "dist", "index.mjs"), "// webfetch dist");
	}
	for (const file of [
		"pideck-q-change-pi-prompt.ts",
	"pideck-q-change-pi-prompt/runtime.ts",
	"pideck-q-change-pi-prompt/transform.ts",
	"pideck-q-change-pi-prompt/config.ts",
	"pideck-q-change-pi-prompt/defaults.ts",
	"pideck-q-change-pi-prompt/layout.ts",
	"pideck-q-change-pi-prompt/contributions.ts",
	"pideck-q-change-pi-prompt/activeToolLines.ts",

	"pideck-q-subagents/src/policy/environment/runtime.ts",
	"pideck-q-subagents/src/policy/environment/hostEnvironment.ts",
	"pideck-q-subagents/src/policy/environment/childRuntime.ts",
	"pideck-q-subagents/src/policy/environment/childPrompt.ts",
	"pideck-q-subagents/src/policy/environment/toolMetadata.ts",
	"pideck-q-subagents/src/policy/environment/childReconciliation.ts",
	"pideck-q-subagents/src/policy/environment/policySnapshot.ts",
	"pideck-q-subagents/src/policy/environment/policyStorage.ts",
	"pideck-q-subagents/src/policy/environment/childShellPolicy.ts",
	"pideck-q-subagents/src/policy/environment/subagentCatalog.ts",
	"pideck-q-subagents/src/policy/environment/shellAvailability.ts",
	"pideck-q-subagents/src/policy/environment/shellProbe.ts",
	"pideck-q-subagents/src/policy/environment/windowsShellDiscovery.ts",
	"pideck-q-subagents/src/policy/environment/copy.ts",
	"pideck-q-subagents/src/shared/prompt-sections.ts",
	"pideck-q-subagents/src/runs/shared/child-loader-identity.ts",
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
		// Native backend, Qt dependency, renderer entries/assets and extension runtime files.
		assert.equal(result.checked.length, 36, JSON.stringify(result.checked));
	});
});

test("missing subagent environment runtime dependencies fail verification", async () => {
	await withTempRepo(async (repo) => {
		await createBuildFixture(repo);
		await putChangePromptFiles(repo);
		await rm(join(repo, "out", "resources", "extensions", "pideck-q-subagents", "src", "policy", "environment", "runtime.ts"));
		const result = await verifyBuildArtifacts({ repoRoot: repo });
		assert.equal(result.ok, false);
		assert.match(result.errors.join("\n"), /environment.*runtime\.ts/);
	});

	await withTempRepo(async (repo) => {
		await createBuildFixture(repo);
		await putChangePromptFiles(repo);
		await rm(join(repo, "out", "resources", "extensions", "pideck-q-subagents", "src", "policy", "environment", "subagentCatalog.ts"));
		const result = await verifyBuildArtifacts({ repoRoot: repo });
		assert.equal(result.ok, false);
		assert.match(result.errors.join("\n"), /subagentCatalog\.ts/);
	});

	await withTempRepo(async (repo) => {
		await createBuildFixture(repo);
		await putChangePromptFiles(repo);
		await rm(join(repo, "out", "resources", "extensions", "pideck-q-subagents", "src", "policy", "environment", "shellProbe.ts"));
		const result = await verifyBuildArtifacts({ repoRoot: repo });
		assert.equal(result.ok, false);
		assert.match(result.errors.join("\n"), /shellProbe\.ts/);
	});

	await withTempRepo(async (repo) => {
		await createBuildFixture(repo);
		await putChangePromptFiles(repo);
		await rm(join(repo, "out", "resources", "extensions", "pideck-q-subagents", "src", "policy", "environment", "windowsShellDiscovery.ts"));
		const result = await verifyBuildArtifacts({ repoRoot: repo });
		assert.equal(result.ok, false);
		assert.match(result.errors.join("\n"), /windowsShellDiscovery\.ts/);
	});
});

test("missing or empty acorn dist/acorn.js fails verification", async () => {
	await withTempRepo(async (repo) => {
		await createBuildFixture(repo);
		await putChangePromptFiles(repo);
		await rm(join(repo, "out", "resources", "extensions", "node_modules", "acorn", "dist", "acorn.js"));
		const result = await verifyBuildArtifacts({ repoRoot: repo });
		assert.equal(result.ok, false);
		assert.match(result.errors.join("\n"), /Missing packaged extension dependency.*dist.*acorn\.js/);
	});

	await withTempRepo(async (repo) => {
		await createBuildFixture(repo);
		await putChangePromptFiles(repo);
		await put(join(repo, "out", "resources", "extensions", "node_modules", "acorn", "dist", "acorn.js"), "");
		const result = await verifyBuildArtifacts({ repoRoot: repo });
		assert.equal(result.ok, false);
		assert.match(result.errors.join("\n"), /Empty or invalid acorn runtime file.*dist.*acorn\.js/);
	});
});

test("an empty change-pi-prompt runtime file fails verification", async () => {
	await withTempRepo(async (repo) => {
		await createBuildFixture(repo);
		await putChangePromptFiles(repo);
		// 把 runtime.ts 打成 0 字节：应当报 Empty or invalid
		await put(join(repo, "out", "resources", "extensions", "pideck-q-change-pi-prompt", "runtime.ts"), "");
		const result = await verifyBuildArtifacts({ repoRoot: repo });
		assert.equal(result.ok, false);
		assert.match(result.errors.join("\n"), /Empty or invalid change-pi-prompt file.*runtime\.ts/);
	});
});

test("missing or empty webfetch runtime file fails verification", async () => {
	await withTempRepo(async (repo) => {
		await createBuildFixture(repo);
		await putChangePromptFiles(repo, { withWebfetch: false });
		const result = await verifyBuildArtifacts({ repoRoot: repo });
		assert.equal(result.ok, false);
		assert.match(result.errors.join("\n"), /Missing packaged webfetch file.*pideck-q-webfetch\.ts/);
	});

	await withTempRepo(async (repo) => {
		await createBuildFixture(repo);
		await putChangePromptFiles(repo);
		await put(join(repo, "out", "resources", "extensions", "pideck-q-webfetch", "dist", "index.mjs"), "");
		const result = await verifyBuildArtifacts({ repoRoot: repo });
		assert.equal(result.ok, false);
		assert.match(result.errors.join("\n"), /Empty or invalid webfetch file.*dist.*index\.mjs/);
	});

	await withTempRepo(async (repo) => {
		await createBuildFixture(repo);
		await putChangePromptFiles(repo);
		// 模拟泄露的未打包依赖（例如有 bare import linkedom）
		await put(
			join(repo, "out", "resources", "extensions", "pideck-q-webfetch", "dist", "index.mjs"),
			'import { parseHTML } from "linkedom";\nexport default function() {}',
		);
		const result = await verifyBuildArtifacts({ repoRoot: repo });
		assert.equal(result.ok, false);
		assert.match(result.errors.join("\n"), /Unbundled external import in packaged webfetch: linkedom/);
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
