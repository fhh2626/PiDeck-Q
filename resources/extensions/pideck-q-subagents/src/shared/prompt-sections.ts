import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";

/** Older hosts may provide only the rendered prompt, so structured options remain optional. */
export type PromptAdditionEvent = Pick<BeforeAgentStartEvent, "systemPrompt"> & {
	systemPromptOptions?: Partial<Pick<BeforeAgentStartEvent["systemPromptOptions"], "sections" | "forceSystemPrompt">>;
};

/** Publish appended guidance separately while retaining the existing behavior for complete rewrites. */
export function publishPromptAddition(
	event: PromptAdditionEvent,
	systemPrompt: string,
	sectionName: string,
): { systemPrompt: string } | undefined {
	const original = event.systemPrompt;
	if (systemPrompt === original) return;
	const { sections, forceSystemPrompt } = event.systemPromptOptions ?? {};
	// A returned systemPrompt becomes opaque to later handlers. Keep stock Pi sections identifiable.
	if (!sections || forceSystemPrompt !== undefined || !systemPrompt.startsWith(original)) return { systemPrompt };
	const addition = systemPrompt.slice(original.length).trimStart();
	if (!addition) return { systemPrompt };
	let name = sectionName;
	let suffix = 2;
	// A caller may already use the preferred name. Its section must remain byte-for-byte intact.
	while (Object.hasOwn(sections, name)) name = `${sectionName}_${suffix++}`;
	sections[name] = addition;
	return;
}
