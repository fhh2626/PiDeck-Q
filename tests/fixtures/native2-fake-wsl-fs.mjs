// Scriptable fake `wsl` with a real filesystem behind a Linux path prefix.
//
// The startup-task and WSL-scan suites must never depend on a real distribution, so this
// shim maps the configured Linux home onto a temporary directory on the host and answers
// the exact commands the backend issues. Anything it does not model exits 2 so a broken
// expectation fails loudly instead of returning an empty result.
//
// Scenario file (`FAKE_WSL_SCENARIO`): { root, linuxHome, home, homeExit, distros }
//   root      - host directory that backs `linuxHome`
//   linuxHome - absolute Linux home the shim accepts (default /home/dev)
//   home      - answer for `printenv HOME` (defaults to linuxHome when omitted)
//   homeExit  - exit code for `printenv HOME` (non-zero exercises the fallback)
//   homeDelayMs - delay before answering `printenv HOME`, so a suite can hold one WSL
//                 resolution in flight while a newer settings:update arrives
//   listDelayMs - delay before answering `wsl -l -q`, so a suite can hold the serial domain
//                 executor busy while a WSL switch is requested
//   distros   - answer for `wsl -l -q`
// Batch-scan knobs (the scanner's NUL envelopes):
//   statBatch      - "fail" makes the `stat --printf` batch exit 1 (per-file fallback)
//   statCorrupt    - the batch prints one non-numeric `%Y` record, so the whole envelope
//                    must be rejected and every path re-statted individually
//   statHugeSuffix - path suffix whose stat reports a 1e308 mtime (unrepresentable in
//                    qint64; the reader must reject it instead of casting UB)
//   statSkipSuffix - path suffix the batch envelope omits *and* the per-file stat fails
//                    for, emulating a file that disappeared between `find` and `stat`
//   bodyStallFile  - path suffix that makes the `sh -c` body batch print a header and
//                    then hang, emulating a stalled cat killed by the reader's timeout
//   bodyStallMs    - how long to hang (default 5000)
//   bodyStallPartial - partial body bytes printed before hanging (default "")
//   logTiming      - append `{pid,start,end,argv}` to `FAKE_WSL_TIMING_LOG` on exit, so a
//                    suite can prove the reader never runs more than four children
// Every invocation is appended to `FAKE_WSL_LOG` (argv only, never file contents).
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join, posix } from "node:path";

const scenarioPath = process.env.FAKE_WSL_SCENARIO ?? "";
const logPath = process.env.FAKE_WSL_LOG ?? "";
const timingPath = process.env.FAKE_WSL_TIMING_LOG ?? "";
const scenario = scenarioPath && existsSync(scenarioPath) ? JSON.parse(readFileSync(scenarioPath, "utf8")) : {};
const argv = process.argv.slice(2);
if (logPath) appendFileSync(logPath, `${JSON.stringify({ argv })}\n`);
if (scenario.logTiming && timingPath) {
	const startedAt = Date.now();
	// One record per child lifetime: the suite derives in-flight overlap from these spans.
	process.on("exit", () => appendFileSync(timingPath, `${JSON.stringify({ pid: process.pid, start: startedAt, end: Date.now(), argv })}\n`));
}

/** Write stdout unbuffered: a killed batch must still have emitted its complete prefix. */
function emit(chunk) {
	writeSync(1, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
}

const linuxHome = scenario.linuxHome ?? "/home/dev";
const root = scenario.root ?? "";

function fail(message) {
	process.stderr.write(`${message}\n`);
	process.exit(2);
}

/** Map an accepted Linux path onto the backing directory; anything else is a bug. */
function toHost(linuxPath) {
	if (!linuxPath || !linuxPath.startsWith("/")) fail(`not an absolute path: ${linuxPath}`);
	if (!root) fail("no backing root configured");
	if (linuxPath === linuxHome || linuxPath.startsWith(`${linuxHome}/`)) {
		const suffix = linuxPath.slice(linuxHome.length).replace(/^\/+/, "");
		// Windows path joining collapses '..' before traversing junctions. Model Linux
		// component traversal explicitly for the symlink/.. ownership regression.
		if (suffix.split("/").includes("..")) {
			let current = root;
			const parts = suffix.split("/");
			for (let index = 0; index < parts.length; index++) {
				const part = parts[index];
				if (!part || part === ".") continue;
				if (part === "..") current = dirname(current);
				else {
					current = join(current, part);
					if (index < parts.length - 1 && existsSync(current)) current = realpathSync.native(current);
				}
			}
			return current;
		}
		return join(root, suffix);
	}
	fail(`path outside the fake home: ${linuxPath}`);
}

function toLinux(hostPath) {
	const relative = hostPath.slice(root.length).replace(/^[\\/]+/, "");
	return relative ? posix.join(linuxHome, relative.split("\\").join("/")) : linuxHome;
}

function walk(directory, out, filter) {
	if (!existsSync(directory)) return;
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const full = join(directory, entry.name);
		if (entry.isDirectory()) walk(full, out, filter);
		else if (filter(full)) out.push(toLinux(full));
	}
}

