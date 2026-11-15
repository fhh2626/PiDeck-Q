#include "SessionCatalogStore.h"

#include "CatalogTypes.h"
#include "SessionIdentity.h"

#include <QJsonArray>
#include <QJsonObject>

/**
 * Catalog record serialization (the renderer-facing SessionRecord shape).
 *
 * Split out of SessionCatalogStore.cpp so the store stays focused on load/save and
 * mutation semantics while this file owns the one place that decides which optional
 * fields appear on the wire.
 */

QString SessionCatalogStore::resolveProjectPath(const CatalogEntry &entry) const
{
    if (!m_resolveProjectPath) return QString();
    return m_resolveProjectPath(entry.projectId, entry.environment);
}

QJsonObject SessionCatalogStore::recordFromEntry(const CatalogEntry &entry, const SessionSummary *summary) const
{
    QJsonObject record;
    record.insert(QStringLiteral("id"), entry.id);
    record.insert(QStringLiteral("projectId"), entry.projectId);
    record.insert(QStringLiteral("title"),
                  summary && summary->hasName && !summary->name.isEmpty() ? summary->name : entry.title);
    if (entry.noSession) record.insert(QStringLiteral("noSession"), true);
    record.insert(QStringLiteral("source"), summary ? summary->source : entry.source);
    record.insert(QStringLiteral("environment"),
                  summary ? (summary->wsl ? QStringLiteral("wsl") : QStringLiteral("native")) : entry.environment);
    const QString filePath = summary ? summary->filePath : entry.filePath;
    if (!filePath.isEmpty()) record.insert(QStringLiteral("filePath"), filePath);
    if (!entry.wslDistro.isEmpty()) record.insert(QStringLiteral("wslDistro"), entry.wslDistro);
    if (!entry.wslUser.isEmpty()) record.insert(QStringLiteral("wslUser"), entry.wslUser);
    const QString importedSourceId = summary && summary->source == QLatin1String("codex")
        ? summary->codexSessionId
        : entry.importedSourceId;
    if (!importedSourceId.isEmpty()) record.insert(QStringLiteral("importedSourceId"), importedSourceId);
    const bool hasInternal = summary ? summary->hasIsInternalSubagent : entry.hasIsInternalSubagent;
    const bool internal = summary ? summary->isInternalSubagent : entry.isInternalSubagent;
    if (hasInternal) record.insert(QStringLiteral("isInternalSubagent"), internal);
    const bool hasParent = summary ? summary->hasParentSessionPath : entry.hasParentSessionPath;
    const QString parentPath = summary ? summary->parentSessionPath : entry.parentSessionPath;
    if (hasParent) record.insert(QStringLiteral("parentSessionPath"), parentPath);

    QString projectPath;
    if (summary && summary->hasProjectPath) {
        projectPath = summary->projectPath;
    } else if (entry.hasScanMetadata) {
        projectPath = entry.scanMetadata.value(QStringLiteral("projectPath")).toString();
    }
    if (projectPath.isEmpty()) projectPath = resolveProjectPath(entry);
    if (!projectPath.isEmpty()) record.insert(QStringLiteral("projectPath"), projectPath);

    record.insert(QStringLiteral("preview"),
                  summary ? summary->preview
                          : entry.scanMetadata.value(QStringLiteral("preview")).toString());
    record.insert(QStringLiteral("messageCount"),
                  summary ? summary->messageCount
                          : entry.scanMetadata.value(QStringLiteral("messageCount")).toInt(0));
    record.insert(QStringLiteral("status"), entry.status);
    // Stored preferences win over the file summary, exactly like the oracle's
    // `recordFromEntry` (`entry.model` / `entry.thinkingLevel`). The merge step already
    // inherits them from the file when the catalog has none, so a scan must not
    // resurrect a level the runtime clamped or a model the user switched away from.
    const bool hasModel = entry.hasModel || (summary && summary->hasModel);
    if (hasModel) {
        record.insert(QStringLiteral("model"), QJsonObject{
            {QStringLiteral("provider"),
             entry.hasModel ? entry.modelProvider : summary->modelProvider},
            {QStringLiteral("modelId"), entry.hasModel ? entry.modelId : summary->modelId},
        });
    }
    const bool hasThinking = entry.hasThinkingLevel || (summary && summary->hasThinkingLevel);
    if (hasThinking) {
        record.insert(QStringLiteral("thinkingLevel"),
                      entry.hasThinkingLevel ? entry.thinkingLevel : summary->thinkingLevel);
    }
    record.insert(QStringLiteral("createdAt"), double(entry.createdAt));
    record.insert(QStringLiteral("updatedAt"), double(summary ? summary->updatedAt : entry.updatedAt));

    const bool hasWsl = summary ? summary->wsl
                                : entry.scanMetadata.contains(QStringLiteral("wsl"))
                                      && entry.scanMetadata.value(QStringLiteral("wsl")).isBool();
    if (hasWsl) {
        record.insert(QStringLiteral("wsl"),
                      summary ? summary->wsl : entry.scanMetadata.value(QStringLiteral("wsl")).toBool());
    }
    const QString codexSessionId = summary ? summary->codexSessionId
                                           : entry.scanMetadata.value(QStringLiteral("codexSessionId")).toString();
    if (!codexSessionId.isEmpty()) record.insert(QStringLiteral("codexSessionId"), codexSessionId);
    const QString threadSource = summary ? summary->codexThreadSource
                                         : entry.scanMetadata.value(QStringLiteral("codexThreadSource")).toString();
    if (!threadSource.isEmpty()) record.insert(QStringLiteral("codexThreadSource"), threadSource);
    const QString parentThreadId = summary ? summary->codexParentThreadId
                                           : entry.scanMetadata.value(QStringLiteral("codexParentThreadId")).toString();
    if (!parentThreadId.isEmpty()) record.insert(QStringLiteral("codexParentThreadId"), parentThreadId);
    const QString agentRole = summary ? summary->codexAgentRole
                                      : entry.scanMetadata.value(QStringLiteral("codexAgentRole")).toString();
    if (!agentRole.isEmpty()) record.insert(QStringLiteral("codexAgentRole"), agentRole);
    const QString agentNickname = summary ? summary->codexAgentNickname
                                          : entry.scanMetadata.value(QStringLiteral("codexAgentNickname")).toString();
    if (!agentNickname.isEmpty()) record.insert(QStringLiteral("codexAgentNickname"), agentNickname);
    return record;
}

