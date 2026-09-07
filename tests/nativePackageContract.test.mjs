import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8"));

test("native package exposes a complete reproducible build chain", () => {
	assert.match(packageJson.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
	assert.equal(packageLock.packages[""].version, packageJson.version);
	for (const script of ["build:renderer", "build:node", "build:native", "test", "typecheck", "dist:win"]) {
		assert.equal(typeof packageJson.scripts?.[script], "string", `missing npm script: ${script}`);
	}
	assert.equal(packageJson.main, undefined);
	const packageNames = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies });
	assert.deepEqual(packageNames.filter((name) => name.includes("electron")), []);
	assert.equal(packageJson.devDependencies.esbuild, "^0.25.12");
	assert.equal(packageLock.packages["node_modules/esbuild"]?.version, "0.25.12");

	assert.match(packageJson.scripts?.["build:native"] ?? "", /build-native\.mjs/);

	const scriptsRoot = "scripts";
	const scriptFiles = readdirSync(scriptsRoot, { withFileTypes: true })
		.filter((entry) => entry.isFile() && /\.(mjs|js|ts)$/.test(entry.name))
		.map((entry) => join(scriptsRoot, entry.name));
	for (const scriptPath of scriptFiles) {
		const source = readFileSync(scriptPath, "utf8");
		for (const match of source.matchAll(/^\s*import\s+[^\n]*?\sfrom\s+["']([^"']+)["']/gm)) {
			const imported = match[1];
			if (imported.startsWith("node:") || imported.startsWith(".") || imported.startsWith("/")) continue;
			const packageName = imported.startsWith("@") ? imported.split("/").slice(0, 2).join("/") : imported.split("/")[0];
			assert.ok(packageNames.includes(packageName), `${scriptPath} imports undeclared package ${packageName}`);
		}
	}
});

test("updates and package metadata use the canonical PiDeck-Q repository", () => {
	const identity = readFileSync("src/shared/appIdentity.ts", "utf8");
	const update = readFileSync("src/main/update/AppUpdateService.ts", "utf8");
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	const windowsWorkflow = readFileSync(".github/workflows/release.yml", "utf8");
	assert.match(identity, /fhh2626\/PiDeck-Q/);
	assert.match(update, /APP_LATEST_RELEASE_API/);
	assert.match(update, /knownAssets/);
	assert.match(update, /portableCandidates/);
	assert.doesNotMatch(update, /PORTABLE_EXECUTABLE_DIR/);
	assert.equal(pkg.repository.url, "git+https://github.com/fhh2626/PiDeck-Q.git");
	assert.match(windowsWorkflow, /repository: fhh2626\/PiDeck-Q/);
	assert.match(windowsWorkflow, /Compress-Archive/);
	assert.match(windowsWorkflow, /PiDeck-Q-\$\{\{ needs\.resolve-version\.outputs\.version \}\}-win-x64\.zip/);
	assert.match(windowsWorkflow, /files: release\/PiDeck-Q-\$\{\{ needs\.resolve-version\.outputs\.version \}\}-win-x64\.zip/);
	assert.match(windowsWorkflow, /fail_on_unmatched_files: true/);
});

test("portable native startup repairs Windows toast application registration", () => {
	const notifier = readFileSync("native/src/WindowsToastNotifier.cpp", "utf8");
	const startup = readFileSync("native/src/main.cpp", "utf8");
	assert.match(notifier, /FOLDERID_Programs/);
	assert.match(notifier, /PKEY_AppUserModel_ID/);
	assert.match(notifier, /SetCurrentProcessExplicitAppUserModelID/);
	assert.match(notifier, /PiDeck-Q\.lnk/);
	assert.match(startup, /WindowsToastNotifier::registerApplication\(QCoreApplication::applicationFilePath\(\)\)/);
});

test("native Windows distribution keeps staging independent from NSIS", () => {
	const dist = readFileSync("scripts/dist-win-native.mjs", "utf8");
	assert.match(dist, /build:native/);
	assert.match(dist, /verify:build-artifacts/);
	assert.doesNotMatch(dist, /makensis|prepare-nsis|INETC_PLUGIN_DIR|installer\/PiDeck-Q/);
	assert.match(dist, /PIDECK_VERSION/);
});

test("packaged built-in extensions receive undici beside their own files", () => {
	const xmake = readFileSync("xmake.lua", "utf8");
	const runtimeStager = readFileSync("scripts/stage-native-runtime.mjs", "utf8");
	assert.match(xmake, /stage-native-runtime\.mjs/);
	assert.match(runtimeStager, /resources.*extensions.*node_modules.*undici/s);
	assert.match(runtimeStager, /node_modules.*node-pty/s);
	const verifier = readFileSync("scripts/verify-build-artifacts.mjs", "utf8");
	assert.match(verifier, /resources.*extensions.*node_modules.*undici.*package\.json/s);
});