// `wsl -l -q` carries no `-d/-u` prefix, so it is answered before the prefix is required.
if (argv.includes("-l")) {
	const listDelayMs = Number(scenario.listDelayMs ?? 0);
	if (listDelayMs > 0) {
		// The channel answers from the serial domain executor, so a bounded sleep here models
		// a slow `wsl.exe` and pins the executor's FIFO ordering for the caller.
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, listDelayMs);
	}
	for (const distro of scenario.distros ?? []) process.stdout.write(`${distro}\n`);
	process.exit(Number(scenario.listExit ?? 0));
}

// Strip the `-d <distro> -u <user>` prefix the backend always sends.
const userIndex = argv.indexOf("-u");
if (userIndex < 0) fail(`missing -u in ${argv.join(" ")}`);
const inner = argv.slice(userIndex + 2);
// Runtime launches also carry WSL's cwd option before the executable.
const command = inner[0] === "--cd" ? inner.slice(2) : inner;

const [verb, ...rest] = command;
switch (verb) {
	case "--exec": {
		// `wsl -d D -u U --exec printenv HOME`
		if (rest[0] !== "printenv" || rest[1] !== "HOME") fail(`unsupported exec: ${rest.join(" ")}`);
		if (Number(scenario.homeExit ?? 0) !== 0) {
			process.stderr.write("printenv: HOME unavailable\n");
			process.exit(Number(scenario.homeExit));
		}
		const homeDelayMs = Number(scenario.homeDelayMs ?? 0);
		if (homeDelayMs > 0) {
			// A cold distro holds the probe for seconds in production; the suite uses a bounded
			// sleep instead of a real boot so the latest-request guard is deterministic.
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, homeDelayMs);
		}
		process.stdout.write(`${scenario.home ?? linuxHome}\n`);
		process.exit(0);
	}
	case "whoami":
		process.stdout.write(`${scenario.whoami ?? "dev"}\n`);
		process.exit(0);
	case "which":
		if (scenario.which) process.stdout.write(`${scenario.which}\n`);
		process.exit(scenario.which ? 0 : 1);
	case "pi":
		if (rest[0] === "--version" && (scenario.piVersion || scenario.runtimePi)) {
			process.stdout.write(`${scenario.piVersion ?? "0.79.0"}\n`);
			process.exit(0);
		}
		if (scenario.runtimePi) {
			const { runFakeWslRuntime } = await import("./native2-fake-wsl-runtime.mjs");
			runFakeWslRuntime(scenario, argv, logPath);
			break;
		}
		process.exit(1);
	case "realpath": {
		// Model coreutils -m with the real backing filesystem, including links and
		// missing suffixes. Authorization decisions remain in production C++.
		if (!["-m", "-e"].includes(rest[0]) || rest[1] !== "--") fail("unsupported realpath options");
		if (rest[0] === "-e" && !existsSync(toHost(rest[2]))) process.exit(1);
		if (scenario.realpathDelayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(scenario.realpathDelayMs));
		let current = toHost(rest[2]);
		const suffix = [];
		while (!existsSync(current)) {
			suffix.unshift(basename(current));
			const parent = dirname(current);
			if (parent === current) process.exit(1);
			current = parent;
		}
		process.stdout.write(`${toLinux(join(realpathSync.native(current), ...suffix))}\n`);
		process.exit(0);
	}
	case "test": {
		const [flag, target] = rest;
		if (scenario.failTestPath === target && scenario.failTestFlag === flag) fail("probe failed");
		const host = toHost(target);
		if (flag === "-L") {
			let linked = false;
			try { linked = lstatSync(host).isSymbolicLink(); } catch (error) {
				if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
			}
			process.exit(linked ? 0 : 1);
		}
		const exists = existsSync(host);
		const stats = exists ? statSync(host) : null;
		const ok = flag === "-e" ? exists : flag === "-f" ? Boolean(stats?.isFile()) : flag === "-d" ? Boolean(stats?.isDirectory()) : fail(`unsupported test flag: ${flag}`);
		process.exit(ok ? 0 : 1);
	}
	case "ls": {
		const directory = rest.at(-1);
		if (scenario.failListPath === directory) fail("listing denied");
		const host = toHost(directory);
		if (!existsSync(host)) process.exit(1);
		for (const name of readdirSync(host)) process.stdout.write(`${name}\n`);
		process.exit(0);
	}
	case "cat": {
		const host = toHost(rest[0]);
		if (!existsSync(host)) process.exit(1);
		process.stdout.write(readFileSync(host));
		process.exit(0);
	}
	case "head": {
		// `head -c <n> -- <path>`
		const separator = rest.indexOf("--");
		const bytes = Number(rest[rest.indexOf("-c") + 1]);
		const host = toHost(rest[separator + 1]);
		if (!existsSync(host)) process.exit(1);
		process.stdout.write(readFileSync(host).subarray(0, bytes));
		process.exit(0);
	}
	case "stat": {
		if (rest[0] === "-Lc" && rest[1] === "%d:%i") {
			const info = statSync(toHost(rest.at(-1)), { bigint: true });
			process.stdout.write(`${info.dev}:${info.ino}\n`);
			process.exit(0);
		}
		const printfIndex = rest.indexOf("--printf");
		if (printfIndex >= 0) {
			// `stat --printf '%n\0%Y\0%s\0' -- <paths…>`: the batched metadata envelope.
			if (scenario.statBatch === "fail") {
				process.stderr.write("stat: batch unavailable\n");
				process.exit(1);
			}
			const separator = rest.lastIndexOf("--");
			const records = [];
			let first = true;
			for (const target of rest.slice(separator + 1)) {
				const host = toHost(target);
				// A vanished file contributes no record; the caller falls back per file.
				if (!existsSync(host) || (scenario.statSkipSuffix && target.endsWith(scenario.statSkipSuffix))) continue;
				const stats = statSync(host);
				// One malformed record must invalidate the whole envelope; the reader then
				// re-stats every path instead of half-trusting the batch.
				const time = scenario.statCorrupt && first
					? "not-a-number"
					: scenario.statHugeSuffix && target.endsWith(scenario.statHugeSuffix)
						? "1e308"
						: `${Math.floor(stats.mtimeMs / 1000)}`;
				first = false;
				records.push(
					Buffer.from(target),
					Buffer.from([0]),
					Buffer.from(time),
					Buffer.from([0]),
					Buffer.from(`${stats.size}`),
					Buffer.from([0]),
				);
			}
			emit(Buffer.concat(records));
			process.exit(0);
		}
		const host = toHost(rest.at(-1));
		if (!existsSync(host) || (scenario.statSkipSuffix && rest.at(-1).endsWith(scenario.statSkipSuffix))) process.exit(1);
		const stats = statSync(host);
		// Per-file fallback: `stat -c "%Y %s"`.
		const time = scenario.statHugeSuffix && rest.at(-1).endsWith(scenario.statHugeSuffix)
			? "1e308"
			: `${Math.floor(stats.mtimeMs / 1000)}`;
		process.stdout.write(`${time} ${stats.size}\n`);
		process.exit(0);
	}
	case "sh": {
		if (rest[0] === "-c" && rest[1].includes("# pideck-root-pin-v1")) {
			if (scenario.rootPinFailure) fail("root pin failed");
			const info = statSync(toHost(rest[3]), { bigint: true });
			emit(`pideck-root-v1\t${process.pid}\t1\t${info.dev}:${info.ino}\n`);
			// The native launcher forwards stdin unchanged. EOF must reap this holder,
			// including failure during C++ planning; never detach a fake child.
			await new Promise((resolve) => { process.stdin.once("end", resolve); process.stdin.once("error", resolve); process.stdin.resume(); });
			process.exit(0);
		}
		if (rest[0] === "-c" && rest[1].includes("# pideck-scoped-trash-v1")) {
			if (scenario.safeTrashUnavailable) process.exit(42);
			const { runFakeScopedTrash } = await import("./native2-fake-wsl-trash.mjs");
			runFakeScopedTrash(rest[3], rest[4], rest.slice(7), toHost);
			process.exit(0);
		}
		if (rest[0] === "-c" && rest[2] === "pideck-delete-identities") {
			// Model the constant identity script, including strict existing ancestors,
			// missing leaves, and a process-level failure seam. All data is temporary.
			if (scenario.identityDelayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(scenario.identityDelayMs));
			if (scenario.identityFailure) fail("identity resolution failed");
			for (const target of rest.slice(3)) {
				const host = toHost(target);
				let canonical = "";
				try { canonical = toLinux(realpathSync.native(host)); }
				catch {
					try {
						const parent = realpathSync.native(dirname(host));
						let linked = false;
						try { linked = lstatSync(host).isSymbolicLink(); } catch { /* missing ordinary leaf */ }
						if (!linked) canonical = toLinux(join(parent, basename(host)));
					} catch { /* an unknown ancestor is not a trustworthy identity */ }
				}
				if (scenario.identityCanonicalOverrides?.[target]) canonical = scenario.identityCanonicalOverrides[target];
				// Model POSIX command substitution too: plain $(realpath ...) strips all
				// trailing newlines, while the production sentinel preserves the exact name.
				if (!rest[1].includes("&& printf .")) canonical = canonical.replace(/\n+$/, "");
				// Empty identity models EACCES/unknown ancestry, never an absent file.
				if (scenario.identityUnresolvedPrefix && target.startsWith(scenario.identityUnresolvedPrefix)) canonical = "";
				emit(`${target}\0${canonical}\0`);
			}
			process.exit(0);
		}
		// `sh -c <read script> pideck-scan-read <paths…>`: the batched body envelope.
		if (rest[0] !== "-c" || rest[2] !== "pideck-scan-read") fail(`unsupported sh: ${rest.join(" ")}`);
		const stallFile = scenario.bodyStallFile ?? "";
		const stallMs = Number(scenario.bodyStallMs ?? 5_000);
		const stallPartial = String(scenario.bodyStallPartial ?? "");
		for (const target of rest.slice(3)) {
			const host = toHost(target);
			if (stallFile && target.endsWith(stallFile)) {
				emit(Buffer.concat([Buffer.from(target), Buffer.from([0]), Buffer.from(stallPartial)]));
				// Block the child past the reader's per-command timeout so the parent kills it
				// and the partial prefix is all the scan ever sees for this file.
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stallMs);
				process.exit(0);
			}
			const body = existsSync(host) ? readFileSync(host) : Buffer.alloc(0);
			emit(
				Buffer.concat([
					Buffer.from(target),
					Buffer.from([0]),
					body,
					Buffer.from([0]),
					Buffer.from(existsSync(host) ? "0" : "1"),
					Buffer.from([0]),
				]),
			);
		}
		process.exit(0);
	}
	case "mkdir": {
		for (const target of rest.filter((value) => !value.startsWith("-"))) {
			mkdirSync(toHost(target), { recursive: true });
		}
		process.exit(0);
	}
	case "rm": {
		const target = rest.at(-1);
		rmSync(toHost(target), { force: true, recursive: true });
		process.exit(0);
	}
	case "mv": {
		const [from, to] = rest.filter((value) => !value.startsWith("-"));
		const source = toHost(from);
		const destination = toHost(to);
		if (rest.includes("-n") && existsSync(destination)) process.exit(0);
		renameSync(source, destination);
		process.exit(0);
	}
	case "dd": {
		// `dd of=<path> bs=1M`: content arrives on stdin.
		const target = rest.find((value) => value.startsWith("of="));
		if (!target) fail("dd without of=");
		const bytes = readFileSync(0);
		writeFileSync(toHost(target.slice(3)), bytes);
		process.exit(0);
	}
	case "find": {
		const base = rest[0];
		const files = [];
		walk(toHost(base), files, (host) => host.endsWith(".jsonl"));
		for (const file of files) process.stdout.write(`${file}\n`);
		process.exit(0);
	}
	default:
		fail(`unsupported wsl command: ${command.join(" ")}`);
}
