#pragma once

#include "WebStreamTools.h"

#include <QHash>
#include <QJsonObject>
#include <QSet>
#include <QString>
#include <QVector>

/**
 * pi RPC events → AI SDK v5 UIMessageStream frames.
 *
 * Port of `PiEventToUiMessageStream` (src/main/web/WebEventStream.ts). The translator is
 * stateful per run: it tracks whether the text/reasoning block and each tool part were
 * already announced, because `useChat` throws (and drops the rest of the reply) when a
 * `*-delta`/`tool-output-*` arrives without its opening frame.
 *
 * Two rules are easy to get wrong and are enforced here:
 *  - `agent_end` is only the end of one LLM step (a tool loop continues afterwards), so
 *    it must not close the stream; only `agent_settled` (or an error) finishes the run;
 *  - a tool whose execution was never observed may only be closed back to
 *    `input-available` with the shared "result missing" marker, never to a fabricated
 *    success/failure output.
 */
namespace webstream {

class Adapter {
public:
    /** Translate one pi event into 0..n frames. */
    QVector<QJsonObject> push(const QJsonObject &event);

    /** Replay only active tool inputs to one new subscriber (never text or results). */
    QVector<QJsonObject> replayActiveTools(const QVector<ToolInput> &snapshot = {});

    /** Close the current run (disconnect/idle fallback) without inventing content. */
    QVector<QJsonObject> finish();

    bool isFinished() const { return m_finished; }

private:
    struct ActiveTool {
        ToolInput input;
        /** Structured input of the live run; replay snapshots may be truncated. */
        QJsonValue liveInput;
    };

    QVector<QJsonObject> handleAssistantEvent(const QJsonObject &event);
    QVector<QJsonObject> startTool(const QJsonObject &event);
    QVector<QJsonObject> startTool(const ToolInput &call);
    QVector<QJsonObject> endTool(const QJsonObject &event);
    QVector<QJsonObject> ensureToolStarted(const QString &toolCallId, const QString &toolName,
                                           const QJsonValue &input);
    QVector<QJsonObject> finishTool(const QString &toolCallId, const QString &toolName,
                                    const QJsonValue &input, bool isError);
    QVector<QJsonObject> closeOpenBlocks();
    QVector<QJsonObject> finishMessage(const QJsonObject &event);
    QJsonValue retainedToolInput(const QString &toolCallId) const;
    QString resolveToolCallId(const QJsonValue &rawId, const QString &toolName);
    QString blockId(const QString &prefix);
    void rememberTool(const QString &toolCallId, const QString &toolName, const QJsonValue &args,
                      const QJsonValue &liveInput);
    void forgetTool(const QString &toolCallId);

    QString m_textBlockId;
    QString m_reasoningBlockId;
    QString m_currentMessageId;
    QString m_lastStartedToolCallId;
    bool m_hasTextDelta = false;
    bool m_hasReasoningDelta = false;
    bool m_finished = false;
    /** Insertion-ordered sets: frame order must follow pi's declaration order. */
    QVector<QString> m_startedToolCallIds;
    QSet<QString> m_startedToolCallSet;
    QSet<QString> m_finishedToolCallIds;
    QVector<QString> m_activeOrder;
    QHash<QString, ActiveTool> m_activeToolCalls;
    quint64 m_blockCounter = 0;
};

/** Serialize one SSE frame (`data: {json}\n\n`). */
QString serializeFrame(const QJsonObject &frame);

/** `[DONE]` terminator expected by the AI SDK. */
extern const char *const kSseDone;

} // namespace webstream
