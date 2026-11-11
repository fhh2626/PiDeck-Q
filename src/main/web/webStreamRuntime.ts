import type { SessionRuntimeInfo, SessionRuntimeTarget } from "../../shared/types";

/**
 * 一条 session stream 的准入模式（run 级，随 run 生命周期）：
 * - `dispatch`：POST /api/chat 先开流再发 prompt，开流时的 idle/missing/starting 都可能是
 *   本次 prompt 的合法准备态，因此不能凭“当前没有 running”收尾；只有观察到 running 才钉住身份。
 * - `observe`：GET /stream 重连，只观察已经存在的执行。没有可观察对象（无 runtime / idle /
 *   closed / error）必须立即收尾；starting 也算可观察（激活或进程自动重连期间的过渡态），
 *   钉住后由后续 idle/closed/missing/replaced 如实收尾，避免长连接永久泄漏。
 */
export type WebStreamAdmission = "dispatch" | "observe";

/** runtime 是否代表一次仍在进行（或正在启动）的执行。 */
function isLiveWebStreamRuntime(runtime: SessionRuntimeInfo | undefined): boolean {
	return runtime?.status === "running" || runtime?.status === "starting";
}

/** 该 runtime 是否可作为本流的观察对象；observe 允许钉住 starting，dispatch 只认 running。 */
function isObservable(admission: WebStreamAdmission, runtime: SessionRuntimeInfo): boolean {
	return runtime.status === "running" || (admission === "observe" && runtime.status === "starting");
}

/**
 * 决定一条 session stream 是否继续跟随某个 runtime，以及是否应该收尾。
 *
 * 关键规则：
 * - 已钉住身份时，只有同一身份且仍 running/starting 才继续；idle/closed/error/消失/被替换都收尾，
 *   且旧 generation 的收尾不会误伤新 run（替换后新流会重新钉住）。
 * - 未钉住时，observe 模式必须立刻收尾“没有可观察对象”的重连；dispatch 模式保持打开，
 *   避免 prompt 发出前的 idle/missing/starting→idle 准备被提前 finish。
 */
export function reconcileWebStreamRuntime(
	target: SessionRuntimeTarget | undefined,
	runtime: SessionRuntimeInfo | undefined,
	admission: WebStreamAdmission = "dispatch",
): { target?: SessionRuntimeTarget; finish: boolean } {
	if (!target) {
		if (!runtime || !isObservable(admission, runtime)) return { finish: admission === "observe" };
		return {
			target: {
				sessionId: runtime.sessionId,
				agentId: runtime.agentId,
				runtimeGeneration: runtime.runtimeGeneration,
			},
			finish: false,
		};
	}
	const sameRuntime = runtime?.sessionId === target.sessionId
		&& runtime.agentId === target.agentId
		&& runtime.runtimeGeneration === target.runtimeGeneration;
	return { target, finish: !sameRuntime || !isLiveWebStreamRuntime(runtime) };
}
