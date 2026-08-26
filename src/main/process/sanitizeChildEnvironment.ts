/**
 * Remove desktop-host-only environment values before spawning any child process.
 * The native sidecar needs these values to reach Qt, but terminal, Pi, and helper
 * processes must not be able to inherit the host RPC credential or bridge address.
 */
export function sanitizeChildEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const next: NodeJS.ProcessEnv = { ...environment };
	const privateKeys = [
		"PIDECK_HOST_TOKEN",
		"PIDECK_HOST_PORT",
		"PIDECK_NATIVE_HOST",
		"PIDECK_RENDERER_ROOT",
		"PIDECK_NATIVE_NODE_ENTRY",
	];
	for (const key of privateKeys) delete next[key];

	for (const key of Object.keys(next)) {
		if (key.startsWith("ELECTRON_") || key === "ELECTRON_RUN_AS_NODE") {
			delete next[key];
			continue;
		}
		if (key.startsWith("CHROME_") || key.startsWith("GOOGLE_API_")) {
			delete next[key];
		}
	}

	// NODE_OPTIONS accepts shell-like quoting and escaped paths. Re-tokenizing it
	// here can corrupt valid arguments, so child processes receive no inherited
	// Node bootstrap options at all.
	delete next.NODE_OPTIONS;

	return next;
}
