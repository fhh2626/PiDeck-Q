#pragma once

#include "JsonlIndex.h"

#include <QHash>
#include <QJsonArray>
#include <QJsonObject>
#include <QString>
#include <QStringList>

/**
 * On-demand full text and tool export payloads (port of SessionHistoryReader's
 * readMessageFullText / readToolExportPayload(s) / readMessageByMessageId).
 *
 * These exist because the timeline deliberately truncates tool detail; "view full
 * output" must return the untruncated body from disk, not a longer truncation.
 */
namespace historytext {

/** `${agentId}-history-${entryId}` → entryId; empty when the id is not synthetic. */
QString syntheticHistoryEntryId(const QString &messageId);

struct FullText {
    bool ok = false;
    QString text;
    QString error;
};

/**
 * Read the untruncated text of one entry. `entryId` wins when present (physical-first
 * lookup, abandoned branches included); otherwise the first message with `messageId`.
 */
FullText readMessageFullText(const JsonlIndex &index, const QString &messageId, const QString &entryId);

/** One tool payload: raw arguments, result text and details, all untruncated. */
struct ToolExportPayload {
    bool hasArgsText = false;
    QString argsText;
    bool hasResultText = false;
    QString resultText;
    bool hasDetailsText = false;
    QString detailsText;
};

/** Batch read over the active branch; unknown ids yield an empty payload. */
QHash<QString, ToolExportPayload> readToolExportPayloads(const JsonlIndex &index,
                                                         const QStringList &messageIds);

/** Locate one message by renderer id / entry id and return its resend content. */
struct ResendTarget {
    bool found = false;
    QString entryId;
    QString role;
    QString text;
    QJsonArray images;
};
ResendTarget readMessageByMessageId(const JsonlIndex &index, const QString &messageId);

/** Concatenated `text` blocks of a message body (string content included). */
QString extractEntryResultText(const QJsonValue &message);

} // namespace historytext
