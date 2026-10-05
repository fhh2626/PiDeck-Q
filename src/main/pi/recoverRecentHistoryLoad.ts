/**
 * 两次尝试之间的退避：pi 正在追加会话文件时，立即重读几乎必然撞上同一次写入，
 * 两次尝试都落在毫秒级的同一个写入窗口里并双双失败；短暂等待让写入落定。
 */
const DEFAULT_RETRY_DELAY_MS = 150;

export type RecoverRecentHistoryLoadOptions = {
	retryDelayMs?: number;
	/** 仅供测试注入，避免真实计时。 */
	sleep?: (ms: number) => Promise<void>;
};

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Secondary startup protection, not append detection: retry one invalidated
 * snapshot, never full-history RPC. The caller owns process/path/load-sequence
 * validity so a retry or error cannot resurrect a closed/superseded runtime.
 * Bounded recovery: at most two attempts with one short sleep between them; it
 * registers no listeners and leaves no timers behind once the promise settles.
 */
export async function recoverRecentHistoryLoad(
	load: () => Promise<unknown>, isCurrent: () => boolean, options: RecoverRecentHistoryLoadOptions = {},
): Promise<boolean> {
	const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
	const sleep = options.sleep ?? realSleep;
	for (let attempt = 0; attempt < 2; attempt++) {
		if (!isCurrent()) return false;
		try {
			await load();
			return isCurrent();
		} catch (error) {
			if (!isCurrent()) return false;
			const changed = error !== null && typeof error === "object" && "code" in error
				&& error.code === "SESSION_HISTORY_CHANGED";
			if (!changed || attempt === 1) throw error;
			// 退避只发生在“还有下一次尝试”时；等待期间所有权可能变化，循环头会重新校验。
			await sleep(retryDelayMs);
		}
	}
	return false;
}
