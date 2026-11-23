import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
	createFakePi,
	resolveBackendExecutable,
	SseClient,
	startBackendSession,
} from "./helpers/native2BackendHarness.mjs";

const executable = resolveBackendExecutable();
const PROJECT_ID = "delivery-budget";
const slash = (value) => String(value).replaceAll("\\", "/");

const MAX_MESSAGE_DELIVERY_ENVELOPE_BYTES = 30 * 1024 * 1024;

const imageData = (length) => "A".repeat(length);

const messageEntry = (id, parentId, { text, imageLength, stamp }) => ({
	type: "message",
	id,
	parentId,
	timestamp: new Date(stamp).toISOString(),
	message: {
		role: "user",
		content: [
			...(text ? [{ type: "text", text }] : []),
			...(imageLength ? [{ type: "image", data: imageData(imageLength), mimeType: "image/png" }] : []),
		],
		timestamp: stamp,
	},
});

async function waitForFrame(sse, predicate, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		for (const frame of sse.frames) {
			if (predicate(frame)) return frame;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("expected SSE frame did not arrive");
}

const runtimeEvents = (sse, channel) => sse.frames
	.map((frame) => frame.payload)
	.filter((payload) => payload.channel === "sessions:runtime-event")
	.map((payload) => payload.args[0])
	.filter((event) => event.sourceChannel === channel);

if (executable) {
	describe("native2 delivery budget parity", () => {
		let root;
		let projectPath;

		before(() => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-budget-"));
			projectPath = join(root, "project");
			mkdirSync(projectPath, { recursive: true });
		});

		after(() => {
			if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		});

		const start = async (t, { scenario = {}, entries = null, env = {} } = {}) => {
			let fake = null;
			const session = await startBackendSession(t, {
				projects: [{ id: PROJECT_ID, path: projectPath }],
				settings: { language: "en-US" },
				env,
				prepare: (fixture) => {
					fake = createFakePi(fixture, scenario);
					return {
						settings: { customPiPath: fake.shim },
						env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath },
					};
				},
			});
			const name = `b-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
			const filePath = join(session.fixture.sessions, `${name}.jsonl`);
			// Every runtime needs a catalog record; the payload tests only care about the
			// live transcript, so a one-turn file is enough.
			const fileEntries = entries ?? [
				{ type: "session", version: 3, id: name, timestamp: "2026-01-01T00:00:00.000Z", cwd: projectPath },
				messageEntry("u1", null, { text: "hello", stamp: 1_767_225_601_000 }),
			];
			writeFileSync(filePath, `${fileEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
			const list = await session.invoke("sessions:catalog-list", [PROJECT_ID]);
			assert.equal(list.payload.ok, true, JSON.stringify(list.payload));
			const record = list.payload.result.find((entry) => slash(entry.filePath) === slash(filePath));
			assert.ok(record, "imported session must appear in the catalog");
			return { ...session, fake, record, filePath };
		};

		test("an oversized page offloads only its oldest image and preserves all other fields", async (t) => {
			const budget = 2_600;
			const name = `page-${Date.now()}`;
			const entries = [
				{ type: "session", version: 3, id: name, timestamp: "2026-01-01T00:00:00.000Z", cwd: projectPath },
				messageEntry("u1", null, { text: "oldest", imageLength: 700, stamp: 1_767_225_601_000 }),
				messageEntry("u2", "u1", { text: "middle", imageLength: 700, stamp: 1_767_225_602_000 }),
				messageEntry("u3", "u2", { text: "newest", imageLength: 700, stamp: 1_767_225_603_000 }),
			];
			const { invoke, record } = await start(t, {
				entries,
				env: { PIDECK_MESSAGE_DELIVERY_BUDGET_BYTES: String(budget) },
			});

			// Unbudgeted projection of the same rows (the oracle budget is a pure function
			// of the page object, so the golden needs the exact projection).
			const all = await invoke("sessions:catalog-read-messages", [record.id]);
			assert.equal(all.payload.ok, true, JSON.stringify(all.payload));
			const allMessages = all.payload.result;
			assert.equal(allMessages.length, 3);
			assert.equal(allMessages.every((row) => row.images?.length === 1), true);

			// One-message page doubles as the exact page shape (total / indexVersion).
			const proto = await invoke("sessions:catalog-read-message-page", [record.id, null, 1]);
			assert.equal(proto.payload.ok, true, JSON.stringify(proto.payload));
			assert.equal(proto.payload.result.messages.length, 1);
			assert.equal(proto.payload.result.messages[0].images?.length, 1, "a one-message page fits the budget");

			const goldenPage = {
				...proto.payload.result,
				messages: allMessages,
				total: 3,
				nextBefore: null,
			};
			const expected = structuredClone(goldenPage);
			delete expected.messages[0].images;
			expected.messages[0].imageDisplayNotice = { kind: "delivery-budget-exceeded", count: 1, omitted: 1 };

			const page = await invoke("sessions:catalog-read-message-page", [record.id, null, 3]);
			assert.equal(page.payload.ok, true, JSON.stringify(page.payload));
			// `loadTsCommonJs` runs the oracle in a vm realm, so its objects have a different
			// prototype and deepStrictEqual would reject identical values. Normalizing
			// through JSON keeps the comparison exact (key order is not part of the wire).
			assert.deepEqual(
				JSON.parse(JSON.stringify(page.payload.result)),
				expected,
				"page output must preserve text, identity and cursors while offloading the oldest image",
			);
		});

		test("the real 30 MiB page budget offloads a 31 MiB image", async (t) => {
			const name = `huge-${Date.now()}`;
			const entries = [
				{ type: "session", version: 3, id: name, timestamp: "2026-01-01T00:00:00.000Z", cwd: projectPath },
				messageEntry("u1", null, { text: "one huge image", imageLength: 31 * 1024 * 1024, stamp: 1_767_225_601_000 }),
			];
			const { invoke, record, filePath } = await start(t, { entries });
			// The fixture really carries the image; only the page path applies the budget.
			const sourceEntries = readFileSync(filePath, "utf8").split("\n").filter(Boolean);
			assert.ok(JSON.parse(sourceEntries[1]).message.content.some((block) => block.type === "image"));

			const page = await invoke("sessions:catalog-read-message-page", [record.id, null, 5]);
			assert.equal(page.payload.ok, true, JSON.stringify(page.payload));
			const row = page.payload.result.messages[0];
			assert.equal(row.images, undefined, "a 31 MiB image cannot fit the 30 MiB envelope");
			assert.deepEqual(row.imageDisplayNotice, {
				kind: "delivery-budget-exceeded",
				count: 1,
				omitted: 1,
			});
			assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, result: page.payload.result }), "utf8")
				< MAX_MESSAGE_DELIVERY_ENVELOPE_BYTES);
		});

		test("an over-budget live payload is blocked, never delivered oversized", async (t) => {
			const budget = 600;
			const longText = "T".repeat(2_000);
			const { invoke, baseUrl, token, record } = await start(t, {
				env: { PIDECK_MESSAGE_DELIVERY_BUDGET_BYTES: String(budget) },
				scenario: {
					messages: [{ role: "user", content: [{ type: "text", text: longText }], timestamp: 1_767_225_601_000 }],
					entries: { entries: [], leafId: null },
				},
			});
			const sse = new SseClient(`${baseUrl}__pideck/events?token=${encodeURIComponent(token)}`);
			await sse.connect().catch(() => undefined);
			t.after(() => sse.close());

			await invoke("sessions:runtime-activate", [record.id]);
			// Oracle `sessionRuntimeBridge`: no images left to offload -> publish blocked.
			const blocked = await waitForFrame(sse, (frame) => frame.payload.channel === "sessions:runtime-event"
				&& frame.payload.args[0].sourceChannel === "sessions:message-delivery-status");
			assert.deepEqual(blocked.payload.args[0].payload, {
				status: "blocked",
				code: "MESSAGE_DELIVERY_TOO_LARGE",
			});
			const delivered = runtimeEvents(sse, "agents:message");
			assert.equal(delivered.some((event) => JSON.stringify(event.payload).includes(longText)), false,
				"the oversized payload must not be delivered");
			for (const event of delivered) {
				const envelope = { channel: "sessions:runtime-event", args: [event] };
				assert.ok(Buffer.byteLength(JSON.stringify(envelope), "utf8") <= budget,
					"every delivered agents:message envelope must respect the budget");
			}
		});

		test("image offload is per message: older rows lose images, newer keep them", async (t) => {
			const budget = 1_900;
			const { baseUrl, token, record, invoke } = await start(t, {
				env: { PIDECK_MESSAGE_DELIVERY_BUDGET_BYTES: String(budget) },
				scenario: {
					messages: [
						{ role: "user", content: [{ type: "image", data: imageData(700), mimeType: "image/png" }], timestamp: 1_767_225_601_000 },
						{ role: "user", content: [{ type: "image", data: imageData(700), mimeType: "image/png" }], timestamp: 1_767_225_602_000 },
					],
					entries: { entries: [], leafId: null },
				},
			});
			const sse = new SseClient(`${baseUrl}__pideck/events?token=${encodeURIComponent(token)}`);
			await sse.connect().catch(() => undefined);
			t.after(() => sse.close());

			await invoke("sessions:runtime-activate", [record.id]);
			const frame = await waitForFrame(sse, (candidate) => candidate.payload.channel === "sessions:runtime-event"
				&& candidate.payload.args[0].sourceChannel === "agents:message"
				&& candidate.payload.args[0].payload.messages.length === 2);
			const event = frame.payload.args[0];
			const [oldest, newest] = event.payload.messages;

			assert.equal(oldest.images, undefined);
			assert.deepEqual(oldest.imageDisplayNotice, {
				kind: "delivery-budget-exceeded",
				count: 1,
				omitted: 1,
			});
			assert.equal(newest.images?.length, 1, "the newer row keeps its image: offload stops at the budget");
			assert.equal(newest.imageDisplayNotice, undefined);

			const envelope = { channel: "sessions:runtime-event", args: [event] };
			assert.ok(Buffer.byteLength(JSON.stringify(envelope), "utf8") <= budget,
				"the delivered envelope must fit the budget again");
		});
	});
}
