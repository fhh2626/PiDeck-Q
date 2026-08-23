/**
 * 消息编辑提交回调的「开始编辑时捕获」策略。
 *
 * 为什么需要：原地编辑是跨渲染周期的长时操作——用户可能在编辑框打开期间遭遇
 * Agent 重启 / runtime 替换，此时父层传入的 onEditMessage 已换绑到新 generation
 * 的 target。若保存时才读取最新 props，会把打开于旧 runtime 的编辑操作重定向到
 * 新 runtime，绕过 useSessionMessageCommands 的 target freshness 校验
 * （计划要求：延迟执行的编辑必须在执行时对「原 target」重新验证，过期拒绝而非转发）。
 *
 * 正确语义：进入编辑时捕获当次回调并保存到本组件状态；保存时调用捕获值，
 * 让 hook 比较「开始编辑时的 target」与最新 target，不一致即提示
 * sessionCommand.runtimeChanged。提交为一次性消费，防止重复保存重复触发。
 */
export type EditSubmitCallback = (messageId: string, newText: string) => void;

export interface TrackedEditSubmit {
	/** 进入编辑模式时调用：捕获本次编辑对应的提交回调（可为 undefined 表示不可编辑）。 */
	begin: (callback: EditSubmitCallback | undefined) => void;
	/**
	 * 保存时调用：使用进入编辑时捕获的回调提交。
	 * 未捕获过或捕获值为 undefined 时返回 false（调用方应保持编辑态不关闭）。
	 */
	submit: (messageId: string, newText: string) => boolean;
}

export function createTrackedEditSubmit(): TrackedEditSubmit {
	let captured: EditSubmitCallback | undefined;
	return {
		begin: (callback) => {
			captured = callback;
		},
		submit: (messageId, newText) => {
			const callback = captured;
			captured = undefined;
			if (!callback) return false;
			callback(messageId, newText);
			return true;
		},
	};
}
