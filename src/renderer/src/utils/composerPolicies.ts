/** Pure Composer policies: draft ownership, async request epochs and ordered session references. */
export type ComposerDraftGuard = {
  sessionId: string;
  agentId?: string;
  runtimeGeneration: number;
  baselineDraft: string;
  version: number;
  pristine: boolean;
};

/** Capture the runtime/draft baseline before asynchronous editor suggestions arrive. */
export function createComposerDraftGuard(input: {
  sessionId: string;
  agentId?: string;
  runtimeGeneration?: number;
  draft: string;
}): ComposerDraftGuard {
  return {
    sessionId: input.sessionId,
    agentId: input.agentId,
    runtimeGeneration: input.runtimeGeneration ?? 0,
    baselineDraft: input.draft,
    version: 0,
    pristine: input.draft.length === 0,
  };
}

/** Any user mutation revokes Pi's permission to replace the initial draft. */
export function markComposerDraftMutation(guard: ComposerDraftGuard): ComposerDraftGuard {
  return { ...guard, version: guard.version + 1, pristine: false };
}

/** Runtime identity and an untouched baseline are both required; matching text alone is insufficient. */
export function canApplyRuntimeEditorText(guard: ComposerDraftGuard, input: {
  sessionId: string;
  agentId: string;
  runtimeGeneration: number;
  currentDraft: string;
}): boolean {
  return guard.sessionId === input.sessionId && guard.agentId === input.agentId &&
    guard.runtimeGeneration === input.runtimeGeneration && guard.pristine &&
    guard.baselineDraft === input.currentDraft;
}

export type LatestRequestToken = { key: string; sequence: number };

/** Same-key requests still have distinct epochs, protecting A→B→A and repeated pickers. */
export function createLatestRequestGate() {
  let current = { key: "", sequence: 0 };
  return {
    begin(key: string): LatestRequestToken {
      current = { key, sequence: current.sequence + 1 };
      return current;
    },
    invalidate(key: string) { current = { key, sequence: current.sequence + 1 }; },
    isCurrent(token: LatestRequestToken) { return token.key === current.key && token.sequence === current.sequence; },
  };
}

type SessionReferenceMessage = { role: string; content: string; timestamp: number };
export type SessionReferenceSelection = {
  selectedIndices: number[];
  entries: Array<{ index: number; message: SessionReferenceMessage }>;
};

/** Keep index/message pairs together so missing selections cannot shift reference identities. */
export function createSessionReferenceSelection(selectedIndices: number[], selectedMessages: SessionReferenceMessage[]): SessionReferenceSelection {
  const entries = selectedIndices.map((index, position) => ({ index, message: selectedMessages[position] }))
    .filter((entry): entry is { index: number; message: SessionReferenceMessage } => Boolean(entry.message));
  return { selectedIndices: entries.map((entry) => entry.index), entries };
}

/** Reference expansion follows source chronology without mutating the picker selection. */
export function selectedSessionReferenceMessages(selection: SessionReferenceSelection): SessionReferenceMessage[] {
  return [...selection.entries].sort((left, right) => left.index - right.index).map((entry) => entry.message);
}
