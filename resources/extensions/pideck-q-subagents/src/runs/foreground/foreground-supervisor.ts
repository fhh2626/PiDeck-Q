import { INTERCOM_DETACH_REQUEST_EVENT, INTERCOM_DETACH_RESPONSE_EVENT, SUPERVISOR_REQUEST_SETTLED_EVENT, type IntercomEventBus } from "../../shared/types.ts";

/** Correlate external asks to a live tool call, not to the entire lifetime of a detached child. */
export function createForegroundSupervisorBridge(input: {
	events?: IntercomEventBus;
	enabled: boolean;
	runId?: string;
	agent: string;
	childIndex: number;
	isLive(): boolean;
	isDetached(): boolean;
	detach(): boolean;
	activeIntercomCalls(): ReadonlyArray<{ key: string; toolCallId?: string }>;
}): { toolEnded(key: string): void; dispose(): void } {
	const externalRequests = new Map<string, string>();
	let disposed = false;
	const settle = (requestId: string, lifecycle: "resolved" | "run-exited") => {
		if (!externalRequests.delete(requestId)) return;
		input.events?.emit(SUPERVISOR_REQUEST_SETTLED_EVENT, { requestId, runId: input.runId, agent: input.agent, childIndex: input.childIndex, source: "external", lifecycle });
	};
	const unsubscribe = input.events?.on?.(INTERCOM_DETACH_REQUEST_EVENT, (payload) => {
		if (disposed || !input.enabled || !input.isLive() || !payload || typeof payload !== "object") return;
		if (!("requestId" in payload) || typeof payload.requestId !== "string" || !payload.requestId) return;
		if ("runId" in payload && payload.runId !== input.runId) return;
		if ("agent" in payload && payload.agent !== input.agent) return;
		if ("childIndex" in payload && payload.childIndex !== input.childIndex) return;
		const native = "source" in payload && payload.source === "native";
		let toolKey: string | undefined;
		if (native) {
			// Native requests are settled by the native channel, and must name their owner in full.
			if (!("runId" in payload) || !("agent" in payload) || !("childIndex" in payload)) return;
		} else {
			const calls = input.activeIntercomCalls().filter((call) => !("toolCallId" in payload) || payload.toolCallId === call.toolCallId);
			// Never attach an uncorrelated ask to arbitrary simultaneous intercom calls.
			if (calls.length !== 1) return;
			toolKey = calls[0]?.key;
		}
		const accepted = input.detach() || input.isDetached();
		if (accepted && toolKey !== undefined) externalRequests.set(payload.requestId, toolKey);
		input.events?.emit(INTERCOM_DETACH_RESPONSE_EVENT, { requestId: payload.requestId, accepted, runId: input.runId, agent: input.agent, childIndex: input.childIndex, source: native ? "native" : "external" });
	});
	return {
		toolEnded(key) {
			for (const [id, callKey] of externalRequests) if (callKey === key) settle(id, "resolved");
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			unsubscribe?.();
			for (const id of externalRequests.keys()) settle(id, "run-exited");
		},
	};
}
