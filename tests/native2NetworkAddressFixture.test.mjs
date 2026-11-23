import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { constants } from "node:os";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const plain = (value) => JSON.parse(JSON.stringify(value));
const nodeRequire = createRequire(import.meta.url);
const fixtureCode = ts.transpileModule(readFileSync("tests/native2NetworkAddressParity.test.mjs", "utf8"), {
	fileName: "network-parity-fixture.ts",
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

/** Exercise the integration test's actual guards against controlled host capabilities. */
async function runFixture(addresses, { enumerationError, backendError, result } = {}) {
	const interfaces = { fixture0: addresses.map((address) => ({
		address, internal: false, family: "IPv4", cidr: `${address}/24`,
	})) };
	const skipped = [];
	let invoked = 0;
	let run;
	const stubs = {
		"node:os": { constants, networkInterfaces: () => {
			if (enumerationError) throw enumerationError;
			return interfaces;
		} },
		"node:test": { describe: (_name, body) => body(), test: (_name, body) => { run = body; } },
		// The test and Node oracle have separate VM prototypes. Compare their wire
		// values while preserving the integration test's exact fields and order.
		"node:assert/strict": new Proxy(assert, { get: (target, property) => property === "deepEqual"
			? (actual, expected) => assert.deepEqual(plain(actual), plain(expected))
			: Reflect.get(target, property) }),
		"./helpers/native2BackendHarness.mjs": {
			resolveBackendExecutable: () => "/controlled/backend",
			startBackendSession: async () => ({ invoke: async () => {
				invoked += 1;
				if (backendError) throw backendError;
				return { payload: { ok: true, result: result ?? addresses.map(address => ({ address, internal: false, interfaceName: "fixture0", cidr: `${address}/24`, isPrivate: address.startsWith("10.") || address.startsWith("192.168.") })).map(({internal, ...entry}) => entry).sort((a,b) => Number(b.isPrivate) - Number(a.isPrivate) || a.address.localeCompare(b.address, undefined, {numeric:true})) } };
			} }),
		},
	};
	vm.runInNewContext(fixtureCode, {
		exports: {}, require: (specifier) => Object.hasOwn(stubs, specifier) ? stubs[specifier] : nodeRequire(specifier),
	}, { filename: "native2NetworkAddressParity-controlled.mjs" });
	assert.equal(typeof run, "function");
	await run({ skip: (reason) => skipped.push(reason) });
	return { skipped, invoked };
}

for (const [name, addresses] of [
	["public-only", ["203.0.113.7"]],
	["private-only", ["10.0.0.7"]],
	["mixed", ["203.0.113.7", "10.0.0.7", "192.168.1.7"]],
]) {
	test(`network parity accepts an exact Node oracle response on a ${name} host`, async () => {
		assert.deepEqual(await runFixture(addresses), { skipped: [], invoked: 1 });
	});
}

test("network parity only skips independent interface permission failures", async () => {
	for (const code of ["EPERM", "EACCES"]) {
		const enumerationError = Object.assign(new Error("interface enumeration denied"), { code });
		const result = await runFixture([], { enumerationError });
		assert.equal(result.invoked, 0);
		assert.equal(result.skipped.length, 1);
		assert.match(result.skipped[0], /enumeration.*not exercised/);
	}
	const unexpected = Object.assign(new Error("interface enumeration failed"), { code: "EIO" });
	await assert.rejects(() => runFixture([], { enumerationError: unexpected }), (error) => error === unexpected);
});

test("network parity never turns a backend permission failure or mismatch into a capability skip", async () => {
	const backendError = Object.assign(new Error("backend RPC denied"), { code: "EPERM" });
	await assert.rejects(() => runFixture(["10.0.0.7"], { backendError }), (error) => error === backendError);
	await assert.rejects(() => runFixture(["10.0.0.7"], { result: [] }), { code: "ERR_ASSERTION" });
});
