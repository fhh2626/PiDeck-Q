/**
 * Scriptable fake pi for the C++ runtime parity tests.
 *
 * It speaks the real pi RPC wire protocol (newline-delimited JSON on stdio) so the
 * backend cannot tell it apart from pi: correlated `{id, type:"response"}` replies plus
 * unsolicited agent events. Behaviour comes from a JSON scenario file so a test can
 * script interleaving, late events, errors, pending UI and per-session differences.
 *
 * Scenario shape (all keys optional):
 *   {
 *     version: "0.79.0",
 *     versionGate: "/path/released-by-test", // hold only --version until this file exists
 *     state: { sessionId, sessionFile, sessionName, model, thinkingLevel },
 *     messages: [...],          // get_messages history
 *     entries: { entries: [], leafId: null },
 *     models: [...],            // get_available_models
 *     commands: [...],          // get_commands
 *     forkMessages: [...],      // get_fork_messages
 *     responses: { <command>: data | { error: "..." } | { delayMs, data, eventsBeforeReply?, replyGate? } | exitBeforeReply },
 *     turns: [ { ack: true|false, error, delayMs, replyGate, events: [ { delayMs, event } ] } ],
 *     bySession: { <deckSessionId>: <partial scenario> },
 *     onStart: [ { delayMs, event } ]
 *   }
 *
 * Every received command and every emitted event is appended to FAKE_PI_LOG as JSON
 * lines so a test can assert the exact protocol traffic.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const scenarioPath = process.env.FAKE_PI_SCENARIO ?? "";
const logPath = process.env.FAKE_PI_LOG ?? "";
const base = scenarioPath ? JSON.parse(readFileSync(scenarioPath, "utf8")) : {};
const deckSessionId = process.env.PIDECK_SESSION_ID ?? "";
const override = base.bySession?.[deckSessionId] ?? {};
const scenario = { ...base, ...override };

function log(entry) {
	if (!logPath) return;
	appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
	if (typeof scenario.versionGate === "string") {
		// Lifecycle races need a deterministic boundary before the real RPC process
		// exists. Ordinary scenarios retain their existing log shape.
		log({ kind: "probe-start", pid: process.pid });
		const deadline = Date.now() + 10_000;
		while (!existsSync(scenario.versionGate) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		if (!existsSync(scenario.versionGate)) throw new Error("version probe gate timed out");
	}
	// `versionDelayMs` lets a test occupy a blocking probe for a controlled amount of time
	// (the summary-cache write-order case scripts the backend's serial executor queue).
	// Top-level await keeps the process in this branch; `--version` never enters RPC mode.
	const versionDelayMs = Number(scenario.versionDelayMs ?? 0);
	if (Number.isFinite(versionDelayMs) && versionDelayMs > 0) {
		await new Promise((resolve) => setTimeout(resolve, versionDelayMs));
	}
	if (typeof scenario.versionGate === "string") log({ kind: "probe-exit", pid: process.pid });
	process.stdout.write(`${scenario.version ?? "0.79.0"}\n`);
	process.exit(0);
}

log({
	kind: "spawn",
	pid: process.pid,
	argv,
	env: {
		PIDECK_SESSION_ID: process.env.PIDECK_SESSION_ID ?? null,
		PIDECK_DESKTOP: process.env.PIDECK_DESKTOP ?? null,
		PIDECK_UI_LANGUAGE: process.env.PIDECK_UI_LANGUAGE ?? null,
		PIDECK_SECURITY_CONFIG: process.env.PIDECK_SECURITY_CONFIG ?? null,
		PIDECK_SECURITY_GATE_EXTENSION: process.env.PIDECK_SECURITY_GATE_EXTENSION ?? null,
		PIDECK_PI_STANDALONE: process.env.PIDECK_PI_STANDALONE ?? null,
		WSLENV: process.env.WSLENV ?? null,
		PIDECK_HOST_TOKEN: process.env.PIDECK_HOST_TOKEN ?? null,
		PIDECK_HOST_PORT: process.env.PIDECK_HOST_PORT ?? null,
	},
});

function write(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function respond(id, command, data, success = true) {
	write(success
		? { id, type: "response", command, success: true, data }
		: { id, type: "response", command, success: false, error: data });
}

function emit(event) {
	log({ kind: "event", event });
	write(event);
}

const timers = new Set();
function schedule(step, index) {
	const delay = Number(step.delayMs ?? 0);
	const timer = setTimeout(() => {
		timers.delete(timer);
		if (step.event) emit(step.event);
		else if (step.raw) process.stdout.write(`${step.raw}\n`);
	}, delay + index * 0);
	timer.unref?.();
	timers.add(timer);
}

function runSteps(steps = []) {
	let elapsed = 0;
	steps.forEach((step, index) => {
		elapsed += Number(step.delayMs ?? 0);
		const timer = setTimeout(() => {
			timers.delete(timer);
			if (step.event) emit(step.event);
			else if (step.raw) process.stdout.write(`${step.raw}\n`);
			else if (step.exitCleanly) process.exit(0);
			// A non-zero exit models pi dying mid-turn (OOM / killed by the OS).
			else if (step.exitWithCode !== undefined) process.exit(Number(step.exitWithCode));
		}, elapsed);
		timer.unref?.();
		timers.add(timer);
		void index;
	});
}

const state = {
	sessionId: scenario.state?.sessionId ?? `pi-${deckSessionId || "anonymous"}`,
	sessionFile: scenario.state?.sessionFile ?? "",
	sessionName: scenario.state?.sessionName ?? "",
	model: scenario.state?.model ?? { provider: "anthropic", id: "claude-sonnet-4" },
	thinkingLevel: scenario.state?.thinkingLevel ?? "high",
	isStreaming: false,
};

let turnIndex = 0;
/** Level the last `set_thinking_level` accepted; the default ack reports it back. */
let thinkingAck = null;
const pendingUi = new Map();
/** Per-command call counter, so `responses.<command>` may be an array of replies. */
const responseIndex = new Map();

