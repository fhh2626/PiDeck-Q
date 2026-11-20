#pragma once

#include "../MainCopy.h"
#include "../sessions/Projector.h"

#include <QHash>
#include <QJsonArray>
#include <QJsonObject>
#include <QSet>
#include <QString>
#include <QStringList>
#include <QVector>

/**
 * Live ChatMessage transcript for one agent.
 *
 * Port of the message-cache half of src/main/pi/AgentManager.ts: the array that the
 * renderer's `agents:message` window is built from. Two sources feed it:
 *  - `applyProjection` replaces it from pi `get_messages` (the same projector the
 *    history pager uses, so a live row and its persisted row are identical);
 *  - `upsertAssistant` / `upsertTool` maintain the rows that pi only streams as events.
 *
 * Delivery contract (`buildMessageFlushPayload`): a full payload carries
 * `{agentId, messages, totalLength}` plus `windowStart` when the cache was trimmed,
 * and tool `meta.result` is stripped because `meta.detailText` already carries it.
 */
namespace agentruntime {

class Transcript {
public:
    void configure(const QString &agentId, maincopy::Translator translate);

    void reset();
    const QJsonArray &messages() const { return m_messages; }
    int size() const { return int(m_messages.size()); }

    /** Replace the transcript; a verified legacy suffix has one file slot per raw row from its start. */
    void applyProjection(const QVector<QJsonValue> &rawMessages, const QStringList &entryIds,
                         const QSet<QString> &toolResultIds,
                         projector::EntryIdLayout layout = projector::EntryIdLayout::Legacy,
                         int verifiedFileSlotsStart = -1);

    /** Local-only failed-turn rows and settlement trims since a projection request. */
    quint64 diagnosticRevision() const { return m_diagnosticRevision; }
    quint64 trimRevision() const { return m_trimRevision; }
    void preserveDiagnosticsSince(quint64 revision, const QJsonArray &previous);

    /** Streaming assistant row; returns the stable runtime message id. */
    QString upsertAssistant(const QJsonObject &partialMessage, const QString &fallbackDelta,
                            bool allowEmpty);
    /** Tool row keyed by toolCallId; `status` is running|done|error. */
    QString upsertTool(const QJsonObject &event, const QString &status);

    void appendMessage(const QString &role, const QString &text, const QJsonObject &meta);
    /** A task acknowledges its adjacent slash command in place, retaining its request id. */
    void appendTodoTask(const QString &text, const QJsonObject &meta);
    void appendError(const QString &text);
    void appendLocalized(const QString &role, const QString &i18nKey, const QString &fallback,
                         const QJsonObject &params);

    /**
     * Failed-turn diagnostic (oracle `addDetailedErrorMessage`).
     *
     * The row is written as `role:error` with `i18nKey`/`i18nParams` so the renderer treats
     * it as a floating failure toast (`FLOATING_FAILURE_KEYS`) and re-localizes it, while the
     * raw provider/pi text stays in `meta.debugDetails` for the disposable detail view.
     * `appendError` alone produced a permanent card and never a toast.
     */
    void appendDetailedError(const QString &i18nKey, const QString &fallback,
                             const QJsonObject &params, const QString &debugDetails);

    /**
     * One auto-retry status row per agent, rewritten in place (oracle
     * `upsertRetryStatusMessage`).
     *
     * `meta` carries the already-normalized `attempt`/`maxAttempts`/`delayMs`/`errorMessage`
     * (the caller folds in the values inherited from this same row, exactly like the oracle's
     * `event.attempt ?? message.meta?.attempt`), so the params and the meta can never
     * disagree about the attempt; the row's own meta gets `status` + `i18nKey` + `i18nParams`
     * so the renderer can re-localize it and treat it as a floating toast. Writing a fresh
     * row per attempt (the old port) left one permanent `agent.retrying` card per attempt
     * because no row could replace the last.
     */
    void upsertRetryStatus(const QString &status, const QString &i18nKey,
                           const QJsonObject &params, const QJsonObject &meta);
    /** Whether this agent already owns a retry status row (oracle `retryStatusMessageIds.has`). */
    bool hasRetryStatus() const { return !m_retryStatusMessageId.isEmpty(); }
    /**
     * Meta of that retry row, or empty when it is gone.
     *
     * Oracle `retryStatusMessageIds.get(agentId)` + row lookup: `addDetailedErrorMessage`
     * reports how many attempts pi already spent before the final failure.
     */
    QJsonObject retryStatusMeta() const;

