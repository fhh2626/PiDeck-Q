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
	blocked: string;
	resumeDescription: string;
	resumeUnavailable: string;
	/** Default resume guidance when /todo-resume has no arguments; it is shown and sent to the model. */
	resumePrompt: string;
	planPaused: string;
	planActiveGoalRejected: string;
	planActiveTaskRejected: string;
}

const ZH_CN: TodoTaskCopy = {
	todoDescription: "为本次任务建立并维护待办清单（允许提问，不自动续跑）",
	goalDescription: "按待办清单持续执行本次任务（建清单后禁止提问，连续三次运行错误暂停）",
	clarify: "本次要执行什么任务？",
	busy: "请先停止或等待当前任务结束，再使用 /todo 或 /todo-goal。",
	unavailable: "todo 工具已由第三方扩展接管，无法启用 PiDeck 的待办任务控制。",
	goalNotice: "/todo-goal 已启用。自动续跑需要运行时提供安全收尾事件 agent_before_settle；不支持时不会强制续跑。主动停止始终优先。",
	unsupported: "运行时未提供可验证的安全收尾信息，已暂停 /todo-goal 自动续跑；待办清单已保留。",
	paused: "/todo-goal 连续 3 次运行失败，已暂停自动续跑。待办清单已保留；请检查阻塞原因后重新发起任务。",
	startFailed: "无法启动待办任务，请检查运行时状态后重试。",
	questionBlocked: "/todo-goal 已建立待办清单，本次任务完成前不能使用 ask_question。请在现有授权范围内继续；不要绕过权限、安全限制或虚构凭据。",
	blocked: "/todo-goal 已暂停，请处理阻塞后使用 /todo-resume 恢复：",
	resumeDescription: "恢复已暂停的 todo 任务，可附加说明",
	resumeUnavailable: "没有可恢复的已暂停 todo 任务。",
	resumePrompt: "继续执行被暂停的任务，不要重复已完成的操作。",
	planPaused: "计划模式已暂停本次 todo 任务；请先退出计划模式再恢复。",
	planActiveGoalRejected: "计划模式启用中，无法启动 /todo-goal。请先退出计划模式（/plan off）再执行任务；当前待办清单已保留。",
	planActiveTaskRejected: "计划模式正在管理已挂起的 goal；请先退出计划模式再用 /todo 替换任务，当前清单已保留。",
};

const EN_US: TodoTaskCopy = {
	todoDescription: "Track this task with todos (questions allowed, no automatic continuation)",
	goalDescription: "Execute this task with todos (no questions after creation; pause after 3 consecutive errors)",
	clarify: "What task should be executed?",
	busy: "Stop or finish the current task before using /todo or /todo-goal.",
	unavailable: "A third-party extension owns the todo tool; PiDeck todo task control is unavailable.",
	goalNotice: "/todo-goal enabled. Automatic continuation requires the runtime's safe settlement boundary agent_before_settle; unsupported runtimes will not be forced to continue. User cancellation always takes priority.",
	unsupported: "The runtime did not provide a verifiable safe settlement boundary. /todo-goal continuation is paused; the checklist is preserved.",
	paused: "/todo-goal paused after 3 consecutive failed rounds. The checklist is preserved; inspect the blocker before starting another task.",
	startFailed: "Could not start the todo task. Check the runtime and retry.",
	questionBlocked: "/todo-goal has created its checklist. ask_question is blocked until this task finishes. Continue within existing authorization; do not bypass permissions, safety limits, or invent credentials.",
	blocked: "/todo-goal is paused. Resolve the blocker and use /todo-resume:",
	resumeDescription: "Resume a paused todo goal with optional guidance",
	resumeUnavailable: "There is no paused todo goal to resume.",
	resumePrompt: "Continue the paused goal without repeating completed work.",
	planPaused: "Plan mode paused this todo goal; leave plan mode before resuming.",
	planActiveGoalRejected: "Plan mode is active, so /todo-goal cannot start. Leave plan mode (/plan off) before executing a goal; the current checklist is preserved.",
	planActiveTaskRejected: "Plan mode owns a suspended goal. Leave plan mode before replacing it with /todo; the current checklist is preserved.",
};

/** Follow the same host-injected locale contract as other built-in extensions. */
export function todoTaskCopy(
	language = typeof process === "undefined" ? undefined : process.env.PIDECK_UI_LANGUAGE,
): TodoTaskCopy {
	return language?.trim().toLowerCase().startsWith("en") ? EN_US : ZH_CN;
}
