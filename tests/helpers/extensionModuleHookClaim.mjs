/**
 * Test helpers that rewrite extension imports (piFixtureResolver, subagentGraphLoader)
 * are mutually exclusive in one process: hooks run last-registered-first, so loading
 * both would silently change which one wins. Each claims this slot and the second
 * helper fails loudly. Kept side-effect free so claiming never installs a hook.
 */
const HOOK_OWNER_KEY = Symbol.for("pideck.tests.extensionModuleHook");

export function claimExtensionModuleHook(owner) {
	const current = globalThis[HOOK_OWNER_KEY];
	if (current !== undefined && current !== owner) {
		throw new Error(`Test module-resolution hooks "${current}" and "${owner}" are mutually exclusive in one process`);
	}
	globalThis[HOOK_OWNER_KEY] = owner;
}
