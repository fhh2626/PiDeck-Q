export interface ChildToolDiagnostic {
	agent?: string;
	required: string[];
	available: string[];
	missing: string[];
	missingMcpDirectTools?: string[];
}

/**
 * Explain missing child tools. Foreground children run inside the parent
 * process and never load the parent's ambient extensions. Direct MCP tools have
 * a session-local SDK provider; other extension tools need an explicit provider path.
 */
export function formatChildToolDiagnostic(diagnostic: ChildToolDiagnostic, options: { host?: "parent" | "runner" } = {}): string {
	const subject = diagnostic.agent ? `Agent '${diagnostic.agent}'` : "Subagent";
	if (options.host === "parent") {
		return [
			`${subject} ran as a foreground child, which never loads the parent's ambient extensions, and these child tools were unavailable: ${diagnostic.missing.join(", ")}.`,
			"The `tools` field is a strict allowlist; it does not load extension code.",
			...(diagnostic.missingMcpDirectTools?.length
				? [`MCP direct tools missing from the child registry: ${diagnostic.missingMcpDirectTools.join(", ")}.`]
				: []),
			"For direct MCP tools, verify the session-local server configuration, connection, and selected tool names. Foreground MCP tools are registered by the child SDK provider, not ambient extensions.",
			"For models from a provider extension, load that provider explicitly into the child.",
			"For extension tools a foreground child can load, add the provider path to `subagentOnlyExtensions` (child-only), `extensions`, or as a path-like entry in `tools`, while keeping each registered tool name in `tools`.",
		].join("\n");
	}
	return [
		`${subject} requested unavailable child tools: ${diagnostic.missing.join(", ")}.`,
		"The `tools` field is a strict allowlist; it does not load extension code.",
		...(diagnostic.missingMcpDirectTools?.length
			? [`Resolved MCP direct tools missing from the child registry: ${diagnostic.missingMcpDirectTools.join(", ")}. This indicates a host/pi-mcp-adapter registration problem, not a tool-call failure.`]
			: []),
		"For extension tools, add the provider path to `subagentOnlyExtensions` (child-only), `extensions`, or as a path-like entry in `tools`, while keeping each registered tool name in `tools`.",
		"For MCP tools, verify the MCP adapter configuration and selected tool names. For builtin tools, verify the name against the installed Pi version.",
	].join("\n");
}
