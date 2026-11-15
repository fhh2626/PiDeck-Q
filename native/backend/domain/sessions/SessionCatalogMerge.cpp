#include "CatalogMigration.h"
#include "SessionCatalogStore.h"
#include "SessionIdentity.h"

#include "../ChannelRegistry.h"

#include <QMutexLocker>

#include <QDateTime>
#include <QHash>
#include <QJsonArray>
#include <QUuid>

#include <algorithm>

namespace {

QString summaryOriginKey(const SessionSummary &summary, const SessionCatalogStore::Context &context)
{
    const QString environment = summary.wsl ? QStringLiteral("wsl") : QStringLiteral("native");
    const QString source = summary.source.isEmpty() ? QStringLiteral("pi") : summary.source;
    const QString importedSourceId = source == QLatin1String("codex") ? summary.codexSessionId : QString();
    return sessionidentity::buildSessionOriginKey(source, environment, summary.filePath,
                                                  summary.wsl ? context.wslDistro : QString(),
                                                  summary.wsl ? context.wslUser : QString(),
                                                  importedSourceId);
}

QJsonValue scanMetadataFor(const SessionSummary &summary)
{
    QJsonObject metadata{
        {QStringLiteral("projectPath"), summary.hasProjectPath ? summary.projectPath : QString()},
        {QStringLiteral("preview"), summary.preview},
        {QStringLiteral("messageCount"), summary.messageCount},
        {QStringLiteral("wsl"), summary.wsl},
    };
    if (!summary.codexSessionId.isEmpty()) {
        metadata.insert(QStringLiteral("codexSessionId"), summary.codexSessionId);
    }
    if (!summary.codexThreadSource.isEmpty()) {
        metadata.insert(QStringLiteral("codexThreadSource"), summary.codexThreadSource);
    }
    if (!summary.codexParentThreadId.isEmpty()) {
        metadata.insert(QStringLiteral("codexParentThreadId"), summary.codexParentThreadId);
    }
    if (!summary.codexAgentRole.isEmpty()) {
        metadata.insert(QStringLiteral("codexAgentRole"), summary.codexAgentRole);
    }
    if (!summary.codexAgentNickname.isEmpty()) {
        metadata.insert(QStringLiteral("codexAgentNickname"), summary.codexAgentNickname);
    }
    return catalogjson::sanitizeScanMetadata(metadata);
}

} // namespace

