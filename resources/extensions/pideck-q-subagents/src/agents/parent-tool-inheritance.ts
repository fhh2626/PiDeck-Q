/**
 * Parent-tool inheritance: resolves `tools: "parent"` agent overrides into a concrete
 * launch allowlist that mirrors the tools the launching (parent) session has active.
 *
 * Why this exists: omitting `tools` only gives a child Pi's normal builtins, and foreground
 * children never load ambient extensions, so extension tools the parent really uses (shells,
 * ask_question, todo, web_search, ...) would be missing. Here the parent's active tool names
 * become the strict allowlist and each tool's provider extension path is added to the agent's
 * `subagentOnlyExtensions`, which the launch plan already loads into the child (and de-duplicates
 * against providers the change-pi-prompt reconciler injected).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMcpSelectorsForActiveTools } from "../runs/shared/mcp-direct-tool-allowlist.ts";
import type { AgentConfig } from "./agents.ts";

/** Structural subset of pi's tool info; avoids coupling this pure module to the host SDK types. */
export interface ParentToolInfo {
	name: string;
	sourceInfo?: { path?: string; source?: string };
}

export interface ParentToolContext {
	/** Every registered tool, used only to find each active tool's provider extension. */
	allTools: readonly ParentToolInfo[];
	/** Final active tool names of the launching session (getActiveTools, never getAllTools). */
	activeToolNames: readonly string[];
	/** Root of this package; tools it provides are never copied into children. */
	ownPackageRoot?: string;
	/** Parent MCP direct tools expressed as `mcp:` selectors (adapter naming rules already applied). */
	mcpSelections?: readonly { name: string; selector: string }[];
}

export interface ParentToolSelection {
	/** Tool names for the strict child allowlist (`AgentConfig.tools`). */
	tools: string[];
	/** Provider extension paths the child must load for those tools (`subagentOnlyExtensions`). */
	extensionPaths: string[];
	/** `mcp:` direct-tool selectors (without the prefix) for the parent's MCP tools (AgentConfig.mcpDirectTools). */
	mcpDirectTools: string[];
	/** Active parent tools that were deliberately or unavoidably not copied, with the reason. */
	skipped: Array<{ name: string; reason: "excluded" | "subagent-owned" | "mcp-adapter" | "no-loadable-provider" }>;
}

// Coordination tools the child registers itself (native supervisor channel); child agents list
// the name, so it is kept even though the parent-side tool of the same name is ours.
const ALWAYS_KEPT_COORDINATION_TOOLS = ["contact_supervisor"] as const;
// Fan-out is governed by allowNestedSubagents and depth ceilings, never copied wholesale.
const NEVER_COPIED_TOOL_NAMES = new Set(["subagent"]);

