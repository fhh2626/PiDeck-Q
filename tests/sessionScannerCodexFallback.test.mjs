import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSessionScanner as loadSharedSessionScanner } from "./helpers/loadSessionScanner.mjs";

function loadSessionScanner(homePath) {
	const exports = loadSharedSessionScanner(homePath);
	class WrappedSessionScanner extends exports.SessionScanner {
		constructor(translate, home, ...rest) {
			super(translate, home ?? homePath, ...rest);
		}
	}
	return { ...exports, SessionScanner: WrappedSessionScanner };
}

test("backfills Codex subagent metadata for sessions imported before grouping fields existed", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-session-scanner-"));
	try {
		const projectPath = "/repo/project";
		const piDir = join(home, ".pi", "agent", "sessions", "--repo-project--");
		const codexDir = join(home, ".codex", "sessions", "2026", "06", "30");
		mkdirSync(piDir, { recursive: true });
		mkdirSync(codexDir, { recursive: true });

		const codexSourcePath = join(codexDir, "rollout-child.jsonl");
		writeFileSync(
			codexSourcePath,
			`${JSON.stringify({
				type: "session_meta",
				payload: {
					id: "child-thread",
					cwd: projectPath,
					thread_source: "subagent",
					parent_thread_id: "parent-thread",
					agent_role: "worker",
					agent_nickname: "Darwin",
				},
			})}\n`,
			"utf8",
		);

		writeFileSync(
			join(piDir, "codex_child-thread.jsonl"),
			[
				JSON.stringify({ sessionName: "Reviewer", cwd: projectPath }),
				JSON.stringify({ type: "session", id: "child-thread", cwd: projectPath }),
				JSON.stringify({
					type: "codex_import",
					version: 1,
					codexSessionId: "child-thread",
					sourcePath: codexSourcePath,
					sourceMtime: 1,
					sourceSize: 1,
				}),
				JSON.stringify({
					type: "message",
					message: { role: "user", content: [{ type: "text", text: "review" }] },
				}),
			].join("\n") + "\n",
			"utf8",
		);

		const { SessionScanner } = loadSessionScanner(home);
		const summaries = await new SessionScanner().list(projectPath);

		assert.equal(summaries.length, 1);
		assert.equal(summaries[0].codexThreadSource, "subagent");
		assert.equal(summaries[0].codexParentThreadId, "parent-thread");
		assert.equal(summaries[0].codexAgentRole, "worker");
		assert.equal(summaries[0].codexAgentNickname, "Darwin");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
