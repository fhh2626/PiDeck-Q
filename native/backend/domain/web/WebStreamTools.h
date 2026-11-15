#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QJsonValue>
#include <QString>
#include <QVector>

/**
 * Tool identity/input helpers for the LAN stream (port of `webStreamTools.ts`).
 *
 * Contract: a replay or a progress frame may carry a tool's *input*, never its result.
 * Inventing `tool-output-available` for a tool whose execution was never observed would
 * tell the phone a command succeeded when nobody knows what happened.
 */
namespace webstream {

/** Tool identity and input only. */
struct ToolInput {
    QString toolCallId;
    QString toolName;
    QJsonValue args;
};

/** `MAX_REPLAY_INPUT_CHARS`: bound for the retained replay snapshot. */
constexpr int kMaxReplayInputChars = 8000;

/**
 * Bounded, detached copy of an input for long-lived/reconnected streams.
 *
 * Strings are returned as-is (already-truncated JSON text must not be quoted again);
 * unsupported/cyclic input degrades to `{}` instead of failing the whole stream.
 */
QJsonValue snapshotToolInput(const QJsonValue &input);

/** Assistant snapshots (`content: [{type:"toolCall", id, name, arguments}]) → inputs. */
QVector<ToolInput> readAssistantToolCalls(const QJsonValue &content);

/** `toolResultMissingMetadata()`: the shared "no result recorded" marker. */
QJsonObject missingResultMetadata();

/**
 * Reject stale/cross-session runtime snapshots before seeding a cold translator.
 *
 * `snapshot` is `{target:{sessionId,agentId,runtimeGeneration}, value:[ChatMessage]}`;
 * only the running runtime's own projection may bootstrap the stream.
 */
QVector<ToolInput> readCurrentToolInputs(const QString &sessionId, const QJsonArray &runtimes,
                                         const QJsonObject &snapshot);

/** Only current, genuinely running tool rows; result fields are ignored. */
QVector<ToolInput> readRunningTools(const QJsonArray &messages);

} // namespace webstream
