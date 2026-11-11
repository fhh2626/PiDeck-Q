/** Extension-local i18n: Pi cannot import the desktop renderer's runtime modules. */
interface TodoTaskCopy {
	todoDescription: string;
	goalDescription: string;
	clarify: string;
	busy: string;
	unavailable: string;
	goalNotice: string;
	unsupported: string;
	paused: string;
	startFailed: string;
	questionBlocked: string;
}

const ZH_CN: TodoTaskCopy = {
	todoDescription: "为本次任务建立并维护待办清单（允许提问，不自动续跑）",
	goalDescription: "按待办清单持续执行本次任务（建清单后禁止提问，三次无进展暂停）",
	clarify: "本次要执行什么任务？",
	busy: "请先停止或等待当前任务结束，再使用 /todo 或 /todo-goal。",
	unavailable: "todo 工具已由第三方扩展接管，无法启用 PiDeck 的待办任务控制。",
	goalNotice: "/todo-goal 已启用。自动续跑需要运行时提供安全收尾事件 agent_before_settle；不支持时不会强制续跑。主动停止始终优先。",
	unsupported: "运行时未提供可验证的安全收尾信息，已暂停 /todo-goal 自动续跑；待办清单已保留。",
	paused: "/todo-goal 连续 3 次失败或无进展，已暂停自动续跑。待办清单已保留；请检查阻塞原因后重新发起任务。",
	startFailed: "无法启动待办任务，请检查运行时状态后重试。",
	questionBlocked: "/todo-goal 已建立待办清单，本次任务完成前不能使用 ask_question。请在现有授权范围内继续；不要绕过权限、安全限制或虚构凭据。",
};

const EN_US: TodoTaskCopy = {
	todoDescription: "Track this task with todos (questions allowed, no automatic continuation)",
	goalDescription: "Execute this task with todos (no questions after creation; pause after 3 stalled rounds)",
	clarify: "What task should be executed?",
	busy: "Stop or finish the current task before using /todo or /todo-goal.",
	unavailable: "A third-party extension owns the todo tool; PiDeck todo task control is unavailable.",
	goalNotice: "/todo-goal enabled. Automatic continuation requires the runtime's safe settlement boundary agent_before_settle; unsupported runtimes will not be forced to continue. User cancellation always takes priority.",
	unsupported: "The runtime did not provide a verifiable safe settlement boundary. /todo-goal continuation is paused; the checklist is preserved.",
	paused: "/todo-goal paused after 3 consecutive failed or no-progress rounds. The checklist is preserved; inspect the blocker before starting another task.",
	startFailed: "Could not start the todo task. Check the runtime and retry.",
	questionBlocked: "/todo-goal has created its checklist. ask_question is blocked until this task finishes. Continue within existing authorization; do not bypass permissions, safety limits, or invent credentials.",
};

/** Follow the same host-injected locale contract as other built-in extensions. */
export function todoTaskCopy(
	language = typeof process === "undefined" ? undefined : process.env.PIDECK_UI_LANGUAGE,
): TodoTaskCopy {
	return language?.trim().toLowerCase().startsWith("en") ? EN_US : ZH_CN;
}
