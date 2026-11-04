#!/usr/bin/env node

/**
 * 查询 npm 上 @earendil-works/pi-coding-agent 的 latest，装到独立的
 * .cache/pi-latest npm 项目，供 typecheck / 真实 builder 测试使用。
 * 根 node_modules 和清单完全不参与准备过程，避免 npm 重解普通构建依赖。
 * 具体版本号只作为日志出现，不作为源码或配置里的兼容规则。
 */
import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPiFixtureDir, getPiFixturePackageDir, initializePiFixture, PI_PACKAGE, PROJECT_ROOT, withPiFixtureLock } from "./pi-compatibility-fixture.mjs";

export { PI_PACKAGE };
export const VIEW_ARGS = ["view", PI_PACKAGE, "version"];
export const INSTALL_ARGS = [
	"install",
	"--no-save",
	"--package-lock=false",
	"--ignore-scripts",
	`${PI_PACKAGE}@latest`,
];

/** Windows 上 npm 是 .cmd，必须走 node + npm-cli.js，禁止拼 shell 命令。 */
export function createNpmCommand() {
	if (process.platform === "win32") {
		const npmCli = process.env.npm_execpath
			?? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
		return { command: process.execPath, prefixArgs: [npmCli] };
	}
	return { command: "npm", prefixArgs: [] };
}

export async function readInstalledVersion(packageDir) {
	try {
		const raw = await readFile(join(packageDir, "package.json"), "utf8");
		const version = JSON.parse(raw).version;
		return typeof version === "string" && version.length > 0 ? version : null;
	} catch {
		return null;
	}
}

function runNpm(args, { command, prefixArgs } = createNpmCommand(), cwd = process.cwd()) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, [...prefixArgs, ...args], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env },
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolve({ stdout, stderr });
			else reject(new Error(`npm ${args.join(" ")} failed (${code ?? signal}): ${(stderr || stdout).trim()}`));
		});
	});
}

function parseLatest(stdout) {
	const latest = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)?.trim() ?? "";
	if (!latest) throw new Error(`npm view ${PI_PACKAGE} version returned empty output`);
	return latest;
}

/**
 * 可注入的核心流程，便于单测覆盖「已是 latest / 需要安装 / 安装后不一致」。
 * CLI 入口失败时设 process.exitCode = 1，不抛给上层以免堆栈淹没日志。
 */
export async function preparePiLatest(deps = {}) {
	const log = deps.log ?? console.log;
	const error = deps.error ?? console.error;
	const projectRoot = deps.cwd ?? PROJECT_ROOT;
	const cwd = getPiFixtureDir(projectRoot);
	const packageDir = getPiFixturePackageDir(projectRoot);
	const preparedFile = join(cwd, "prepared.json");
	const readPrepared = deps.readPrepared ?? (async () => {
		try { return JSON.parse(await readFile(preparedFile, "utf8")).version; }
		catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return null; throw error; }
	});
	const npm = deps.runNpm ?? runNpm;
	const queryLatest = deps.queryLatest ?? (async () => parseLatest((await npm(VIEW_ARGS, createNpmCommand(), cwd)).stdout));
	const readInstalled = deps.readInstalled ?? (() => readInstalledVersion(packageDir));
	// --prefix is intentional redundancy: npm must never discover an ancestor's
	// package when preparing an empty or partially installed fixture directory.
	const installArgs = ["--prefix", cwd, ...INSTALL_ARGS];
	const installLatest = deps.installLatest ?? (() => npm(installArgs, createNpmCommand(), cwd));

	return withPiFixtureLock(cwd, async () => {
		await initializePiFixture(cwd);
		const latestVersion = await queryLatest();
		log(`Pi compatibility fixture: ${cwd}`);
		log(`Latest Pi version: ${latestVersion}`);

		const installedVersion = await readInstalled();
		if (installedVersion === latestVersion && await readPrepared() === latestVersion) {
			log("Pi compatibility fixture already current.");
			log("[Pi compatibility]");
			log(`npm latest: ${latestVersion}`);
			log(`installed:  ${installedVersion}`);
			return { latestVersion, installedVersion, installed: true };
		}

		log("Installing latest Pi compatibility fixture...");
		// npm can write the new SDK manifest before failing. A separate completion
		// receipt prevents a partial installation from being accepted on the next run.
		await rm(preparedFile, { force: true });
		await installLatest({ cwd, packageDir, args: installArgs });
		const after = await readInstalled();
		if (after !== latestVersion) {
			error(`Pi compatibility fixture version mismatch: expected ${latestVersion}, got ${after ?? "missing"}`);
			return { latestVersion, installedVersion: after, installed: false };
		}

		await writeFile(preparedFile, `${JSON.stringify({ version: after })}\n`);
		log(`Installed Pi compatibility fixture: ${after}`);
		log("[Pi compatibility]");
		log(`npm latest: ${latestVersion}`);
		log(`installed:  ${after}`);
		return { latestVersion, installedVersion: after, installed: true };
	});
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
	try {
		const result = await preparePiLatest();
		if (!result.installed) process.exitCode = 1;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
