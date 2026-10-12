import { performance } from "node:perf_hooks";

/**
 * 进程内单调时钟（毫秒）。只用于同一进程内的先后比较，例如断层补发时判断
 * “某会话最后一次下发是否晚于断层起点”。系统校时（休眠唤醒后常见）会让 Date.now()
 * 回跳，而这里的值永不倒退；它不是墙钟时间，不能写入日志当作时间戳或跨进程传递。
 */
export function monotonicNowMs(): number {
	return performance.now();
}
