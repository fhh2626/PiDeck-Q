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

	const nodeOptions = next.NODE_OPTIONS;
	if (typeof nodeOptions === "string" && nodeOptions.trim()) {
		const tokens = nodeOptions.split(/\s+/).filter(Boolean);
		const safeTokens: string[] = [];
		for (let index = 0; index < tokens.length; index += 1) {
			const token = tokens[index];
			const lower = token.toLowerCase();
			const unsafe = lower.includes("electron")
				|| lower.includes("asar")
				|| lower.includes("app.asar")
				|| lower.includes("electron-vite");
			if (unsafe) continue;
			if ((token === "--require" || token === "-r") && index + 1 < tokens.length) {
				const required = tokens[index + 1].toLowerCase();
				if (required.includes("electron") || required.includes("asar") || required.includes("electron-vite")) {
					index += 1;
					continue;
				}
			}
			safeTokens.push(token);
		}
		const cleaned = safeTokens.join(" ").trim();
		if (cleaned) next.NODE_OPTIONS = cleaned;
		else delete next.NODE_OPTIONS;
	}

	return next;
}