QJsonArray SessionCatalogStore::mergeScanned(const QString &projectId,
                                             const QVector<SessionSummary> &summaries,
                                             const Context &context)
{
    // One transaction: copy → durable write → assign. A draft created between the copy and
    // the assign used to be dropped by the second write, and the record projection below
    // reads `m_entries` again, so the whole merge must see one stable snapshot.
    QMutexLocker<QRecursiveMutex> lock(&m_mutex);
    assertLoaded();
    QVector<CatalogEntry> next = m_entries;
    QHash<QString, int> byOrigin;
    for (int index = 0; index < next.size(); ++index) {
        if (!next.at(index).originKey.isEmpty()) byOrigin.insert(next.at(index).originKey, index);
    }
    QHash<QString, int> summaryByEntryIndex;
    bool changed = false;

    for (const SessionSummary &summary : summaries) {
        const QString originKey = summaryOriginKey(summary, context);
        const QString importedSourceId =
            summary.source == QLatin1String("codex") ? summary.codexSessionId : QString();
        const QString environment = summary.wsl ? QStringLiteral("wsl") : QStringLiteral("native");
        const QString source = summary.source.isEmpty() ? QStringLiteral("pi") : summary.source;
        int index = byOrigin.value(originKey, -1);
        if (index < 0) {
            CatalogEntry entry;
            entry.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
            entry.projectId = projectId;
            entry.originKey = originKey;
            entry.title = summary.hasName && !summary.name.isEmpty() ? summary.name : QStringLiteral("Untitled");
            entry.source = source;
            entry.environment = environment;
            entry.filePath = summary.filePath;
            entry.wslDistro = summary.wsl ? context.wslDistro : QString();
            entry.wslUser = summary.wsl ? context.wslUser : QString();
            entry.importedSourceId = importedSourceId;
            entry.status = QStringLiteral("active");
            entry.hasIsInternalSubagent = summary.hasIsInternalSubagent;
            entry.isInternalSubagent = summary.isInternalSubagent;
            entry.hasParentSessionPath = summary.hasParentSessionPath;
            entry.parentSessionPath = summary.parentSessionPath;
            entry.createdAt = summary.updatedAt != 0 ? summary.updatedAt : QDateTime::currentMSecsSinceEpoch();
            entry.updatedAt = entry.createdAt;
            next.append(entry);
            index = next.size() - 1;
            byOrigin.insert(originKey, index);
            changed = true;
        } else {
            CatalogEntry &entry = next[index];
            const QString nextTitle =
                summary.hasName && !summary.name.isEmpty() ? summary.name : entry.title;
            if (entry.projectId != projectId || entry.filePath != summary.filePath
                || entry.title != nextTitle || entry.source != source
                || entry.environment != environment
                || entry.wslDistro != (summary.wsl ? context.wslDistro : QString())
                || entry.wslUser != (summary.wsl ? context.wslUser : QString())
                || entry.importedSourceId != importedSourceId
                || entry.status != QLatin1String("active")
                || entry.hasIsInternalSubagent != summary.hasIsInternalSubagent
                || entry.isInternalSubagent != summary.isInternalSubagent
                || entry.hasParentSessionPath != summary.hasParentSessionPath
                || entry.parentSessionPath != summary.parentSessionPath
                || entry.updatedAt != summary.updatedAt) {
                entry.projectId = projectId;
                entry.filePath = summary.filePath;
                entry.title = nextTitle;
                entry.source = source;
                entry.environment = environment;
                entry.wslDistro = summary.wsl ? context.wslDistro : QString();
                entry.wslUser = summary.wsl ? context.wslUser : QString();
                entry.importedSourceId = importedSourceId;
                entry.status = QStringLiteral("active");
                // Internal identity and parentage can be discovered by a later scan;
                // persisting the change stops the record resurfacing as a top-level orphan.
                entry.hasIsInternalSubagent = summary.hasIsInternalSubagent;
                entry.isInternalSubagent = summary.isInternalSubagent;
                entry.hasParentSessionPath = summary.hasParentSessionPath;
                entry.parentSessionPath = summary.parentSessionPath;
                entry.updatedAt = summary.updatedAt;
                changed = true;
            }
        }
        CatalogEntry &entry = next[index];
        summaryByEntryIndex.insert(entry.id, index);
        // Restore model/thinking from the session file when the catalog lacks them.
        // An explicit user pick is already stored and must win.
        if (!entry.hasModel && summary.hasModel) {
            entry.hasModel = true;
            entry.modelProvider = summary.modelProvider;
            entry.modelId = summary.modelId;
            changed = true;
        }
        if (!entry.hasThinkingLevel && summary.hasThinkingLevel) {
            entry.hasThinkingLevel = true;
            entry.thinkingLevel = summary.thinkingLevel;
            changed = true;
        }
        const QJsonValue metadata = scanMetadataFor(summary);
        const QJsonValue current = entry.hasScanMetadata ? QJsonValue(entry.scanMetadata)
                                                         : QJsonValue(QJsonValue::Undefined);
        if (!catalogjson::sameScanMetadata(current, metadata)) {
            entry.hasScanMetadata = metadata.isObject();
            entry.scanMetadata = metadata.toObject();
            changed = true;
        }
    }

    if (changed) {
        writeSnapshot(next);
        m_entries = next;
    }

    QVector<QJsonObject> records;
    for (const CatalogEntry &entry : m_entries) {
        if (entry.projectId != projectId) continue;
        const int entryIndex = summaryByEntryIndex.value(entry.id, -1);
        const SessionSummary *summary = nullptr;
        if (entryIndex >= 0) {
            for (const SessionSummary &candidate : summaries) {
                if (summaryOriginKey(candidate, context) != entry.originKey) continue;
                summary = &candidate;
                break;
            }
        }
        records.append(recordFromEntry(entry, summary));
    }
    catalogmigration::assignParentSessionIds(&records);
    std::sort(records.begin(), records.end(), [](const QJsonObject &left, const QJsonObject &right) {
        return left.value(QStringLiteral("updatedAt")).toDouble()
            > right.value(QStringLiteral("updatedAt")).toDouble();
    });
    for (const CatalogEntry &entry : m_transientEntries) {
        if (entry.projectId != projectId) continue;
        records.append(recordFromEntry(entry, nullptr));
    }
    std::sort(records.begin(), records.end(), [](const QJsonObject &left, const QJsonObject &right) {
        return left.value(QStringLiteral("updatedAt")).toDouble()
            > right.value(QStringLiteral("updatedAt")).toDouble();
    });
    QJsonArray result;
    for (const QJsonObject &record : records) result.append(record);
    return result;
}
