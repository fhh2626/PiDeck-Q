/** Session-local MCP provider for foreground children; the SDK owns transport and lifecycle. */
import type { ExtensionAPI, McpExtensionOptions, McpServerConfig, McpServerEntry } from "@earendil-works/pi-coding-agent";
import type { ChildHookExtension } from "./child-hooks.ts";
import { resolveMcpServerLaunchDefinition, type McpConfig, type ResolvedMcpDirectToolSelection } from "./mcp-direct-tool-allowlist.ts";
import type { McpServerDefinition } from "./mcp-config-sources.ts";

/** Escape a materialized secret so the SDK cannot interpolate it again or treat it as a command. */
function sdkLiteral(value: string): string {
	const escaped = value.replace(/\$/g, () => "$$");
	return escaped.startsWith("!") ? `$!${escaped.slice(1)}` : escaped;
}

/** Keep configured command expressions, but escape literal values after adapter-style interpolation. */
function sdkSecrets(original: Record<string, string> | undefined, resolved: Record<string, string> | undefined): Record<string, string> {
	return Object.fromEntries(Object.entries(resolved ?? {}).map(([key, value]) => [key,
		original?.[key]?.startsWith("!") && !original[key].startsWith("!!") ? value : sdkLiteral(value),
	]));
}

/** Translate only representable adapter settings; never silently change an unsupported transport/auth policy. */
function serverConfig(name: string, original: McpServerDefinition, tools: readonly string[]): McpServerConfig {
	const definition = resolveMcpServerLaunchDefinition(original);
	for (const key of ["socket", "requestHeadersCommand", "protocolVersion", "pluginDataDir"] as const) {
		if (definition[key] !== undefined) throw new Error(`Foreground MCP server '${name}' uses unsupported setting '${key}'.`);
	}
	if (definition.literalEnv || definition.auth === false || (definition.httpTransport && definition.httpTransport !== "streamable-http")) {
		throw new Error(`Foreground MCP server '${name}' uses an unsupported environment, authentication, or HTTP transport policy.`);
	}
	// Hidden by default: a newly added server tool must not escape the parent's active-tool ceiling.
	const toolExposure: Record<string, "direct"> = {};
	for (const tool of tools) toolExposure[tool] = "direct";
	const exposure = "hidden";
	if (definition.url) {
		const headers = sdkSecrets(original.headers, definition.headers);
		const token = definition.bearerToken;
		if (definition.auth === "bearer" || definition.bearerTokenEnv || definition.bearerToken) {
			if (!token) throw new Error(`Foreground MCP server '${name}' is missing its configured bearer credential.`);
			if (original.bearerToken?.startsWith("!") && !original.bearerToken.startsWith("!!")) {
				throw new Error(`Foreground MCP server '${name}' uses an unsupported bearer credential command.`);
			}
			headers.Authorization = sdkLiteral(`Bearer ${token}`);
		}
		return { type: "http", url: definition.url, headers, exposure, toolExposure };
	}
	if (!definition.command) throw new Error(`Foreground MCP server '${name}' has no supported command or URL.`);
	return {
		type: "stdio", command: definition.command,
		...(definition.args ? { args: [...definition.args] } : {}),
		...(definition.env ? { env: sdkSecrets(original.env, definition.env) } : {}),
		...(definition.cwd ? { cwd: definition.cwd } : {}),
		exposure, toolExposure,
	};
}

/**
 * Install the official MCP extension with an immutable per-launch server/selection snapshot.
 * Only its selected tool definitions are registered, renamed to the adapter names already in the
 * child's strict allowlist. No ambient MCP config, management command, or process-global env is used.
 */
export function createForegroundMcpHook(
	config: McpConfig,
	selections: readonly ResolvedMcpDirectToolSelection[],
	options: Pick<McpExtensionOptions, "createTransport" | "logPath"> = {},
): ChildHookExtension {
	const selected = new Map(selections.map((selection) => [selection.selector, selection.name]));
	const serverTools = new Map<string, string[]>();
	for (const { selector } of selections) {
		const slash = selector.indexOf("/");
		if (slash < 1 || slash === selector.length - 1) throw new Error("Foreground MCP requires resolved server/tool selectors.");
		const server = selector.slice(0, slash);
		const tools = serverTools.get(server) ?? [];
		tools.push(selector.slice(slash + 1));
		serverTools.set(server, tools);
	}
	const servers: McpServerEntry[] = [...serverTools].map(([name, tools]) => {
		const definition = config.mcpServers[name];
		if (!definition) throw new Error(`Foreground MCP server '${name}' has no configuration snapshot.`);
		return { name, config: serverConfig(name, definition, tools), source: "pi-subagents:foreground-mcp", scope: "extension" };
	});
	return {
		name: "pi-subagents:foreground-mcp",
		factory: async (pi) => {
			const { createMcpExtension } = await import("@earendil-works/pi-coding-agent");
			if (typeof createMcpExtension !== "function") throw new Error("Foreground MCP requires a Pi SDK with public createMcpExtension support.");
			const registerTool: ExtensionAPI["registerTool"] = (tool) => {
				// The SDK labels server tools with their unsanitized server/tool identity. Using that
				// identity avoids reproducing its private truncation/hash naming implementation.
				const name = selected.get(tool.label);
				if (name && tool.name.startsWith("mcp__")) pi.registerTool({ ...tool, name });
			};
			const api: ExtensionAPI = {
				...pi,
				registerTool,
				getMcpServers: () => [],
				// Child sessions cannot change the config/selection or install a second MCP UI.
				registerCommand: () => {},
				registerToolRenderer: () => {},
			};
			await createMcpExtension({
				...options,
				loadConfig: () => ({ servers, errors: [], autoEnableCodemode: false }),
			})(api);
		},
	};
}
