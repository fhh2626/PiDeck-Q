/**
 * WSLENV 名称列表的纯函数工具。
 *
 * 为什么需要：wsl.exe 只把 WSLENV 中登记的 Windows 环境变量传进 Linux 进程，
 * 宿主为 pi 子进程注入的变量（界面语言、离线开关等）不登记就会在 WSL 内丢失。
 * PiProcess 与模型列表子进程共用同一套规则，避免两处各写一份而行为漂移。
 */

/**
 * 把变量名追加进 WSLENV（冒号分隔、去重、保留已有项）。
 * 值是纯字符串，不加 /p 路径转换标志；已存在（含带标志的同名项）时保持原样。
 */
export function appendWslEnvName(current: string | undefined, name: string): string {
	const names = (current ?? "").split(":").map((item) => item.trim()).filter(Boolean);
	const exists = names.some((item) => item.split("/")[0] === name);
	return exists ? names.join(":") : [...names, name].join(":");
}

/** 只移除一个 WSLENV 名称，保留其余项；结果为空时返回 undefined，避免留下空字符串。 */
export function withoutWslEnvName(current: string | undefined, name: string): string | undefined {
	const names = (current ?? "").split(":").map((item) => item.trim()).filter(Boolean)
		.filter((item) => item.split("/")[0] !== name);
	return names.length > 0 ? names.join(":") : undefined;
}
