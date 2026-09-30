/**
 * 会话 JSONL entryId 对齐与重发截断的纯函数。
 * 抽离出 AgentManager 以便单测覆盖「空 assistant 不消费 slot」这类错位回归。
 */

/**
 * 从活动分支构建「与 pi get_messages 对齐」的 message entryId 列表（root→leaf）。
 *
 * 为什么不能直接用整条活动分支：pi 压缩（compaction）之后 get_messages 只返回
 * 「压缩摘要 + firstKeptEntryId 起的保留消息」，而 get_entries 的活动分支仍包含压缩前的
 * 归档消息。若按整条分支从头与 get_messages 配对，运行时窗口里的可见消息会被绑到归档条目上，
 * 删除/编辑/重发就落到错误轮次（角色不符时报 SESSION_ENTRY_ROLE_INVALID，角色相符时静默改错消息）。
 *
 * 规则：
 * - 无压缩：活动分支上全部 type==="message"。
 * - 有压缩：只取「最靠近叶子的那条 compaction」的 firstKeptEntryId（含）之后的 message；
 *   更早的压缩不再影响对齐（get_messages 只看最后一次压缩的上下文）。
 * - 锚点缺失或不在这条活动分支上：返回 []（宁可退化成「无 entryId」走文件/序列定位，
 *   也不能退回全量列表把 id 绑错）。
 * - 只按 type 过滤：toolResult 也是 message 条目，漏掉它会让其后的 entryId 整体错位。
 */
export type BranchEntryRef = {
	id: string;
	parentId: string | null;
	type?: string;
	firstKeptEntryId?: string;
};

export function buildActiveBranchEntryIds(
	entries: readonly BranchEntryRef[],
	leafId: string,
): string[] {
	const entryById = new Map<string, BranchEntryRef>();
	for (const entry of entries) {
		if (entry && typeof entry.id === "string") entryById.set(entry.id, entry);
	}

	// 从 leafId 沿 parentId 回溯到 root；seen 兼作环检测（坏数据不能让这里死循环）
	const branch: BranchEntryRef[] = [];
	const seen = new Set<string>();
	let currentId: string | null = leafId;
	while (currentId && !seen.has(currentId)) {
		seen.add(currentId);
		const entry = entryById.get(currentId);
		branch.unshift(entry ?? { id: currentId, parentId: null });
		currentId = entry?.parentId ?? null;
	}

	const isMessage = (entry: BranchEntryRef): boolean => entry.type === "message";
	// 取活动分支上最靠近叶子的压缩点，而不是输入顺序里的最后一条
	let compactionIndex = -1;
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		if (branch[index]?.type === "compaction") {
			compactionIndex = index;
			break;
		}
	}
	if (compactionIndex < 0) {
		return branch.filter(isMessage).map((entry) => entry.id);
	}

	const anchorId = branch[compactionIndex]?.firstKeptEntryId;
	if (typeof anchorId !== "string" || anchorId.length === 0) return [];
	const anchorIndex = branch.findIndex((entry) => entry.id === anchorId);
	if (anchorIndex < 0) return [];
	// 锚点等于压缩条目自身时表示「保留段已被删光」：compaction 不是 message，
	// 结果只含它之后的 message（与 SessionFileEditor 的 firstKeptEntryId 语义一致）。
	return branch.slice(anchorIndex).filter(isMessage).map((entry) => entry.id);
}

/**
 * 从 activeEntryIds 消费一个槽位。
 * 业务规则：get_entries 的 message 型 entry 与 get_messages 的
 * user/assistant/toolResult 一一对应；即使桌面端因空文本跳过渲染，
 * 也必须推进 index，否则后续消息的 entryId 会整体前移错位。
 */
export function takeActiveEntryId(
	activeEntryIds: string[] | undefined,
	entryIndex: number,
): { entryId?: string; nextIndex: number } {
	const entryId =
		activeEntryIds && entryIndex < activeEntryIds.length
			? activeEntryIds[entryIndex]
			: undefined;
	return { entryId, nextIndex: entryIndex + 1 };
}

/**
 * 模拟 convertAgentMessages 的 entryId 对齐逻辑（仅角色 + 空文本跳过规则）。
 * 用于回归：工具调用回合里「无文本的 assistant」不得打乱后续 entryId。
 */
