#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QString>

class QTimer;

namespace agentruntime {

class AgentSession;

/**
 * 50 ms latest-value coalescer for the live channels (port of `LatestByKeyEmitter` plus
 * the tool-message flush window in AgentManager).
 *
 * Why it exists: pi emits one delta per token. Sending every token as a growing
 * full-text frame made long replies evict the replay hub's frame window (4096 frames /
 * 32 MiB) and forced a resync where the oracle keeps ~200 s of history. The oracle
 * pushes the latest value on a 50 ms window, sends `delta` afterwards and a full `text`
 * every 50 pushes. The tool-message window (50 ms) keeps `tool_execution_update` from
 * flushing the whole transcript per progress frame.
 *
 * Timers are single-shot, precise and parented to the session's timer context, so a
 * process reattach keeps them and destroying the session cancels them.
 */
class LiveChannels {
public:
    explicit LiveChannels(AgentSession *session);
    ~LiveChannels();

    /** Latest live thinking text; one frame per 50 ms window. */
    void pushThinking(const QString &text);
    /** `thinking_end` / first body `text_delta`: stamp the phase end and publish it once. */
    void thinkingEnded();
    /** `message_end`/settle: publish the final thinking frame (done=true) and clear it. */
    void finishThinking();
    /**
     * Accumulated live body text; one frame per 50 ms window.
     *
     * pi may send either deltas or a full partial snapshot. The accumulator is kept
     * here (oracle `streamingText`) instead of in the transcript: the transcript row is
     * written once at message_end, so a per-delta row upsert would reset it.
     */
    QString appendText(const QString &delta);
    QString replaceText(const QString &text);
    void pushText(const QString &text);
    /** `message_end`: flush the pending frame, publish done=true, clear the buffer. */
    void finishText();
    /** Coalesced `agents:message` window. Completed rows must survive shutdown of the window. */
    void scheduleMessages(bool completedRow = false);
    void flushPendingCompletedRows();
    /** Cancel a pending message window and publish the current transcript now. */
    void flushMessagesNow();
    /** `message_update(done|error)` can be followed by an identical `message_end`. */
    enum class AssistantBoundary { Update, End };
    void flushAssistantBoundary(AssistantBoundary boundary);
    /** A turn ended: cancel pending frames and finish leftover thinking. */
    void settle();
    /** Abort/stop/exit: drop every pending frame without emitting. */
    void reset();

private:
    void startThinkingTimer();
    void startTextTimer();
    void startMessageTimer();
    void emitThinkingFrame(const QString &text, bool done);
    void emitTextFrame(const QString &text, bool done);
    void publishMessages();
    void clearAssistantBoundary();

    AgentSession *m_session = nullptr;
    QTimer *m_thinkingTimer = nullptr;
    QTimer *m_textTimer = nullptr;
    QTimer *m_messageTimer = nullptr;
    bool m_completedRowPending = false;
    // Copy-on-write, kept only until the paired terminal frame or the next flush.
    QJsonArray m_lastAssistantUpdateMessages;
    QString m_lastAssistantUpdateFileVersion;
    /** Latest pushed values; empty when no delta has arrived for the current reply. */
    QString m_pendingThinking;
    QString m_pendingText;
    bool m_thinkingActive = false;
    bool m_textActive = false;
    QString m_lastSentThinking;
    QString m_lastSentText;
    int m_thinkingPushCount = 0;
    int m_textPushCount = 0;
};

} // namespace agentruntime
