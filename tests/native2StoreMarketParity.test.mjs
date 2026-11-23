import assert from "node:assert/strict";
import { createServer } from "node:http";
import {   mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { gzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { resolveBackendExecutable, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { writeNodeShim } from "./helpers/native2FakeProcess.mjs";

const executable = resolveBackendExecutable();

const { mainProcessT } = loadTsCommonJs(resolve("src/shared/i18n/mainProcessCopy.ts"));

const copy = (key, params) => mainProcessT("en-US", key, params ?? {});
const plain = (value) => JSON.parse(JSON.stringify(value ?? null));

/**
 * A real SQLite file with the shipped schema. Rows are written with `node:sqlite` and the
 * BLOBs are gzipped exactly like `scripts/convert-xueprompts.mjs` writes them, so both
 * readers (QSQLITE and sql.js) are exercised against genuine compressed data.
 */
function createXuePromptDatabase(path) {
	const database = new DatabaseSync(path);
	database.exec(`
		CREATE TABLE xueprompt_categories (slug TEXT PRIMARY KEY, name TEXT, count INTEGER);
		CREATE TABLE xueprompts (
			slug TEXT PRIMARY KEY,
			url TEXT,
			title TEXT,
			category TEXT,
			content BLOB,
			description BLOB
		);
	`);
	const categories = [
		{ slug: "marketing-seo", name: "营销/SEO提示词", count: 2 },
		{ slug: "writing", name: "写作提示词", count: 1 },
	];
	const insertCategory = database.prepare(
		"INSERT INTO xueprompt_categories (slug, name, count) VALUES (?, ?, ?)",
	);
	for (const category of categories) insertCategory.run(category.slug, category.name, category.count);

	const insertPrompt = database.prepare(
		"INSERT INTO xueprompts (slug, url, title, category, content, description) VALUES (?, ?, ?, ?, ?, ?)",
	);
	const rows = [
		{
			slug: "seo-audit",
			title: "SEO 审计",
			category: "营销/SEO提示词",
			content: "请审计以下网站：${url}\n输出问题清单。",
			description: "对网站做一次完整的 SEO 审计",
		},
		{
			slug: "seo-keywords",
			title: "关键词研究",
			category: "营销/SEO提示词",
			content: "为 ${product} 生成 20 个长尾关键词。",
			description: "生成长尾关键词列表",
		},
		{
			slug: "story-outline",
			title: "故事大纲",
			category: "写作提示词",
			content: "为 ${theme:成长} 写一个三幕大纲。",
			description: "三幕式故事大纲",
		},
		// A legacy uncompressed row must still be readable.
		{
			slug: "legacy-plain",
			title: "旧版未压缩",
			category: "写作提示词",
			content: "未压缩正文",
			description: "旧版数据",
			plain: true,
		},
	];
	for (const row of rows) {
		const encode = (text) => (row.plain ? Buffer.from(text, "utf8") : gzipSync(Buffer.from(text, "utf8")));
		insertPrompt.run(
			row.slug,
			`https://xueprompt.com/p/${row.slug}`,
			row.title,
			row.category,
			encode(row.content),
			encode(row.description),
		);
	}
	database.close();
	return path;
}

/**
 * Every stub this file starts. A still-listening server keeps the test process alive, so
 * the suite closes them all at the end instead of relying on per-test bookkeeping.
 */
const liveStubs = [];

/** Scriptable HTTP stub for prompts.chat / skills.sh. */
function listenMarketStub(handler) {
	const requests = [];
	const sockets = new Set();
	const server = createServer((request, response) => {
		const url = new URL(request.url, "http://127.0.0.1");
		requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
		const reply = handler(url);
		response.writeHead(reply.status ?? 200, { "content-type": "application/json" });
		response.end(JSON.stringify(reply.body ?? {}));
	});
	return new Promise((done) => {
		server.on("connection", (socket) => {
			sockets.add(socket);
			socket.on("close", () => sockets.delete(socket));
		});
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			done({
				base: `http://127.0.0.1:${port}`,
				requests,
				// Both peers pool connections: Node's global fetch (undici) keeps keep-alive
				// sockets, and the backend's QNetworkAccessManager keeps its own. A bare
				// server.close() would therefore never resolve, so every socket is destroyed.
				stop: () =>
					new Promise((closed) => {
						server.close(closed);
						for (const socket of sockets) socket.destroy();
					}),
			});
		});
	});
}

/** Start a stub and remember it for the suite teardown. */
async function startMarketStub(handler) {
	const created = await listenMarketStub(handler);
	liveStubs.push(created);
	return created;
}

const PROMPT_ITEM = {
	id: "p-1",
	title: "Code Review",
	description: "Review a diff",
	content: "Review ${file} against ${rules:style}",
	type: "TEXT",
	author: { name: "Ada" },
	category: { name: "Coding" },
	tags: [{ tag: { name: "review" } }, { tag: { name: "code" } }],
	voteCount: 7,
	createdAt: "2024-01-02T03:04:05.000Z",
};

if (executable) {
	describe("native2 store market parity", () => {
		let root;
		let seq = 0;
		let stub;

		before(async () => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-market-"));
		});
		after(async () => {
			for (const entry of liveStubs) await entry.stop();
			liveStubs.length = 0;
			if (root) rmSync(root, { recursive: true, force: true });
		});

		function homeFor() {
			seq += 1;
			const home = join(root, `home-${seq}`);
			mkdirSync(join(home, ".pi", "agent", "prompts"), { recursive: true });
			mkdirSync(join(home, ".pi", "agent", "skills"), { recursive: true });
			mkdirSync(join(home, ".agents", "skills"), { recursive: true });
			return home;
		}


		const start = (t, home, extra = {}) =>
			startBackendSession(t, {
				settings: { language: "en-US" },
				env: {
					PIDECK_HOME: home,
					PIDECK_HOST_HOME: home,
					PIDECK_PROMPTS_DIR: join(home, ".pi", "agent", "prompts"),
					PIDECK_SKILLS_DIR: join(home, ".pi", "agent", "skills"),
					PIDECK_SESSIONS_DIR: join(home, ".pi", "agent", "sessions"),
					PIDECK_PROMPT_STORE_BASE: extra.promptStoreBase ?? "",
					PIDECK_SKILL_HUB_BASE: extra.skillHubBase ?? "",
					...(extra.env ?? {}),
				},
				hostHandlers: extra.hostHandlers,
			});

		// ── prompts.chat ────────────────────────────────────────────────
		test("prompt-store:search forwards the query and flattens returned records", async (t) => {
			stub = await startMarketStub(() => ({ body: { total: 1, prompts: [PROMPT_ITEM] } }));
			const home = homeFor();
			const session = await start(t, home, { promptStoreBase: `${stub.base}/api` });

			const actual = await session.invoke("prompt-store:search", [
				"code review",
				{ limit: 5, type: "TEXT", category: "Coding", tag: "review" },
			]);
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			assert.equal(actual.payload.result.count, 1);
			assert.equal(actual.payload.result.prompts[0].title, "Code Review");
			assert.equal(actual.payload.result.prompts[0].author, "Ada");

			// The request carries every option the oracle forwards.
			const request = stub.requests.at(-1);
			assert.equal(request.path, "/api/prompts");
			assert.deepEqual(request.query, {
				q: "code review",
				perPage: "5",
				type: "TEXT",
				category: "Coding",
				tag: "review",
			});
		});

		test("prompt-store:get percent-encodes the id and flattens the record", async (t) => {
			stub = await startMarketStub(() => ({ body: PROMPT_ITEM }));
			const home = homeFor();
			const session = await start(t, home, { promptStoreBase: `${stub.base}/api` });

			const id = "owner/slug with space";
			const actual = await session.invoke("prompt-store:get", [id]);
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			assert.equal(actual.payload.result.author, "Ada");
			assert.deepEqual(actual.payload.result.tags, ["review", "code"]);
			assert.equal(actual.payload.result.votes, 7);
			assert.equal(stub.requests.at(-1).path, "/api/prompts/owner%2Fslug%20with%20space");
		});

		test("a failing store reports a localized error, never an empty list", async (t) => {
			stub = await startMarketStub(() => ({ status: 503, body: { error: "down" } }));
			const home = homeFor();
			const session = await start(t, home, { promptStoreBase: `${stub.base}/api` });

			const search = await session.invoke("prompt-store:search", ["anything"]);
			assert.equal(search.payload.ok, false);
			assert.equal(search.payload.error.message, copy("store.promptSearchFailed"));

			const detail = await session.invoke("prompt-store:get", ["p-1"]);
			assert.equal(detail.payload.ok, false);
			assert.equal(detail.payload.error.message, copy("store.promptDetailFailed"));
		});

		test("prompt-store:import converts ${name} to positional $1 and writes the frontmatter", async (t) => {
			const home = homeFor();
			const session = await start(t, home);

			const input = {
				title: "  Code Review!! ",
				description: "Review\na diff",
				content: "Review ${file} against ${rules:style} and ${file} again",
			};
			const actual = await session.invoke("prompt-store:import", [input]);
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));

			const backendPath = join(home, ".pi", "agent", "prompts", "code-review.md");
			const content = readFileSync(backendPath, "utf8");
			// `${file}` → `$1`, `${rules:style}` → `${2:-style}`, and the hint line lists both.
			assert.match(content, /^---\ndescription: Review a diff\nsource: prompts\.chat\nargument-hint: <file> \[rules:style\]\n---\n\n/);
			assert.match(content, /Review \$1 against \$\{2:-style\} and \$1 again$/);

			// Importing the same title again lands on `-2`, exactly like createUniquePrompt.
			const again = await session.invoke("prompt-store:import", [input]);
			assert.equal(again.payload.ok, true, JSON.stringify(again.payload));
			assert.equal(again.payload.result.name, "code-review-2");
		});

		test("prompt-store:import rejects a title with no usable characters", async (t) => {
			const home = homeFor();
			const session = await start(t, home);
			const rejected = await session.invoke("prompt-store:import", [
				{ title: "!!!", description: "x", content: "y" },
			]);
			assert.equal(rejected.payload.ok, false);
			assert.equal(rejected.payload.error.message, copy("store.invalidItemTitle"));
		});

		// ── skills.sh ───────────────────────────────────────────────────
		test("skill-hub:search sorts by installs and returns normalized records", async (t) => {
			stub = await startMarketStub(() => ({
				body: {
					skills: [
						{ id: "owner/low", skillId: "low", name: "low", installs: 3, source: "owner" },
						{ id: "owner/high", skillId: "high", name: "high", installs: 900, source: "owner" },
					],
				},
			}));
			const home = homeFor();
			const session = await start(t, home, { skillHubBase: stub.base });

			const actual = await session.invoke("skill-hub:search", [{ query: "pdf", limit: 10 }]);
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			assert.deepEqual(
				actual.payload.result.items.map((item) => item.slug),
				["owner/high", "owner/low"],
			);
			assert.equal(actual.payload.result.total, 2);
			assert.deepEqual(stub.requests.at(-1).query, { q: "pdf", limit: "10" });
		});

		test("skill-hub:detail is explicitly unsupported", async (t) => {
			const home = homeFor();
			const session = await start(t, home);
			const actual = await session.invoke("skill-hub:detail", ["owner/skill"]);
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			assert.equal(actual.payload.result, null);
		});

		test("skill-hub:install refuses a slug outside the shell-safe allowlist", async (t) => {
			const home = homeFor();
			const session = await start(t, home);

			for (const slug of ["owner/skill;rm -rf /", "$(whoami)", "a/b`id`"]) {
				const actual = await session.invoke("skill-hub:install", [slug]);
				assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
				assert.equal(actual.payload.result.success, false);
				assert.equal(actual.payload.result.error, copy("store.skillsShInvalidSlug"));
			}
		});

		test("skill-hub:install runs npx with an argument array and reports failures", async (t) => {
			const home = homeFor();
			const binDir = join(home, "fake-bin");
			mkdirSync(binDir, { recursive: true });
			const logPath = join(home, "npx-calls.json");
			// A fake npx records its argv and exits with the code in PIDECK_FAKE_NPX_EXIT.
			const script = join(binDir, "npx.mjs");
			writeFileSync(
				script,
				[
					'import { appendFileSync } from "node:fs";',
					`appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
					"const exitCode = Number(process.env.PIDECK_FAKE_NPX_EXIT ?? 0);",
					'if (exitCode) process.stderr.write("fixture installer failed\\n");',
					"process.exit(exitCode);",
				].join("\n"),
			);
			writeNodeShim(binDir, "npx", script);

			// The shim uses an absolute Node path. Keep only the fixture on PATH so a
			// broken shim cannot fall through to a real package installer. The harness
			// separately prepends Qt's runtime directory on Windows.
			const session = await start(t, home, {
				env: { PATH: binDir, PIDECK_FAKE_NPX_EXIT: "0" },
			});

			const installed = await session.invoke("skill-hub:install", ["owner/repo/pdf-tools"]);
			assert.equal(installed.payload.ok, true, JSON.stringify(installed.payload));
			assert.deepEqual(plain(installed.payload.result), {
				success: true,
				slug: "owner/repo/pdf-tools",
				installDir: "",
			});
			const failedSession = await start(t, home, {
				env: { PATH: binDir, PIDECK_FAKE_NPX_EXIT: "37" },
			});
			const failed = await failedSession.invoke("skill-hub:install", ["owner/repo/failing-tool"]);
			assert.equal(failed.payload.ok, true, JSON.stringify(failed.payload));
			assert.deepEqual(plain(failed.payload.result), {
				success: false,
				slug: "owner/repo/failing-tool",
				installDir: "",
				error: "fixture installer failed",
			});
			const calls = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
			assert.deepEqual(calls, [
				["skills", "add", "owner/repo", "-g", "-s", "pdf-tools", "-y"],
				["skills", "add", "owner/repo", "-g", "-s", "failing-tool", "-y"],
			]);
		});

		// ── skill-store ─────────────────────────────────────────────────
		test("skill-store:search and import preserve content", async (t) => {
			stub = await startMarketStub(() => ({ body: { total: 1, prompts: [PROMPT_ITEM] } }));
			const home = homeFor();
			const session = await start(t, home, { promptStoreBase: `${stub.base}/api` });

			const search = await session.invoke("skill-store:search", ["code review"]);
			assert.equal(search.payload.ok, true, JSON.stringify(search.payload));
			const item = search.payload.result.prompts[0];
			assert.equal(item.title, "Code Review");
			const imported = await session.invoke("skill-store:import", [item]);
			assert.equal(imported.payload.ok, true, JSON.stringify(imported.payload));
			const content = readFileSync(join(home, ".pi", "agent", "skills", "code-review", "SKILL.md"), "utf8");
			assert.match(content, /^name: code-review$/m);
			assert.match(content, /Review \$\{file\} against \$\{rules:style\}/);

		});

		// ── yao-prompts (bundled SQLite) ────────────────────────────────
		test("yao-prompts:list and detail read the shipped schema byte for byte", async (t) => {
			const home = homeFor();
			createXuePromptDatabase(join(home, "xueprompts.db"));
			const session = await start(t, home, {
				env: { PIDECK_RESOURCES_PATH: home },
			});

			// Unpaged (legacy) shape.
			const legacy = await session.invoke("yao-prompts:list");
			assert.equal(legacy.payload.ok, true, JSON.stringify(legacy.payload));
			assert.equal(legacy.payload.result.prompts.length, 4);
			assert.deepEqual(
				legacy.payload.result.categories.map((category) => category.slug),
				["marketing-seo", "writing"],
			);

			// Paged shape with a category slug that must resolve through the subquery.
			const paged = await session.invoke("yao-prompts:list", [{ category: "marketing-seo", page: 1, pageSize: 1 }]);
			assert.equal(paged.payload.ok, true, JSON.stringify(paged.payload));
			assert.equal(paged.payload.result.total, 2);
			assert.equal(paged.payload.result.prompts.length, 1);

			// Search across title and description.
			const searched = await session.invoke("yao-prompts:list", [{ search: "关键词" }]);
			assert.equal(searched.payload.ok, true, JSON.stringify(searched.payload));
			assert.equal(searched.payload.result.total, 1);

			// Detail includes the gzip-decoded content and the synthesized frontmatter.
			for (const slug of ["seo-audit", "story-outline", "legacy-plain"]) {
				const detail = await session.invoke("yao-prompts:detail", [slug, "any"]);
				assert.equal(detail.payload.ok, true, `${slug}: ${JSON.stringify(detail.payload)}`);
				const expectedBody = { "seo-audit": "请审计以下网站：${url}\n输出问题清单。", "story-outline": "为 ${theme:成长} 写一个三幕大纲。", "legacy-plain": "未压缩正文" }[slug];
				assert.equal(detail.payload.result.promptContent, expectedBody);
				assert.ok(detail.payload.result.fullContent.endsWith(`\n\n${expectedBody}`), JSON.stringify(detail.payload.result));
				assert.match(detail.payload.result.fullContent, /^source: xueprompt$/m);
			}
			const missing = await session.invoke("yao-prompts:detail", ["nope", "any"]);
			assert.equal(missing.payload.ok, false);
			assert.equal(missing.payload.error.message, copy("store.yaoDetailFailed"));
		});

		test("yao-prompts:import writes the decoded template", async (t) => {
			const home = homeFor();
			createXuePromptDatabase(join(home, "xueprompts.db"));
			const session = await start(t, home, { env: { PIDECK_RESOURCES_PATH: home } });

			const actual = await session.invoke("yao-prompts:import", ["story-outline", "写作提示词"]);
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));

			// The gzipped BLOB content survives the round trip.
			assert.match(
				readFileSync(join(home, ".pi", "agent", "prompts", "story-outline.md"), "utf8"),
				/为 \$\{theme:成长\} 写一个三幕大纲。$/,
			);
		});

		test("a missing prompt database is an error, not an empty library", async (t) => {
			const home = homeFor();
			const session = await start(t, home, { env: { PIDECK_RESOURCES_PATH: join(home, "absent") } });
			const list = await session.invoke("yao-prompts:list");
			assert.equal(list.payload.ok, false);
			assert.equal(list.payload.error.message, copy("store.yaoListFailed"));
		});
	});
} else {
	describe("native2 store market parity", () => {
		test("requires a built backend", (t) => {
			t.skip("PiDeckBackend.exe is not built");
		});
	});
}
