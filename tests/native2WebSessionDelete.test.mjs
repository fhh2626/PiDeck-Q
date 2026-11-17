import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { httpRequest, resolveBackendExecutable, startBackendSession } from "./helpers/native2BackendHarness.mjs";

const executable = resolveBackendExecutable();
const token = "web-delete-test-token-0123456789ABCDEF";

async function portNumber() {
	return new Promise((resolve, reject) => {
		const server = createServer(); server.on("error", reject);
		server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); });
	});
}

if (executable) test("web deletion validates options and forwards explicit permanent deletion", async (t) => {
	const port = await portNumber();
	const trashRequests = [];
	const f = await startBackendSession(t, {
		projects: [{ id: "web-delete", path: process.cwd() }],
		settings: { webServiceEnabled: true, webServiceHost: "127.0.0.1", webServicePort: port, webServiceAccessToken: token },
		hostHandlers: { "shell.trashItem": (params) => {
			trashRequests.push(params.path);
			return { result: { status: "trash-failed" } };
		} },
	});
	const file = join(f.fixture.sessions, "web-delete.jsonl");
	writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "web-delete", cwd: process.cwd(), timestamp: "2026-01-01T00:00:00.000Z" }) + "\n");
	const list = await f.invoke("sessions:catalog-list", ["web-delete"]);
	const record = list.payload.result.find((item) => item.filePath.replaceAll("\\", "/") === file.replaceAll("\\", "/"));
	assert.ok(record);
	const url = `http://127.0.0.1:${port}/api/sessions/${record.id}/delete`;
	const request = async (body) => {
		for (let attempt = 0; ; ++attempt) {
			try {
				const response = await httpRequest(url, { method: "POST", headers: { authorization: `Bearer ${token}` }, body });
				return { status: response.status, json: JSON.parse(response.body) };
			} catch (error) { if (attempt === 100) throw error; await new Promise((r) => setTimeout(r, 50)); }
		}
	};
	for (const body of ['{"permanent":"true"}', '{"permanent":true,"extra":1}', '[]', '{']) {
		const result = await request(body);
		assert.equal(result.status, 400, JSON.stringify(result));
		assert.ok(existsSync(file));
	}
	assert.deepEqual(trashRequests, []);
	for (const body of [null, "{}", '{"permanent":false}']) {
		const previousTrashCount = trashRequests.length;
		const result = await request(body);
		assert.equal(result.status, 200, JSON.stringify(result));
		assert.deepEqual(result.json.deleted, { status: "trash-failed" });
		assert.equal(trashRequests.length, previousTrashCount + 1);
		assert.equal(trashRequests.at(-1).replaceAll("\\", "/"), file.replaceAll("\\", "/"));
		assert.ok(existsSync(file));
	}
	const previousTrashCount = trashRequests.length;
	const removed = await request('{"permanent":true}');
	assert.equal(removed.status, 200, JSON.stringify(removed));
	assert.equal(removed.json.deleted, true);
	assert.equal(trashRequests.length, previousTrashCount);
	assert.equal(existsSync(file), false);
});

if (executable) test("web deletion does not expose arbitrary host errors as recovery guidance", async (t) => {
	const port = await portNumber();
	const f = await startBackendSession(t, {
		projects: [{ id: "web-private-error", path: process.cwd() }],
		settings: { webServiceEnabled: true, webServiceHost: "127.0.0.1", webServicePort: port, webServiceAccessToken: token },
		hostHandlers: { "shell.trashItem": () => ({ ok: false, error: "PRIVATE-ERROR C:/secret-session-root" }) },
	});
	const file = join(f.fixture.sessions, "private-error.jsonl");
	writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "private-error", cwd: process.cwd() }) + "\n");
	const record = (await f.invoke("sessions:catalog-list", ["web-private-error"])).payload.result.find((row) => row.filePath.replaceAll("\\", "/") === file.replaceAll("\\", "/"));
	assert.ok(record);
	const response = await httpRequest(`http://127.0.0.1:${port}/api/sessions/${record.id}/delete`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" });
	assert.equal(response.status, 500);
	assert.equal(JSON.parse(response.body).code, "webError.internal");
	assert.doesNotMatch(response.body, /PRIVATE-ERROR|secret-session-root/);
	assert.ok(existsSync(file));
});

