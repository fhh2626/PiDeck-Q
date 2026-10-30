import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { modelListRevisionAtom } from "../atoms/model-atoms";
import { desktopApi } from "../desktopApi";

/**
 * 订阅主进程的模型列表更新（models:changed），并递增版本号。
 *
 * 代价说明：主进程只在配置保存/运行时切换后广播，不是高频事件；
 * 挂载点必须唯一（App 装配层），避免重复订阅同一事件。
 */
export function useModelListSync(): void {
	const bumpRevision = useSetAtom(modelListRevisionAtom);

	useEffect(
		() =>
			desktopApi.projects.onModelsChanged(() => {
				bumpRevision((revision) => revision + 1);
			}),
		[bumpRevision],
	);
}
