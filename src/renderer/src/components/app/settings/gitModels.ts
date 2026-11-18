/**
 * Git 摘要模型列表数据源 hook：与 pi --list-models 全局缓存共用。
 *
 * 独立成文件的原因：壳组件（SettingsModal）在打开时就要拉模型列表，
 * 但 CommonTab 组件应能 lazy 加载——若 hook 与组件同文件，壳的静态
 * import 会把整个 tab 拖进首开 chunk。
 */
import { useCallback, useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { modelListRevisionAtom } from "../../../atoms/model-atoms";
import type { AvailableModel } from "../../../../../shared/types";
import { desktopApi } from "../../../desktopApi";

export function useGitModels() {
	const modelListRevision = useAtomValue(modelListRevisionAtom);
	const [gitModels, setGitModels] = useState<AvailableModel[]>([]);
	const [gitModelPickerOpen, setGitModelPickerOpen] = useState(false);

	useEffect(() => {
		let active = true;
		void desktopApi.projects.listModels()
			.then((models) => {
				if (active) setGitModels(models);
			})
			.catch(() => {
				if (active) setGitModels([]);
			});
		return () => {
			active = false;
		};
	}, [modelListRevision]);

	const openPicker = useCallback(() => setGitModelPickerOpen(true), []);
	const closePicker = useCallback(() => setGitModelPickerOpen(false), []);

	return { gitModels, gitModelPickerOpen, openPicker, closePicker };
}
