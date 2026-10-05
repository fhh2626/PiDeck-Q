# Web runtime refresh and turn-order repair

## Scope and causes

Two related Web timeline defects were reproduced with the real `WebChatApp`, React,
AI SDK `useChat`, and headless Edge. HTTP responses and SSE frames were intercepted;
no real Agent, session file, application cache, or installed package was modified.

1. `syncRuntimeMessages()` merged busy-runtime snapshots into the per-session cache,
   without replacing the live `useChat` timeline. On settlement, an unchanged merged
   cache failed the `merged !== current` check, even though the visible timeline was
   still older. Further identical idle polls could not repair the display.
2. A new metadata-free Web user message was inserted immediately after the last
   shared row in its stale `useChat` baseline. Cached PC tools/replies from the old
   turn ended up after the new question. The new reply could then be treated as an
   intermediate reply and folded into execution details.

## Repair

- Compare an idle merged snapshot with the actual visible `useChat` rows, not with
  the previous cache array. Semantic row equality handles SDK-cloned arrays and
  metadata-only changes without repeated `setMessages()` calls.
- Keep the existing runtime/SSE busy guards and active-session identity guard.
  No polling frequency, resume policy, runtime identity, or transport was changed.
- Place unmatched local users after the cached preceding turn's tail. For replayed
  local arrays, a later known user is an insertion boundary, so its existing reply
  stays in its own turn. Timestamped history placement remains unchanged.
- Keep current identity matching, summary handling, tool settlement preservation,
  history cursors/window policies, and stream-final-frame synchronization.

The scope is Web only. The Web composer is a controlled textarea, not the desktop
TipTap composer; no input, appearance, dependency, or localization changes were needed.

## Regression evidence

- `tests/browser/webRuntimeRefresh.spec.ts`: real Web composition root receives a
  busy PC snapshot, then identical idle snapshots. Without reentry or submission,
  the reply must appear once. The send scenario requires the old reply to precede
  the next question and the new SSE reply to remain visible without expanding tools.
- `tests/webStreamMessageCache.test.mjs`: a stale visible baseline plus a new user
  preserves the cached PC tool/reply before the new turn, during streaming and on
  settlement; streaming still cannot call `setMessages()`.
- `tests/webRuntimeRefresh.test.mjs`: unchanged cache versus stale visible rows,
  cloned-array equality, metadata/text changes, local-user order, partial replay
  before a later known user, and older timestamped history placement.
- The existing busy-state source guard test now checks the corrected visible-row
  comparison while retaining both runtime-busy and active-session restrictions.

Before repair, both browser behavior cases and the stream-order regression failed.
A partial replay boundary case exposed an ordering edge during implementation and
was retained after repair. The initial browser setup incorrectly waited for two
3-second polls within a 5-second assertion deadline; it was corrected before the
red behavior evidence was captured. The final setup waits for a committed busy/idle
button state instead of spending extra polling cycles; behavior assertions remain.

## Validation

- `npm run typecheck`: passed.
- `npm test`: 3,706 total; 3,701 passed; 5 skipped; 0 failed.
- Related Web unit tests: 375 passed.
- `npm run build`: passed; existing Vite large-chunk and npm allowScripts warnings remain.
- Full Edge browser suite: 52 passed. An initial run concurrent with full tests and
  build timed out in a pre-existing prompt-editor case and the new polling case;
  the independent full rerun and the final full run passed without relaxing timeouts
  or removing assertions. A concurrent related-unit run also encountered an existing
  localhost dev-proxy connection timeout; the final full unit run and the independent
  375-test Web rerun both passed, with no dev-proxy code or test changes.

Repository/browser evidence is not an installed-live Web/Qt smoke test or prolonged
CPU/heap measurement. Building does not replace installed files or reload an already
open Web page. No application or Agent was restarted; no changes were committed.