export function alignEntryIdsForDisplayMessages(
	rawMessages: Array<{ role?: string; content?: unknown }>,
	activeEntryIds: string[],
	extractText: (content: unknown) => string,
): Array<{ role: string; entryId?: string; skipped: boolean }> {
	let entryIndex = 0;
	const result: Array<{ role: string; entryId?: string; skipped: boolean }> = [];

	for (const typed of rawMessages) {
		if (!typed || typeof typed !== "object") continue;
		const role = typed.role;
		if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;

		const { entryId, nextIndex } = takeActiveEntryId(activeEntryIds, entryIndex);
		// 无论是否渲染，message 型 entry 都要消费槽位
		entryIndex = nextIndex;

		if (role === "user" || role === "assistant") {
			const text = extractText(typed.content);
			const skipped = !text.trim();
			if (skipped && role === "assistant") {
				result.push({ role, entryId, skipped: true });
				continue;
			}
			if (skipped && role === "user") {
				result.push({ role, entryId, skipped: true });
				continue;
			}
			result.push({ role, entryId, skipped: false });
			continue;
		}

		// toolResult 始终展示（即使结果为空也有 ✓/✗ 摘要）
		result.push({ role: "tool", entryId, skipped: false });
	}

	return result;
}

/**
 * 收集 rootEntryId 及其全部后代 entry（沿 parentId 向下闭包）。
 * 重发时用于截断「该用户消息 + 之后的 assistant/tool」整段分支。
 */
export function collectDescendantEntryIds(
	lines: string[],
	rootEntryId: string,
): Set<string> {
	const removeIds = new Set<string>([rootEntryId]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const rawLine of lines) {
			const line = rawLine?.trim();
			if (!line) continue;
			try {
				const parsed = JSON.parse(line) as {
					id?: string;
					parentId?: string;
					type?: string;
				};
				if (!parsed?.id || parsed.type === "deleted") continue;
				if (parsed.parentId && removeIds.has(parsed.parentId) && !removeIds.has(parsed.id)) {
					removeIds.add(parsed.id);
					grew = true;
				}
			} catch {
				// 跳过无法解析的行
			}
		}
	}
	return removeIds;
}

/**
 * 在 JSONL 中按「角色 + 文本」找最后一次匹配的用户消息行。
 * 用于乐观更新消息（无 entryId）的重发定位：优先最后一次，避免重复文案命中更早的历史。
 */
export function findLastUserMessageLine(
	lines: string[],
	text: string,
	extractText: (content: unknown) => string,
): { lineIndex: number; entry: Record<string, unknown> } | null {
	let found: { lineIndex: number; entry: Record<string, unknown> } | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]?.trim();
		if (!line) continue;
		try {
			const entry = JSON.parse(line) as Record<string, unknown>;
			if (entry.type === "deleted") continue;
			const message = entry.message as { role?: string; content?: unknown } | undefined;
			if (message?.role !== "user") continue;
			const entryText = extractText(message.content);
			if (entryText === text) {
				found = { lineIndex: i, entry };
			}
		} catch {
			// 跳过
		}
	}
	return found;
}

/**
 * 校验重发根节点必须是 user 消息，且文本与目标一致。
 * 防止 entryId 错位时把 assistant/更早的 user 当成截断根，误删整段历史。
 */
export function assertResendRootEntry(
	entry: Record<string, unknown>,
	expectedText: string,
	extractText: (content: unknown) => string,
): void {
	const message = entry.message as { role?: string; content?: unknown } | undefined;
	if (!message || message.role !== "user") {
		throw new Error("Resend root must be a user message entry");
	}
	const entryText = extractText(message.content);
	// Image-only messages use a localized UI placeholder that is not present in JSONL.
	const isImagePlaceholder = expectedText === "[图片]" || expectedText === "[Image]";
	if (entryText !== expectedText && !isImagePlaceholder) {
		throw new Error(
			`Resend root text mismatch: expected ${JSON.stringify(expectedText.slice(0, 80))}, got ${JSON.stringify(entryText.slice(0, 80))}`,
		);
	}
}