if (executable) for (const [language, message] of [
	["en-US", "This WSL environment needs GNU mv with --no-copy for safe trash. Upgrade coreutils and retry. Some files may already be in trash."],
	["zh-CN", "此 WSL 环境的 mv 不支持安全回收（--no-copy），已停止删除。请升级 GNU coreutils 后重试。部分文件可能已移入回收站。"],
]) test(`web deletion forwards only the fixed ${language} safe-trash recovery message`, async (t) => {
	const port = await portNumber();
	const f = await startBackendSession(t, {
		projects: [{ id: "web-safe-trash", path: process.cwd() }],
		settings: { language, webServiceEnabled: true, webServiceHost: "127.0.0.1", webServicePort: port, webServiceAccessToken: token },
		hostHandlers: { "shell.trashItem": () => ({ ok: false, error: message }) },
	});
	const file = join(f.fixture.sessions, "safe-trash.jsonl");
	writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "safe-trash", cwd: process.cwd() }) + "\n");
	const record = (await f.invoke("sessions:catalog-list", ["web-safe-trash"])).payload.result.find((row) => row.filePath.replaceAll("\\", "/") === file.replaceAll("\\", "/"));
	assert.ok(record);
	for (let attempt = 0; attempt < 2; ++attempt) {
		const response = await httpRequest(`http://127.0.0.1:${port}/api/sessions/${record.id}/delete`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" });
		const payload = JSON.parse(response.body);
		assert.equal(response.status, 400, JSON.stringify(payload));
		assert.equal(payload.code, "webError.wslSafeTrashUnavailable");
		assert.equal(payload.error, message);
		assert.ok(existsSync(file));
	}
});

if (executable) for (const language of ["en-US", "zh-CN"]) {
	test(`web deletion preserves safe ${language} legacy-root recovery guidance`, async (t) => {
		const port = await portNumber();
		let file;
		const f = await startBackendSession(t, {
			settings: { language, webServiceEnabled: true, webServiceHost: "127.0.0.1", webServicePort: port, webServiceAccessToken: token },
			prepare: (fixture) => {
				const project = join(fixture.root, "project");
				const former = join(fixture.root, "unverified-former-sessions");
				mkdirSync(project); mkdirSync(former);
				file = join(former, "legacy.jsonl");
				writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "legacy-web", cwd: project }) + "\n");
				writeFileSync(join(fixture.userData, "projects.json"), JSON.stringify([{ id: "legacy-web-project", path: project, environment: "windows" }]));
				writeFileSync(join(fixture.userData, "session-catalog.json"), JSON.stringify({ version: 1, sessions: [
					{ id: "legacy-web", projectId: "legacy-web-project", filePath: file, environment: "native", source: "pi", status: "active", title: "Legacy", originKey: "legacy-web" },
				] }));
			},
		});
		const original = readFileSync(file, "utf8");
		for (const body of ["{}", '{"permanent":true}']) {
			const response = await httpRequest(`http://127.0.0.1:${port}/api/sessions/legacy-web/delete`, {
				method: "POST", headers: { authorization: `Bearer ${token}` }, body,
			});
			const payload = JSON.parse(response.body);
			assert.equal(response.status, 400, JSON.stringify(payload));
			assert.equal(payload.code, "webError.deleteRootNotAuthorized");
			assert.match(payload.error, /sessionDir/);
			assert.match(payload.error, language === "zh-CN" ? /刷新/ : /refresh/i);
			assert.equal(readFileSync(file, "utf8"), original);
		}
		assert.equal(f.trashCalls.length, 0);
		const records = await f.invoke("sessions:catalog-list", ["legacy-web-project", { scan: false }]);
		assert.ok(records.payload.result.some((row) => row.id === "legacy-web"));
	});
}
