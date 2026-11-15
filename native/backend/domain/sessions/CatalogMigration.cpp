#include "CatalogMigration.h"

#include "SessionIdentity.h"

#include <QHash>

namespace catalogmigration {
namespace {

struct Candidate {
    CatalogEntry entry;
    bool wasRelative = false;
};

/**
 * Keep the runtime-relative identity (it is the one the user's preferences were
 * attached to), then the earliest creation time, then disk order.
 */
CatalogEntry mergeCollision(const QVector<Candidate> &group)
{
    QVector<Candidate> preferred = group;
    std::stable_sort(preferred.begin(), preferred.end(), [](const Candidate &left, const Candidate &right) {
        if (left.wasRelative != right.wasRelative) return left.wasRelative;
        return left.entry.createdAt < right.entry.createdAt;
    });
    const CatalogEntry winner = preferred.first().entry;

    QVector<CatalogEntry> recent;
    recent.reserve(group.size());
    for (const Candidate &candidate : group) recent.append(candidate.entry);
    std::stable_sort(recent.begin(), recent.end(), [](const CatalogEntry &left, const CatalogEntry &right) {
        return left.updatedAt > right.updatedAt;
    });

    CatalogEntry merged = winner;
    if (!merged.hasModel) {
        for (const CatalogEntry &entry : recent) {
            if (!entry.hasModel) continue;
            merged.hasModel = true;
            merged.modelProvider = entry.modelProvider;
            merged.modelId = entry.modelId;
            break;
        }
    }
    if (!merged.hasThinkingLevel) {
        for (const CatalogEntry &entry : recent) {
            if (!entry.hasThinkingLevel) continue;
            merged.hasThinkingLevel = true;
            merged.thinkingLevel = entry.thinkingLevel;
            break;
        }
    }
    if (merged.piSessionId.isEmpty()) {
        for (const CatalogEntry &entry : recent) {
            if (entry.piSessionId.isEmpty()) continue;
            merged.piSessionId = entry.piSessionId;
            break;
        }
    }
    // Overlay scan metadata oldest-to-newest so missing optional fields survive
    // without letting a stale preview overwrite a recent one.
    QJsonObject scanMetadata;
    bool hasScanMetadata = false;
    for (int index = recent.size() - 1; index >= 0; --index) {
        const CatalogEntry &entry = recent.at(index);
        if (!entry.hasScanMetadata) continue;
        for (auto iterator = entry.scanMetadata.constBegin(); iterator != entry.scanMetadata.constEnd();
             ++iterator) {
            scanMetadata.insert(iterator.key(), iterator.value());
        }
        hasScanMetadata = true;
    }
    merged.hasScanMetadata = hasScanMetadata;
    merged.scanMetadata = scanMetadata;
    for (const CatalogEntry &entry : recent) {
        if (!entry.hasIsInternalSubagent) continue;
        merged.hasIsInternalSubagent = true;
        merged.isInternalSubagent = entry.isInternalSubagent;
        break;
    }
    for (const CatalogEntry &entry : recent) {
        if (!entry.hasParentSessionPath) continue;
        merged.hasParentSessionPath = true;
        merged.parentSessionPath = entry.parentSessionPath;
        break;
    }
    qint64 createdAt = winner.createdAt;
    qint64 updatedAt = winner.updatedAt;
    for (const CatalogEntry &entry : recent) {
        createdAt = qMin(createdAt, entry.createdAt);
        updatedAt = qMax(updatedAt, entry.updatedAt);
    }
    merged.createdAt = createdAt;
    merged.updatedAt = updatedAt;
    return merged;
}

QString entryOriginKey(const CatalogEntry &entry)
{
    return sessionidentity::buildSessionOriginKey(entry.source, entry.environment, entry.filePath,
                                                  entry.wslDistro, entry.wslUser, entry.importedSourceId);
}

} // namespace

QVector<CatalogEntry> migrate(const QVector<CatalogEntry> &entries, const QStringList &originKeys,
                              const FilePathResolver &resolveFilePath, bool *changed)
{
    bool modified = false;
    QVector<CatalogEntry> normalized;
    normalized.reserve(entries.size());
    QStringList keys;
    keys.reserve(entries.size());

    for (int index = 0; index < entries.size(); ++index) {
        const CatalogEntry original = entries.at(index);
        const bool wasRelative = !original.filePath.isEmpty()
            && !sessionidentity::isAbsoluteSessionPath(original.filePath, original.environment);
        CatalogEntry entry = original;
        if (!original.filePath.isEmpty() && resolveFilePath) {
            const QString resolved =
                resolveFilePath(original.projectId, original.filePath, original.environment);
            if (!resolved.isEmpty() && resolved != original.filePath) {
                entry.filePath = resolved;
                entry.originKey = entryOriginKey(entry);
                modified = true;
            }
        }
        // A missing project can leave two identical relative strings pointing at
        // different files, and a fileless anonymous entry has no disk identity at all.
        const bool canGroup = !entry.noSession
            && sessionidentity::isAbsoluteSessionPath(entry.filePath, entry.environment);
        QString key = canGroup ? (index < originKeys.size() ? originKeys.at(index) : QString()) : QString();
        if (canGroup && key.isEmpty()) key = entryOriginKey(entry);
        if (canGroup && entry.originKey != key) {
            entry.originKey = key;
            modified = true;
        }
        normalized.append(entry);
        // Standalone entries get a per-index sentinel so they keep their position.
        keys.append(canGroup && !key.isEmpty() ? key : QStringLiteral("\u0000%1").arg(index));
        Q_UNUSED(wasRelative);
    }
    if (!modified) return entries;

    QStringList order;
    QHash<QString, QVector<int>> groups;
    for (int index = 0; index < keys.size(); ++index) {
        const QString &key = keys.at(index);
        auto found = groups.find(key);
        if (found == groups.end()) {
            order.append(key);
            groups.insert(key, QVector<int>{index});
        } else {
            found->append(index);
        }
    }

    QVector<CatalogEntry> result;
    result.reserve(order.size());
    for (const QString &key : order) {
        const QVector<int> indices = groups.value(key);
        if (indices.size() == 1) {
            result.append(normalized.at(indices.first()));
            continue;
        }
        QVector<Candidate> candidates;
        candidates.reserve(indices.size());
        for (const int index : indices) {
            const CatalogEntry &entry = normalized.at(index);
            const bool wasRelative = !entries.at(index).filePath.isEmpty()
                && !sessionidentity::isAbsoluteSessionPath(entries.at(index).filePath,
                                                           entries.at(index).environment);
            candidates.append(Candidate{entry, wasRelative});
        }
        result.append(mergeCollision(candidates));
    }
    return result;
}

void assignParentSessionIds(QVector<QJsonObject> *records)
{
    QHash<QString, QString> idByPath;
    for (const QJsonObject &record : *records) {
        const QString filePath = record.value(QStringLiteral("filePath")).toString();
        if (filePath.isEmpty()) continue;
        const QString environment = record.value(QStringLiteral("environment")).toString(QStringLiteral("native"));
        idByPath.insert(sessionidentity::canonicalizeSessionPath(filePath, environment),
                        record.value(QStringLiteral("id")).toString());
    }
    for (QJsonObject &record : *records) {
        const QString parentPath = record.value(QStringLiteral("parentSessionPath")).toString();
        if (parentPath.isEmpty()) continue;
        const QString environment = record.value(QStringLiteral("environment")).toString(QStringLiteral("native"));
        const QString parentId = idByPath.value(sessionidentity::canonicalizeSessionPath(parentPath, environment));
        if (!parentId.isEmpty()) record.insert(QStringLiteral("parentSessionId"), parentId);
    }
}

} // namespace catalogmigration