/** Nearest ancestor directory holding a package.json; stable for both src/ and dist/ layouts. */
export function findOwnPackageRoot(fromDir: string = path.dirname(fileURLToPath(import.meta.url))): string | undefined {
	let dir = fromDir;
	for (;;) {
		if (fs.existsSync(path.join(dir, "package.json"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function isInside(root: string, candidate: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(candidate));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * The pi-mcp-adapter registers tools dynamically after connecting servers. Loading it as a plain
 * provider cannot guarantee those names exist, and a missing name aborts the whole launch under the
 * strict allowlist. Direct MCP tools therefore travel as `mcp:` selectors (see `mcpSelections`), which
 * the launch plan resolves against the adapter's config and metadata cache; anything left over from
 * the adapter (e.g. the `mcp` proxy tool) is not copied.
 */
function isMcpAdapterPath(providerPath: string): boolean {
	return providerPath.replace(/\\/g, "/").toLowerCase().includes("/pi-mcp-adapter");
}

/** The two session APIs this module needs; satisfied structurally by pi's ExtensionAPI. */
export interface ParentToolHost {
	getAllTools(): readonly ParentToolInfo[];
	getActiveTools(): readonly string[];
}

/** Snapshot the launching session's tools; undefined when the host cannot report them. */
export function readParentToolContext(host: ParentToolHost, cwd: string = process.cwd()): ParentToolContext | undefined {
	try {
		const activeToolNames = host.getActiveTools();
		return {
			allTools: host.getAllTools(),
			activeToolNames,
			ownPackageRoot: findOwnPackageRoot(),
			mcpSelections: resolveMcpSelectorsForActiveTools(activeToolNames, cwd),
		};
	} catch {
		// A stale/unbound session may throw; the caller fails closed instead of widening the child.
		return undefined;
	}
}

/**
 * Pure selection rule: which of the parent's active tools a child may receive, and which
 * provider extensions must load for them. Anything that cannot be provided is skipped rather
 * than listed, because an allowlisted-but-unregistered tool fails the launch.
 *
 * `excludeTools` is the blacklist: excluded names are dropped before anything else, and a provider
 * extension is loaded only when at least one non-excluded tool still needs it.
 */
export function selectParentTools(context: ParentToolContext, excludeTools: readonly string[] = []): ParentToolSelection {
	const excluded = new Set(excludeTools.map((name) => name.trim()).filter(Boolean));
	const byName = new Map(context.allTools.map((tool) => [tool.name, tool]));
	const names: string[] = [];
	const providerPaths: string[] = [];
	const mcpDirectTools: string[] = [];
	const mcpByName = new Map((context.mcpSelections ?? []).map((selection) => [selection.name, selection.selector]));
	const skipped: ParentToolSelection["skipped"] = [];

	for (const name of new Set(context.activeToolNames)) {
		if (excluded.has(name)) {
			skipped.push({ name, reason: "excluded" });
			continue;
		}
		if (NEVER_COPIED_TOOL_NAMES.has(name)) {
			skipped.push({ name, reason: "subagent-owned" });
			continue;
		}
		if ((ALWAYS_KEPT_COORDINATION_TOOLS as readonly string[]).includes(name)) {
			names.push(name);
			continue;
		}
		const mcpSelector = mcpByName.get(name);
		if (mcpSelector !== undefined) {
			if (!mcpDirectTools.includes(mcpSelector)) mcpDirectTools.push(mcpSelector);
			continue;
		}
		const info = byName.get(name);
		const source = info?.sourceInfo?.source;
		const providerPath = info?.sourceInfo?.path;
		if (source === "builtin") {
			names.push(name);
			continue;
		}
		if (!providerPath || !path.isAbsolute(providerPath) || !fs.existsSync(providerPath)) {
			skipped.push({ name, reason: "no-loadable-provider" });
			continue;
		}
		if (context.ownPackageRoot && isInside(context.ownPackageRoot, providerPath)) {
			skipped.push({ name, reason: "subagent-owned" });
			continue;
		}
		if (isMcpAdapterPath(providerPath)) {
			skipped.push({ name, reason: "mcp-adapter" });
			continue;
		}
		names.push(name);
		if (!providerPaths.includes(providerPath)) providerPaths.push(providerPath);
	}
	// Coordination tools may be absent from a headless parent; children still need the name.
	for (const name of ALWAYS_KEPT_COORDINATION_TOOLS) {
		if (!excluded.has(name) && !names.includes(name)) names.push(name);
	}
	return { tools: names, extensionPaths: providerPaths, mcpDirectTools, skipped };
}

/**
 * Resolve every agent flagged with `inheritParentTools` against the launching session's tools.
 * Unflagged agents are returned untouched (same object), so the common path costs nothing.
 * When the parent's tool list is unavailable the flagged agent gets an empty allowlist: failing
 * closed beats silently widening a child to the default builtin set.
 */
export function applyParentToolInheritance(
	agents: AgentConfig[],
	readContext: () => ParentToolContext | undefined,
): AgentConfig[] {
	if (!agents.some((agent) => agent.inheritParentTools === true)) return agents;
	const context = readContext();
	return agents.map((agent) => {
		if (agent.inheritParentTools !== true) return agent;
		// The blacklist is per agent, so each flagged agent gets its own selection.
		const selection = context ? selectParentTools(context, agent.excludeTools) : undefined;
		const { inheritParentTools: _resolved, ...rest } = agent;
		const next: AgentConfig = { ...rest, tools: selection ? [...selection.tools] : [] };
		delete next.mcpDirectTools;
		if (selection && selection.mcpDirectTools.length > 0) next.mcpDirectTools = [...selection.mcpDirectTools];
		if (selection && selection.extensionPaths.length > 0) {
			next.subagentOnlyExtensions = [...new Set([...(agent.subagentOnlyExtensions ?? []), ...selection.extensionPaths])];
		}
		return next;
	});
}