    /** Keep only the last `turns` user turns (plus leading system summary cards). */
    bool trimToTurns(int turns);

    /** Full delivery payload; `fileVersion` is the session file `mtime:size` when known. */
    QJsonObject flushPayload(const QString &fileVersion) const;

    /** File-space cursor and one-shot retention policy for an authoritative projection. */
    void configureHistory(const QStringList &fileEntryIds, int fallbackHead,
                          bool preserveHistory, bool stickyHistory);
    /** Consume one-shot fields only after the bound renderer accepted the full payload. */
    void messageFlushDelivered();

    QString activeAssistantId() const { return m_activeAssistantId; }
    void setActiveAssistantId(const QString &id) { m_activeAssistantId = id; }
    void clearActiveAssistant() { m_activeAssistantId.clear(); }
    QString toolMessageId(const QString &toolCallId) const { return m_toolMessageIds.value(toolCallId); }
    void clearToolIds() { m_toolMessageIds.clear(); }

    /**
     * Untruncated tool result text, keyed by runtime message id.
     *
     * Oracle `toolFullTextByAgent` (LRU 200, insertion order, no read refresh): the
     * delivered tool row keeps a truncated `detailText`, so "view full output" needs the
     * original text. Only populated when the detail actually was truncated, which is the
     * only case where the file row cannot answer on its own.
     */
    void rememberToolFullText(const QString &messageId, const QString &text);
    QString toolFullText(const QString &messageId) const { return m_toolFullText.value(messageId); }

    /** Live thinking segment (renderer `agents:thinking` channel). */
    void beginThinking(const QString &messageId);
    /** Accumulate the streaming thinking text; leaves `endedAt` at 0 while it streams. */
    void appendThinking(const QString &text);
    /** Stamp the phase end once (idempotent); called via `LiveChannels::thinkingEnded`. */
    void endThinking();
    QString thinkingId() const { return m_thinkingId; }
    qint64 thinkingStartedAt() const { return m_thinkingStartedAt; }
    qint64 thinkingEndedAt() const { return m_thinkingEndedAt; }
    QString streamingThinking() const { return m_streamingThinking; }
    bool hasThinkingSegment() const { return !m_thinkingId.isEmpty(); }
    /**
     * Drop the live thinking segment after its terminal frame was published.
     *
     * Oracle `finishThinkingChannel` deletes the segment: without this a second
     * assistant message in the same runtime would reuse the previous id/startedAt and
     * append new deltas onto the old text.
     */
    void clearThinking();

    /** Persist the accumulated thinking text onto the assistant row (message_end). */
    void finalizeThinking(const QJsonObject &partialMessage);

    /** Role of the most recent row; the completion toast only fires after an assistant turn. */
    QString lastMessageRole() const;

private:
    void noteHistoryTrim(int start);
    int firstFilePosition(const QJsonArray &messages) const;
    void pruneDiagnosticIds();
    int indexOfId(const QString &id) const;
    /** Rebind a runtime id to an existing projected row with the same pi content. */
    int findSamePiMessageIndex(const QString &role, const QString &text,
                               const QString &toolCallId = QString()) const;

    QString m_agentId;
    maincopy::Translator m_translate;
    QJsonArray m_messages;
    QHash<QString, int> m_fileEntryPositions;
    /** Raw message sequence to role slot, including rows hidden by the projector. */
    QHash<int, int> m_projectedFilePositions;
    int m_projectedFileCount = 0;
    int m_projectionHeadFilePos = -1;
    int m_windowStart = 0;
    int m_windowStartFilePos = 0;
    bool m_preserveHistory = true;
    bool m_stickyHistory = false;
    QJsonArray m_pendingSlideOut;
    quint64 m_diagnosticRevision = 0;
    quint64 m_trimRevision = 0;
    QHash<QString, quint64> m_diagnosticIds;
    QString m_activeAssistantId;
    QHash<QString, QString> m_toolMessageIds;
    /** Runtime id of this agent's single retry status row (oracle `retryStatusMessageIds`). */
    QString m_retryStatusMessageId;
    QString m_thinkingId;
    QString m_thinkingMessageId;
    QString m_streamingThinking;
    QHash<QString, QString> m_toolFullText;
    /** Insertion order for the FIFO eviction of `m_toolFullText` (oracle Map order). */
    QStringList m_toolFullTextOrder;
    qint64 m_thinkingStartedAt = 0;
    qint64 m_thinkingEndedAt = 0;
};

} // namespace agentruntime
