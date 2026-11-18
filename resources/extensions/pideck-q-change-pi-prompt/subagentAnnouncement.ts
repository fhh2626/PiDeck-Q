/** Keep this sentence identical to the independently installable subagents extension. */
export const SUBAGENT_CALL_ANNOUNCEMENT_HINT =
	"Before each call to the subagent tool, first send the user one brief, visible assistant sentence in the conversation's language explaining what the call is about to do, then invoke the tool.";

/** Add the parent-facing rule without replacing persistent user prompt overrides. */
export function appendSubagentCallAnnouncementHint(systemPrompt: string, enabled: boolean): string {
	if (!enabled || systemPrompt.includes(SUBAGENT_CALL_ANNOUNCEMENT_HINT)) return systemPrompt;
	return systemPrompt.trim()
		? `${systemPrompt}\n\n${SUBAGENT_CALL_ANNOUNCEMENT_HINT}`
		: SUBAGENT_CALL_ANNOUNCEMENT_HINT;
}
