import { createContext, useContext, type ReactNode } from "react";
import type { SessionMessageCommandTarget } from "../../../../../shared/types";

export interface TimelineEditCommands {
	/** Captures either an existing runtime or a saved session awaiting activation. */
	currentRuntimeTarget: SessionMessageCommandTarget | undefined;
	/** 提交编辑变更，必须原样传入开始编辑时捕获的 expectedTarget */
	submitEditMessage: (
		expectedTarget: SessionMessageCommandTarget,
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
