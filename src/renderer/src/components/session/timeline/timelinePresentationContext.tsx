import { createContext, useContext, useMemo } from "react";

export type TimelinePresentationContextValue = {
	sessionId: string;
	rowKey: string;
};

const TimelinePresentationContext = createContext<TimelinePresentationContextValue | null>(null);

export function TimelinePresentationProvider(props: {
	sessionId: string;
	rowKey: string;
	children: React.ReactNode;
}) {
	const value = useMemo(
		() => ({ sessionId: props.sessionId, rowKey: props.rowKey }),
		[props.sessionId, props.rowKey],
	);

	return (
		<TimelinePresentationContext.Provider value={value}>
			{props.children}
		</TimelinePresentationContext.Provider>
	);
}

export function useTimelinePresentationContext(): TimelinePresentationContextValue | null {
	try {
		return useContext(TimelinePresentationContext);
	} catch {
		return null;
	}
}