/**
 * Pick the reply for one command.
 *
 * A single object is used forever; an array hands out one entry per call (the last entry
 * repeats). That is what lets a test script "first attempt fails, retry succeeds" without
 * rewriting the scenario file mid-test.
 */
function configuredResponse(command) {
	const configured = scenario.responses?.[command];
	if (!Array.isArray(configured)) return configured;
	const index = responseIndex.get(command) ?? 0;
	responseIndex.set(command, index + 1);
	return configured[Math.min(index, configured.length - 1)];
}

function defaultResponse(command) {
	switch (command) {
		case "get_state":
			return { ...state, sessionId: state.sessionId, sessionFile: state.sessionFile };
		case "get_messages":
			return { messages: scenario.messages ?? [] };
		case "get_entries":
			return scenario.entries ?? { entries: [], leafId: null };
		case "get_available_models":
			return { models: scenario.models ?? [{ id: "claude-sonnet-4", provider: "anthropic", name: "Sonnet 4" }] };
		case "get_commands":
			return { commands: scenario.commands ?? [{ name: "compact", description: "Compact the session" }] };
		case "get_fork_messages":
			return { messages: scenario.forkMessages ?? [] };
		case "set_model":
			return { model: state.model };
		case "set_thinking_level":
			// pi reports the level it accepted; the ack echoes the request unless the
			// scenario scripts its own reply (a build that clamps would).
			return { thinkingLevel: thinkingAck ?? state.thinkingLevel };
		case "set_session_name":
			return {};
		case "switch_session":
			return {};
		case "abort":
			return { aborted: true };
		case "compact":
			return { summary: "compacted", firstKeptEntryId: null };
		case "export_html":
			return { path: scenario.exportPath ?? "C:/tmp/session.html" };
		case "fork":
			return { sessionId: `${state.sessionId}-fork`, sessionFile: scenario.forkFile ?? "" };
		case "clone":
			return { sessionId: `${state.sessionId}-clone`, sessionFile: scenario.cloneFile ?? "" };
		case "extension_ui_response":
			return {};
		default:
			return {};
	}
}

