#include "AgentTranscript.h"
#include "SessionEntryIds.h"

#include <QCoreApplication>
#include <QJsonDocument>
#include <cstdio>

namespace {
struct Conversation {
    QVector<QJsonValue> entries;
    QVector<QJsonValue> messages;
    QStringList ids;
};

Conversation conversation(int turns)
{
    Conversation result;
    QString parent;
    for (int turn = 1; turn <= turns; ++turn) {
        for (const QString &role : {QStringLiteral("user"), QStringLiteral("assistant")}) {
            const QString id = QStringLiteral("%1%2").arg(role.left(1)).arg(turn);
            const QJsonObject message{{"role", role}, {"content", QJsonArray{QJsonObject{{"type", "text"}, {"text", id}}}},
                                      {"timestamp", turn * 10 + (role == QLatin1String("user") ? 0 : 1)}};
            result.entries.append(QJsonObject{{"type", "message"}, {"id", id}, {"parentId", parent}, {"message", message}});
            result.messages.append(message);
            result.ids.append(id);
            parent = id;
        }
    }
    return result;
}

agentruntime::Transcript makeTranscript()
{
    agentruntime::Transcript transcript;
    transcript.configure(QStringLiteral("history-agent"),
        [](const QString &key, const QJsonObject &) { return key; });
    return transcript;
}
} // namespace

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    auto transcript = makeTranscript();
    transcript.appendMessage(QStringLiteral("user"), QStringLiteral("retained question"), {});
    QJsonObject outputCases{{"ordinary", transcript.flushPayload(QStringLiteral("1:10"))}};
    Conversation full = conversation(6);
    transcript.applyProjection(full.messages, full.ids, {});
    transcript.configureHistory(full.ids, 0, true, true);
    outputCases.insert("before", transcript.flushPayload("1:100"));
    transcript.messageFlushDelivered();
    full.entries.append(QJsonObject{{"type", "compaction"}, {"id", "compact"}, {"parentId", "a6"},
                                    {"firstKeptEntryId", "u5"}, {"summary", "summary"}});
    // A physically later abandoned branch must not alter the active file cursor.
    full.entries.append(QJsonObject{{"type", "message"}, {"id", "abandoned"}, {"parentId", "u1"},
                                    {"message", QJsonObject{{"role", "user"}, {"content", "other branch"}}}});
    const auto activeIds = sessionentryids::buildActiveBranchEntryIds(full.entries, "compact");
    const auto fileIds = sessionentryids::buildActiveBranchEntryIds(full.entries, "compact", true);
    QVector<QJsonValue> compacted{QJsonObject{{"role", "compactionSummary"}, {"summary", "summary"}, {"timestamp", 100}}};
    for (int i = 8; i < full.messages.size(); ++i) compacted.append(full.messages.at(i));
    transcript.applyProjection(compacted, activeIds, {});
    transcript.configureHistory(fileIds, 8, true, true);
    outputCases.insert("compacted", transcript.flushPayload("2:200"));
    outputCases.insert("undelivered", transcript.flushPayload("2:200"));
    transcript.messageFlushDelivered();
    outputCases.insert("delivered", transcript.flushPayload("2:200"));

    auto fallback = makeTranscript();
    fallback.applyProjection(full.messages, {}, {});
    fallback.configureHistory(fileIds, 0, true, true);
    outputCases.insert("beforeWithoutEntryIds", fallback.flushPayload("1:100"));
    fallback.messageFlushDelivered();
    fallback.applyProjection(compacted, {}, {});
    fallback.configureHistory(fileIds, 8, true, true);
    outputCases.insert("withoutEntryIds", fallback.flushPayload("2:200"));
    fallback.messageFlushDelivered();
    fallback.applyProjection(compacted, activeIds, {});
    fallback.configureHistory(fileIds, 8, true, true);
    outputCases.insert("entryIdsRestored", fallback.flushPayload("2:200"));

    auto shiftedEstimate = makeTranscript();
    shiftedEstimate.applyProjection(compacted, {}, {});
    shiftedEstimate.configureHistory({}, 7, true, true);
    outputCases.insert("shiftedCursorEstimate", shiftedEstimate.flushPayload("2:200"));

    auto unknownCursor = makeTranscript();
    unknownCursor.applyProjection(full.messages, {}, {});
    unknownCursor.configureHistory({}, -1, true, true);
    outputCases.insert("unknownCursorBefore", unknownCursor.flushPayload({}));
    unknownCursor.messageFlushDelivered();
    unknownCursor.applyProjection(compacted, {}, {});
    unknownCursor.configureHistory({}, -1, true, true);
    outputCases.insert("unknownCursorCompacted", unknownCursor.flushPayload({}));

    // Equal content and timestamps can still be distinct persisted turns. Repeated
    // compaction must respect their different entry identities during prefix dedupe.
    auto repeated = makeTranscript();
    QVector<QJsonValue> repeatedRaw;
    for (const QJsonValue &value : full.messages) {
        auto message = value.toObject();
        message.insert("content", QJsonArray{QJsonObject{{"type", "text"},
            {"text", message.value("role").toString() == QLatin1String("user") ? "continue" : "done"}}});
        message.insert("timestamp", 1000);
        repeatedRaw.append(message);
    }
    for (const int start : {0, 8, 10}) {
        const auto raw = repeatedRaw.mid(start);
        repeated.applyProjection(raw, full.ids.mid(start), {});
        repeated.configureHistory(fileIds, start, true, true);
        outputCases.insert(QStringLiteral("repeated%1").arg(start),
            repeated.flushPayload(QStringLiteral("repeat:%1").arg(start)));
        repeated.messageFlushDelivered();
    }

    transcript.applyProjection({full.messages.at(10), full.messages.at(11)}, {"u6", "a6"}, {});
    transcript.configureHistory(fileIds, 10, true, true);
    outputCases.insert("secondCompaction", transcript.flushPayload("3:300"));
    transcript.messageFlushDelivered();
    transcript.configureHistory(fileIds, 10, false, false);
    outputCases.insert("mutation", transcript.flushPayload("3:300"));

    auto trimmed = makeTranscript();
    const Conversation longHistory = conversation(60);
    trimmed.applyProjection(longHistory.messages, longHistory.ids, {});
    trimmed.configureHistory(longHistory.ids, 0, true, false);
    outputCases.insert("beforeTrim", trimmed.flushPayload("4:400"));
    trimmed.messageFlushDelivered();
    trimmed.trimToTurns(50);
    outputCases.insert("trimmed", trimmed.flushPayload("4:400"));
    trimmed.messageFlushDelivered();
    outputCases.insert("trimDelivered", trimmed.flushPayload("4:400"));
    for (const QString &variant : {QStringLiteral("orphan"), QStringLiteral("empty")}) {
        auto withoutIds = makeTranscript();
        auto raw = longHistory.messages;
        QJsonObject changed = raw.at(1).toObject();
        if (variant == QLatin1String("orphan")) {
            QJsonArray content = changed.value("content").toArray();
            content.append(QJsonObject{{"type", "toolCall"}, {"id", "missing"}, {"name", "read"}, {"arguments", QJsonObject{}}});
            changed.insert("content", content);
        } else {
            changed.insert("content", QJsonArray{});
        }
        raw[1] = changed;
        raw.prepend(QJsonObject{{"role", "compactionSummary"}, {"summary", "archived"}, {"timestamp", 100}});
        withoutIds.applyProjection(raw, {}, {});
        withoutIds.configureHistory({}, 8, true, true);
        withoutIds.messageFlushDelivered();
        withoutIds.trimToTurns(50);
        outputCases.insert(variant + "Trim", withoutIds.flushPayload("5:500"));
    }
    // Bash executions have a JSONL slot even though this projector does not render
    // them. Exercise both the numeric fallback and exact entry-id alignment.
    const QJsonObject bash{{"role", "bashExecution"}, {"command", "pwd"}, {"output", "/repo"},
                           {"exitCode", 0}, {"timestamp", 1000}};
    for (const QString &variant : {QStringLiteral("bashTail"), QStringLiteral("bashMiddle")}) {
        auto raw = longHistory.messages;
        auto ids = longHistory.ids;
        const int position = variant == QLatin1String("bashTail") ? int(raw.size()) : 1;
        raw.insert(position, bash);
        ids.insert(position, variant);
        auto withoutIds = makeTranscript();
        withoutIds.applyProjection(raw, {}, {});
        const int head = int(ids.size()) - sessionentryids::countMessageEntries(raw);
        withoutIds.configureHistory(ids, head, true, true);
        outputCases.insert(variant, withoutIds.flushPayload("6:600"));
        withoutIds.messageFlushDelivered();
        withoutIds.trimToTurns(50);
        outputCases.insert(variant + "Trim", withoutIds.flushPayload("6:600"));
        auto withIds = makeTranscript();
        withIds.applyProjection(raw, ids, {});
        withIds.configureHistory(ids, head, true, true);
        outputCases.insert(variant + "WithIds", withIds.flushPayload("6:600"));
    }
    const QByteArray output = QJsonDocument(outputCases)
                                 .toJson(QJsonDocument::Compact);
    std::fwrite(output.constData(), 1, size_t(output.size()), stdout);
    std::fputc('\n', stdout);
    return 0;
}
