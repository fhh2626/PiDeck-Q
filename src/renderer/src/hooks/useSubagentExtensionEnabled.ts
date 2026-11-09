/**
 * pideck-q-subagents 扩展是否已启用。
 *
 * 右侧「子代理」入口需要据此置灰：扩展未启用时配置写进 settings.json 也不会生效，
 * 让用户点开一个「改了没反应」的弹框比直接说明原因更糟。
 *
 * 刷新时机：挂载时 + refreshKey 变化时（App 用配置弹框开关作为 key，
 * 因为启用/禁用扩展正是在配置页完成的）。主进程 list() 自带缓存，
 * 频繁调用不会反复拉起 pi CLI。
 */

import { useEffect, useState } from "react";
import { desktopApi } from "../desktopApi";

/** 内置扩展文件名（与 builtInExtensions.ts 的 BUILT_IN_EXTENSIONS 一致）。 */
const SUBAGENTS_EXTENSION_SOURCE = "pideck-q-subagents";

function matchesSubagentsExtension(source: string): boolean {
	const normalized = source.replace(/\\/g, "/").toLowerCase();
	return normalized.includes(SUBAGENTS_EXTENSION_SOURCE);
}

/**
 * @param active 入口是否真的会渲染（LAN Web 隐藏入口时传 false，省掉一次 pi list）。
 * @param refreshKey 变化时重新探测。
 * @returns true/false 为探测结果；undefined 表示首次探测还没回来——此时不能谎报
 *          「需要安装并启用插件」，入口按「检查中」处理。
 */
export function useSubagentExtensionEnabled(
	active: boolean,
	refreshKey?: unknown,
): boolean | undefined {
	const [enabled, setEnabled] = useState<boolean | undefined>(undefined);

	useEffect(() => {
		if (!active) return;
		let cancelled = false;
		void desktopApi.extensions
			.list()
			.then((result) => {
				if (cancelled) return;
				// 同名扩展可能同时存在用户级与项目级副本：任一启用即视为可用。
				setEnabled(
					result.extensions.some(
						(extension) => matchesSubagentsExtension(extension.source) && extension.enabled !== false,
					),
				);
			})
			.catch(() => {
				// 列表不可用时按未启用处理：入口置灰并提示安装/启用，不会误导用户。
				if (!cancelled) setEnabled(false);
			});
		return () => {
			cancelled = true;
		};
	}, [active, refreshKey]);

	return enabled;
}