function handlePrompt(id, command) {
	const turn = scenario.turns?.[turnIndex] ?? { ack: true, events: [] };
	turnIndex += 1;
	log({ kind: "prompt", turn: turnIndex - 1, id });
	const ack = () => {
		// `exitBeforeAck` models pi dying while a prompt is on the wire: the renderer must
		// be told the delivery is unknown instead of a definite rejection (retry would
		// duplicate a prompt pi may already have received).
		if (turn.exitBeforeAck === true) {
			process.exit(1);
			return;
		}
		if (turn.ack === false) respond(id, command, turn.error ?? "prompt rejected", false);
		else respond(id, command, turn.data ?? {});
		// `exitCleanlyAfterTurn` models pi restarting itself: the turn finishes normally and
		// the process then exits with code 0 while the session file stays valid, so the
		// desktop must reconnect the same runtime instead of reporting a closed one.
		const steps = [...(turn.events ?? [])];
		if (turn.exitCleanlyAfterTurn === true) steps.push({ delayMs: 80, exitCleanly: true });
		// `crashAfterEvents` models a process that dies in the middle of the reply: the
		// events above are delivered, then pi exits non-zero without `agent_settled`.
		if (turn.crashAfterEvents === true) steps.push({ delayMs: 80, exitWithCode: 1 });
		runSteps(steps);
	};
	const ackWhenReleased = () => {
		if (typeof turn.replyGate === "string" && !existsSync(`${scenarioPath}.${turn.replyGate}`)) {
			const timer = setTimeout(() => { timers.delete(timer); ackWhenReleased(); }, 10);
			timers.add(timer);
			return;
		}
		ack();
	};
	if (turn.delayMs) setTimeout(ackWhenReleased, Number(turn.delayMs));
	else ackWhenReleased();
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	const trimmed = line.trim();
	if (!trimmed) return;
	let message;
	try {
		message = JSON.parse(trimmed);
	} catch {
		log({ kind: "invalid", line: trimmed });
		return;
	}
	const command = message.type;
	log({ kind: "command", command, id: message.id, payload: message });
	if (command === "prompt") {
		handlePrompt(message.id, command);
		return;
	}
	if (command === "extension_ui_response") {
		const pending = pendingUi.get(message.id);
		if (pending) {
			pendingUi.delete(message.id);
			log({ kind: "ui-response", requestId: message.id, response: message });
			if (pending.onResponse) emit(pending.onResponse);
		}
		// A delayed ACK models pi taking its time to answer the UI frame: the desktop must
		// close its ask card from the write, not from this response.
		const uiAck = scenario.responses?.extension_ui_response;
		const uiDelay = Number(uiAck?.delayMs ?? 0);
		if (uiDelay > 0) {
			const timer = setTimeout(() => {
				timers.delete(timer);
				respond(message.id, command, {});
			}, uiDelay);
			timer.unref?.();
			timers.add(timer);
		} else {
			respond(message.id, command, {});
		}
		return;
	}
	const configured = configuredResponse(command);
	// Opt-in realism: `honorThinkingLevel` makes the fake keep the accepted level in its
	// runtime state (so a later get_state reflects it). The ack always echoes the accepted
	// level, which is what pi does; only a scenario that scripts `responses` may differ.
	if (command === "set_thinking_level" && typeof message.level === "string") {
		thinkingAck = message.level;
		if (scenario.honorThinkingLevel === true) state.thinkingLevel = message.level;
	}
	const delayMs = Number(configured?.delayMs ?? scenario.delayMs?.[command] ?? 0);
	const finish = () => {
		// `exitBeforeReply` models a pi build that restarts itself at the end of a
		// compaction: the RPC never gets an answer, but the session file already holds the
		// compacted history. The desktop must reattach the same agentId, not report a
		// failed compaction.
		if (configured?.exitBeforeReply === true) {
			process.exit(Number(configured.exitCode ?? 1));
			return;
		}
		// A deterministic RPC/event barrier, including failed replies: tests can place
		// a newer refresh request before a snapshot error without wall-clock delays.
		for (const event of configured?.eventsBeforeReply ?? []) emit(event);
		if (configured && configured.error !== undefined) {
			respond(message.id, command, configured.error, false);
			return;
		}
		const data = configured?.data !== undefined ? configured.data : defaultResponse(command);
		respond(message.id, command, data);
	};
	// A fixture-owned file gate holds only this RPC reply while stdin keeps accepting
	// commands. Tests release it explicitly to exercise both replacement completion orders.
	const replyWhenReleased = () => {
		if (typeof configured?.replyGate === "string"
			&& !existsSync(`${scenarioPath}.${configured.replyGate}`)) {
			const timer = setTimeout(() => {
				timers.delete(timer);
				replyWhenReleased();
			}, 10);
			timers.add(timer);
			return;
		}
		finish();
	};
	if (delayMs) {
		const timer = setTimeout(() => {
			timers.delete(timer);
			replyWhenReleased();
		}, delayMs);
		timers.add(timer);
	} else replyWhenReleased();
});

lines.on("close", () => {
	// pi exits when stdin closes; mirror that so shutdown is observable.
	for (const timer of timers) clearTimeout(timer);
	process.exit(0);
});

for (const [index, step] of (scenario.onStart ?? []).entries()) schedule(step, index);

// A UI request the scenario wants answered before the turn can continue.
for (const request of scenario.uiRequests ?? []) {
	const timer = setTimeout(() => {
		pendingUi.set(request.event.id, { onResponse: request.onResponse });
		emit(request.event);
	}, Number(request.delayMs ?? 0));
	timer.unref?.();
	timers.add(timer);
}
