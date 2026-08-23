import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

/**
 * registerBackgroundImageProtocol 行为测试。
 *
 * renderer 用 `pideck-bg://local/<encodeURIComponent(name)>` 请求背景图。
 * 对自定义 scheme，url.host="local"，url.pathname="/<encoded-name>"（%2f 不被解码回 /）。
 * 协议先按正则 `^bg-[a-zA-Z0-9.]+$` 过滤，再用 resolve + startsWith 防穿越。
 *
 * 这里 mock electron.protocol.handle 捕获 handler，直接 invoke 它断言 MIME/状态码。
 */

function transpile(source) {
	return ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

let captured = null;
const mockElectron = {
	protocol: {
		handle: (name, fn) => {
			captured = { name, fn };
		},
	},
};

function loadProtocol() {
	const source = readFileSync("src/main/platform/electron/backgroundImageProtocol.ts", "utf8");
	const sandbox = {
		clearTimeout,
		setTimeout,
		process,
		Response,
		URL,
		exports: {},
		require: (id) => {
			if (id === "electron") return mockElectron;
			return require(id);
		},
	};
	vm.runInNewContext(transpile(source), sandbox, { filename: "backgroundImageProtocol.ts" });
	return sandbox.exports;
}

const { registerBackgroundImageProtocol } = loadProtocol();

async function request(bgDir, url) {
	// handler 由 registerBackgroundImageProtocol 注册到 mock electron
	const res = await captured.fn({ url });
	return res;
}

test("backgroundImageProtocol serves existing images with correct MIME per extension", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-bgproto-"));
	try {
		registerBackgroundImageProtocol(dir);
		// 覆盖 protocol 每次注册都会重新捕获
		const exts = [
			["bg-1.png", "image/png"],
			["bg-2.jpg", "image/jpeg"],
			["bg-3.jpeg", "image/jpeg"],
			["bg-4.webp", "image/webp"],
			["bg-5.gif", "image/gif"],
			["bg-6.avif", "image/avif"],
		];
		for (const [name, mime] of exts) {
			writeFileSync(join(dir, name), "data");
			const res = await request(dir, `pideck-bg://local/${name}`);
			assert.equal(res.status, 200, `${name} should be 200`);
			const ct = res.headers.get("Content-Type");
			assert.equal(ct, mime, `${name} should be ${mime}, got ${ct}`);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("backgroundImageProtocol returns 404 for a missing bg- file", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-bgproto-404-"));
	try {
		registerBackgroundImageProtocol(dir);
		const res = await request(dir, "pideck-bg://local/bg-missing.png");
		assert.equal(res.status, 404, "missing file should be 404");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("backgroundImageProtocol returns 403 for a name that fails the bg- regex", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-bgproto-403-"));
	try {
		// 即使文件存在，名字不合法也 403（名字校验先于读文件）
		writeFileSync(join(dir, "notbg.png"), "data");
		registerBackgroundImageProtocol(dir);
		const res = await request(dir, "pideck-bg://local/notbg.png");
		assert.equal(res.status, 403, "non bg- name should be 403");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("backgroundImageProtocol returns 403 for a name containing a path separator", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-bgproto-sep-"));
	try {
		// bg-abc/def.png 含 /，正则（无 /）应拦截
		mkdirSync(join(dir, "bg-abc"), { recursive: true });
		writeFileSync(join(dir, "bg-abc", "def.png"), "data");
		registerBackgroundImageProtocol(dir);
		const res = await request(dir, "pideck-bg://local/bg-abc/def.png");
		assert.equal(res.status, 403, "name with / should be 403 (no subdirs allowed)");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("backgroundImageProtocol blocks percent-encoded traversal (%2e%2e%2f / ..%2f)", async () => {
	// 使用测试专属父目录：诱饵位于 backgrounds 外，但仍在本测试的临时树内。
	// 禁止写 tmpdir()/secret.png，否则会覆盖并删除用户/其他测试的无关临时文件。
	const parent = mkdtempSync(join(tmpdir(), "pideck-bgproto-trav-"));
	const dir = join(parent, "backgrounds");
	mkdirSync(dir, { recursive: true });
	const sibling = join(parent, "secret.png");
	writeFileSync(sibling, "outside");
	try {
		registerBackgroundImageProtocol(dir);

		// %2e%2e%2f 在自定义 scheme 的 pathname 里保持编码（不解码回 /），
		// 因此 filename 里带 % 字符，正则（[a-zA-Z0-9.]+，无 %）应拦截
		const enc = await request(dir, "pideck-bg://local/%2e%2e%2fsecret.png");
		assert.equal(enc.status, 403, "encoded traversal should be 403");

		// ..%2f（裸 .. 前缀 + 编码斜杠）也不以 bg- 开头 → 403
		const dotdot = await request(dir, "pideck-bg://local/..%2fsecret.png");
		assert.equal(dotdot.status, 403, "dotdot encoded traversal should be 403");
		assert.equal(readFileSync(sibling, "utf8"), "outside", "blocked traversal must not alter the outside file");
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
});

test("backgroundImageProtocol: a literal bg-..png stays inside the root (resolve guard)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-bgproto-dots-"));
	try {
		// bg-..png 通过正则（.. 由 [a-zA-Z0-9.]+ 匹配），但没有 /，resolve 后仍在 root 内
		writeFileSync(join(dir, "bg-..png"), "data");
		registerBackgroundImageProtocol(dir);
		const res = await request(dir, "pideck-bg://local/bg-..png");
		assert.equal(res.status, 200, "bg-..png should resolve inside root and be served");
		assert.equal(res.headers.get("Content-Type"), "image/png");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
