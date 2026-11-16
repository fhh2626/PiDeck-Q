import { useSetAtom } from "jotai";
import { useLayoutEffect } from "react";
import { rememberUserBubblePresentationIdentityAtom } from "../atoms/timeline-presentation";
import type { TimelineRowModel } from "../components/session/timeline/timelineRowModel";

/** Save proven row continuations even while their bubbles are outside the mounted range. */
export function useTimelinePresentationIdentities(sessionId: string | undefined, rowModel: TimelineRowModel): void {
	const rememberIdentity = useSetAtom(rememberUserBubblePresentationIdentityAtom);
	useLayoutEffect(() => {
		if (!sessionId) return;
		for (const row of rowModel.rows) {
			if (row.item.kind !== "message" || row.item.message.role !== "user") continue;
			const rowKey = `message:${row.item.message.id}`;
			if (rowKey === row.key) continue;
			// The row model already reserves exact identities and rejects ambiguous
			// request matches. Only its committed stable key proves this continuation.
			rememberIdentity({ sessionId, rowKey, previousRowKey: row.key });
		}
	}, [sessionId, rowModel, rememberIdentity]);
}
