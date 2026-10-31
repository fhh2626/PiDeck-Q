/**
 * PiDeck Todo Extension
 *
 * 注册 todo 工具让 LLM 主动维护任务列表（add / toggle / clear / list），并通过
 * RPC Extension UI Protocol 在桌面端展示进度：
 *   - ctx.ui.setWidget 持续显示当前列表与完成进度（fire-and-forget，不污染会话消息）
 *   - widget 按插入顺序输出全部条目，完成项原位保留（☑ 标记，不按状态分组沉底）
 *   - 完成时不自动清空：上一轮列表保留到用户下一次提交指令，由该轮 input 重置；
 *     运行中插话（steer/followUp）和扩展注入消息不算新指令，不会清空
 *   - /todo 命令用 ctx.ui.notify 输出文本快照（单数命名，避免与 plan-mode 的 /todos 冲突）
 *
 * 状态持久化用 pi.appendEntry 写 custom entry，session_start / session_tree 时读
 * 当前分支最后一条快照重建——比扫描 toolResult.details 更可靠。快照挂在写入时的
 * leaf 上，因此必须用 getBranch() 沿当前分支回溯；getEntries() 是整棵树的追加序。
 *
 * 相比 pi-deck-plan-mode（从 LLM 输出的 Plan: 文本解析 todo），本扩展让 LLM 显式
 * 调用工具维护任意任务列表，不依赖固定输出格式，定位更通用。
 *
 * ## 让位机制
 * pi 的 registerTool 对同名工具按 Map.set 覆盖语义（后注册覆盖前注册，不抛错）。
 * 本扩展作为内置基线，遇到任何第三方 todo 扩展（如 rpiv-todo）都应让位，避免
 * 死 widget / 重复命令。让位依赖 session_start 时 isOwnTodo() 检测（查 sourceInfo
 * 是否含 "pi-deck-todo"）。若被第三方覆盖则停掉 widget 与状态重建，/todo 命令
 * 转而引导用户使用第三方扩展的命令。
 *
 * @packageDocumentation
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

interface Todo {
	id: number;
	text: string;
	done: boolean;
}

interface TodoState {
	todos: Todo[];
	nextId: number;
}

// 工具结果 details：携带当前完整状态，便于 LLM 与桌面端渲染时直接读取
interface TodoDetails extends TodoState {
	action: "list" | "add" | "toggle" | "clear";
	error?: string;
}

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "toggle", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for toggle)" })),
});

// widget key 与 appendEntry 的 customType，统一用 pi-deck-todo 前缀，避免与 plan-mode 冲突
const WIDGET_KEY = "pi-deck-todo";
const ENTRY_TYPE = "pi-deck-todo";
// 自身来源标识：sourceInfo.path / source 含此串说明当前生效的 todo 工具仍是本扩展注册的
const SELF_MARKER = "pi-deck-todo";

export default function (pi: ExtensionAPI) {
	// 内存状态：session_start / session_tree 时从会话快照重建
	let todos: Todo[] = [];
	let nextId = 1;
	// widget 折叠状态
	let widgetCollapsed = false;
	// 是否已让位给第三方 todo 扩展；让位后不显示 widget、不重建状态、命令转引导
	let yielded = false;
	// 状态是否已按当前分支重建；首条用户消息可能先于 session_start 到达。
	let hydrated = false;

	/**
	 * 判断当前生效的 "todo" 工具是否仍是本扩展注册的（未被第三方覆盖）。
	 * 只在自身已注册后调用：sourceInfo 含 SELF_MARKER 说明本扩展的注册仍生效。
	 */
	function isOwnTodo(): boolean {
		const t = pi.getAllTools().find((x) => x.name === "todo");
		const info = t?.sourceInfo as { path?: string; source?: string } | undefined;
		return Boolean(info?.path?.includes(SELF_MARKER) || info?.source?.includes(SELF_MARKER));
	}

	/** 把当前状态写入会话 custom entry，供后续 session_start / 分支切换时重建 */
	function persistState(): void {
		// 传浅拷贝：appendEntry 之后内存状态仍会继续变化，快照必须是写入那一刻的值。
		pi.appendEntry(ENTRY_TYPE, { todos: todos.map((t) => ({ ...t })), nextId });
	}

	/**
	 * 刷新桌面端 widget：按插入顺序输出全部条目，完成项原位保留（仅换 ☑ 标记），
	 * 不再按状态分组把已完成项沉底；重置由新一轮 input 自动处理，也可显式 todo clear。
	 * 折叠态只回一行 "done/total" 摘要。
	 */
	function updateWidget(ctx: ExtensionContext): void {
		if (todos.length === 0) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const lines: string[] = [];
		if (widgetCollapsed) {
			const done = todos.filter((t) => t.done).length;
			lines.push(`${done}/${todos.length}`);
		} else {
			for (const t of todos) {
				lines.push(`${t.done ? "☑" : "☐"} #${t.id} ${t.text}`);
			}
		}
		ctx.ui.setWidget(WIDGET_KEY, lines);
	}

	/**
	 * 用户提交新指令前清空上一轮列表。
	 * 完成记录要保留到用户看到为止，所以不在收尾时清；改由下一轮 input 触发，
	 * 并写入快照，保证后续 session_start / 分支切换恢复出的是空列表。
	 */
	function resetForNewRound(ctx: ExtensionContext): void {
		todos = [];
		nextId = 1;
		persistState();
		updateWidget(ctx);
	}

	/**
	 * 从当前分支重建状态：取该分支路径上最后一条 pi-deck-todo 快照。
	 * getEntries() 返回整棵会话树，其他分支后写入的快照会排在更后；切分支后必须用 getBranch()。
	 */
	function reconstructState(ctx: ExtensionContext): void {
		const entries = ctx.sessionManager.getBranch();
		let snapshot: TodoState | undefined;
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index];
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			// 当前分支上最新的快照优先；形状无效时按空列表恢复，不回退到更早快照。
			snapshot = isTodoState(entry.data) ? entry.data : undefined;
			break;
		}
		todos = snapshot?.todos ?? [];
		nextId = snapshot?.nextId ?? 1;
	}

	/** 校验持久化快照的最小形状，避免把会话边界上的未知数据当成待办状态。 */
	function isTodoState(data: unknown): data is TodoState {
		if (typeof data !== "object" || data === null) return false;
		const todosValue = Reflect.get(data, "todos");
		const nextIdValue = Reflect.get(data, "nextId");
		if (!Array.isArray(todosValue) || typeof nextIdValue !== "number") return false;
		return todosValue.every((item) => {
			if (typeof item !== "object" || item === null) return false;
			return (
				typeof Reflect.get(item, "id") === "number" &&
				typeof Reflect.get(item, "text") === "string" &&
				typeof Reflect.get(item, "done") === "boolean"
			);
		});
	}

	// 立即注册（运行时初始化后 getAllTools 才能调用，因此无法在 default 里做加载顺序检测）。
	// 若被后加载的第三方覆盖（Map.set 后注册覆盖前注册），session_start 的 isOwnTodo()
	// 会判定为 yielded，停掉 widget 并让命令转引导。
	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage a todo list. Actions: list (show all), add (text), toggle (id), clear (remove all). Progress is shown in the desktop UI widget.",
		promptSnippet: "Manage a todo list (add / toggle / clear)",
		promptGuidelines: [
			"Use the todo tool to track multi-step work: add items before starting and mark each item done immediately as you finish it.",
			"Keep completed items in place. Do not clear the list when the work is finished; call clear only when the user explicitly asks to clear it.",
			"The list resets automatically at the next user instruction — start a fresh list for the new work instead of reusing earlier items.",
			"Toggle by id; call list first if you need to see current ids.",
			"Todo state is per-branch — switching branches restores that branch's list automatically.",
		],
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			let error: string | undefined;

			switch (params.action) {
				case "add": {
					const text = params.text?.trim();
					if (!text) {
						error = "text required for add";
						break;
					}
					todos.push({ id: nextId++, text, done: false });
					break;
				}
				case "toggle": {
					if (params.id === undefined) {
						error = "id required for toggle";
						break;
					}
					const target = todos.find((t) => t.id === params.id);
					if (!target) {
						error = `#${params.id} not found`;
						break;
					}
					target.done = !target.done;
					break;
				}
				case "clear": {
					todos = [];
					nextId = 1;
					break;
				}
				case "list":
				default:
					// list 只读，不改状态
					break;
			}

			// 仅在状态实际变更时持久化；list 与出错仍刷新 widget 以保持桌面端与内存一致
			if (params.action !== "list" && !error) {
				persistState();
			}
			updateWidget(ctx);

			const details: TodoDetails = {
				action: params.action,
				todos: [...todos],
				nextId,
				...(error ? { error } : {}),
			};

			// 工具结果文本：让 LLM 与桌面端默认渲染都能直接读懂当前状态
			let text: string;
			if (error) {
				text = `Error: ${error}`;
			} else if (params.action === "list") {
				text = todos.length
					? todos.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n")
					: "No todos";
			} else if (params.action === "add") {
				const added = todos[todos.length - 1];
				text = `Added todo #${added.id}: ${added.text}`;
			} else if (params.action === "toggle") {
				const t = todos.find((x) => x.id === params.id);
				text = `Todo #${params.id} ${t?.done ? "completed" : "uncompleted"}`;
			} else {
				text = "Cleared all todos";
			}

			return {
				content: [{ type: "text" as const, text }],
				details,
			};
		},
	});

	// /todo 命令：用户手动查看当前列表，追加 collapse 参数控制折叠状态
	pi.registerCommand("todo", {
		description: "查看/折叠/展开当前分支待办事项",
		handler: async (args, ctx) => {
			if (!isOwnTodo()) {
				ctx.ui.notify("Todo 工具由其他扩展提供，请使用其对应命令（如 /todos）查看。", "info");
				return;
			}
			// /todo collapse / /todo expand
			if (args === "collapse") {
				widgetCollapsed = true;
				updateWidget(ctx);
				return;
			}
			if (args === "expand") {
				widgetCollapsed = false;
				updateWidget(ctx);
				return;
			}
			if (todos.length === 0) {
				ctx.ui.notify("还没有待办事项，可以告诉 AI 添加。", "info");
				return;
			}
			// 与 widget 一致的顺序：按插入顺序输出，完成项原位带 ☑ 标记
			const done = todos.filter((t) => t.done).length;
			let msg = `Todos ${done}/${todos.length}`;
			msg += `\n${todos.map((t) => `${t.done ? "☑" : "☐"} #${t.id} ${t.text}`).join("\n")}`;
			ctx.ui.notify(msg, "info");
		},
	});

	// 新一轮指令入口：把上一轮列表保留到用户看到，再由这里清空。
	// - source=extension 是扩展自己注入的消息（如系统提醒），不算用户新指令；
	// - steer/followUp 是运行中插话，仍属于当前这一轮，不能清空；
	// - 其余 input（含回答 ask_question）视为新指令；列表为空时不写空快照。
	pi.on("input", async (event, ctx) => {
		if (yielded || !isOwnTodo()) return;
		if (event.source === "extension") return;
		if (event.streamingBehavior) return;
		// 首条用户消息可能先于 session_start：内存里还没有列表时才从当前分支补齐，
		// 本进程已经建过的列表以内存为准，不能被分支快照覆盖。
		if (!hydrated) {
			if (todos.length === 0) reconstructState(ctx);
			hydrated = true;
		}
		if (todos.length === 0) return;
		resetForNewRound(ctx);
	});

	// 会话启动 / 分支切换时从快照重建状态、刷新 widget。
	// 已完成条目不在这里清理：由下一轮 input 统一重置，跨分支恢复同样的完成态。
	pi.on("session_start", async (_event, ctx) => {
		if (!isOwnTodo()) {
			yielded = true;
			return;
		}
		yielded = false;
		reconstructState(ctx);
		hydrated = true;
		updateWidget(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		if (yielded || !isOwnTodo()) {
			yielded = true;
			return;
		}
		reconstructState(ctx);
		hydrated = true;
		updateWidget(ctx);
	});
}
