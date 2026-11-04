/**
 * 强制结束一个子进程（优雅退出宽限期过后的兜底）。
 *
 * 为什么不直接 child.kill()：Windows 上经 `cmd.exe /c` 包装启动的 pi（npm 的 pi.cmd shim），
 * kill() 只会结束 cmd.exe，真正的 node/pi 进程继续运行并持有会话文件与 stdin 管道。
 * 这种情况必须用 `taskkill /T /F` 结束整棵进程树；直接启动的可执行文件 kill() 已足够。
 *
 * 不在本模块 import child_process：调用方注入自己的 execFile，测试可整体替换进程边界。
 */

/** execFile 的最小形状（只用到数组参数 + 回调）。 */
export type TerminateExecFile = (
	file: string,
	args: string[],
	options: { windowsHide: boolean; timeout: number },
	callback: (error: Error | null) => void,
) => unknown;

export type TerminableChild = {
	readonly pid?: number;
	kill: () => boolean;
};

export type TerminateOptions = {
	/** 该进程是否经 cmd.exe 包装（需要杀进程树）。 */
	killTree: boolean;
	platform: NodeJS.Platform;
	execFile: TerminateExecFile;
};

/** 尽力结束子进程；任何失败都退回 kill()，从不抛错。 */
export function terminateChildProcess(child: TerminableChild, options: TerminateOptions): void {
	const fallback = () => {
		try {
			child.kill();
		} catch {
			// 进程已退出或无权限：没有更多可做的，交由 exit 事件收尾。
		}
	};
	if (options.platform !== "win32" || !options.killTree || typeof child.pid !== "number") {
		fallback();
		return;
	}
	try {
		// 参数数组传递，禁止拼 shell 命令；/T 连同子进程一起结束，/F 强制。
		options.execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5_000 }, (error) => {
			if (error) fallback();
		});
	} catch {
		fallback();
	}
}
