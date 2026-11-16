import assert from "node:assert/strict";
import { isIPv4 } from "node:net";
import { constants, networkInterfaces } from "node:os";
import { describe, test } from "node:test";

import { resolveBackendExecutable, startBackendSession } from "./helpers/native2BackendHarness.mjs";

/**
 * `app:network-addresses` parity against the live Node oracle (native2).
 *
 * Oracle: `src/main/web/WebNetwork.ts` (`listWebNetworkAddresses`). The documented
 * residual (§29.6/§30.4) said an element-wise comparison was impossible because Qt's
 * `QNetworkInterface::allInterfaces()` also reports down adapters that
 * `os.networkInterfaces()` filters out — and that extra `192.168.x` entry could win the
 * "private first" sort and point the phone QR code at an unreachable address. The backend
 * now skips non-operational interfaces, so the two lists must be identical, including the
 * contract order. This suite computes the oracle list from the same machine and compares
 * it field by field, so a divergence (a new adapter shape, a lost filter) fails loudly
 * instead of silently degrading to a shape-only assertion.
 */

const executable = resolveBackendExecutable();

/** `isPrivateIpv4` from the oracle (10/8, 172.16/12, 192.168/16 only). */
function isPrivateIpv4(address) {
	const parts = address.split(".").map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
	const [first, second] = parts;
	return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

/** The oracle's own enumeration + ordering, re-implemented from `WebNetwork.ts`. */
function oracleAddresses() {
	const addresses = [];
	const seen = new Set();
	for (const [interfaceName, entries] of Object.entries(networkInterfaces())) {
		for (const entry of entries ?? []) {
			const address = entry.address.trim();
			if (!isIPv4(address) || entry.internal || seen.has(address)) continue;
			seen.add(address);
			addresses.push({
				address,
				interfaceName,
				cidr: typeof entry.cidr === "string" ? entry.cidr : null,
				isPrivate: isPrivateIpv4(address),
			});
		}
	}
	return addresses.sort((left, right) => {
		if (left.isPrivate !== right.isPrivate) return left.isPrivate ? -1 : 1;
		return left.address.localeCompare(right.address, undefined, { numeric: true });
	});
}

if (!executable) {
	describe("native2 app:network-addresses parity", () => {
		test("backend executable is available", () => {
			assert.fail("PiDeckBackend.exe was not built; run xmake build -y PiDeckBackend");
		});
	});
} else {
	describe("native2 app:network-addresses parity", () => {
		test("matches the Node oracle element by element, including the contract order", async (t) => {
			let expected;
			try {
				expected = oracleAddresses();
			} catch (error) {
				// Some sandboxes deny interface enumeration itself. This does not establish
				// address parity, so report a capability skip before starting the backend.
				// All other enumeration errors and all backend mismatches must still fail.
				const permissionCode = error?.code === "EPERM" || error?.code === "EACCES";
				const errno = Math.abs(error?.info?.errno ?? error?.errno ?? 0);
				const deniedEnumeration = error?.syscall === "uv_interface_addresses"
					&& [constants.errno.EPERM, constants.errno.EACCES].includes(errno);
				if (permissionCode || deniedEnumeration) {
					t.skip("Environment denies network-interface enumeration; live address parity was not exercised");
					return;
				}
				throw error;
			}
			// A machine without a non-loopback IPv4 adapter cannot prove anything; that is a
			// capability skip, not a pass.
			if (expected.length === 0) {
				t.skip("no non-loopback IPv4 interface on this machine");
				return;
			}
			const session = await startBackendSession(t, { projects: [] });
			const response = await session.invoke("app:network-addresses", []);
			assert.equal(response.payload.ok, true, JSON.stringify(response.payload));
			const actual = response.payload.result;
			assert.deepEqual(actual, expected);
			// The contract itself: private networks first, otherwise numeric-aware order.
			// A public-only host is valid. Private addresses lead when the host has any.
			assert.equal(actual[0].isPrivate, expected.some((address) => address.isPrivate), JSON.stringify(actual));
			for (let index = 1; index < actual.length; index += 1) {
				if (!actual[index].isPrivate) continue;
				assert.equal(actual[index - 1].isPrivate, true,
					`a private address must not follow a public one: ${JSON.stringify(actual)}`);
			}
		});
	});
}
