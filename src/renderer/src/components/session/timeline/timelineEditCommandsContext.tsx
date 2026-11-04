import { createContext, useContext, type ReactNode } from "react";
import type { SessionRuntimeTarget } from "../../../../../shared/types";

export interface TimelineEditCommands {
	/** 当前可用于发起新编辑的运行时目标 */
	currentRuntimeTarget: SessionRuntimeTarget | undefined;
	/** 提交编辑变更，必须原样传入开始编辑时捕获的 expectedTarget */
	submitEditMessage: (
		expectedTarget: SessionRuntimeTarget,
		messageId: string,
		newText: string,
	) => Promise<boolean>;
}

const TimelineEditCommandsContext = createContext<TimelineEditCommands | null>(null);

export function TimelineEditCommandsProvider(props: {
	value: TimelineEditCommands;
	children: ReactNode;
}) {
	return (
		<TimelineEditCommandsContext.Provider value={props.value}>
			{props.children}
		</TimelineEditCommandsContext.Provider>
	);
}

export function useTimelineEditCommands(): TimelineEditCommands | null {
	return useContext(TimelineEditCommandsContext);
}
