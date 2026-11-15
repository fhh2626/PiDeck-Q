#pragma once

#include <QJsonObject>
#include <QString>
#include <QVector>

/**
 * Scan result for one session file (SessionSummary in src/shared/types/session.ts).
 *
 * Optional fields carry explicit `has*` flags so the catalog can tell "scanner did
 * not report it" from "scanner reported an empty value"; mergeScanned relies on that
 * distinction to avoid overwriting user preferences with absent scan data.
 */
struct SessionSummary {
    QString filePath;
    bool hasProjectPath = false;
    QString projectPath;
    bool hasName = false;
    QString name;
    bool hasIsInternalSubagent = false;
    bool isInternalSubagent = false;
    bool hasParentSessionPath = false;
    QString parentSessionPath;
    QString preview;
    qint64 updatedAt = 0;
    int messageCount = 0;
    QString source = QStringLiteral("pi");
    bool wsl = false;
    bool hasModel = false;
    QString modelProvider;
    QString modelId;
    bool hasThinkingLevel = false;
    QString thinkingLevel;
    QString codexSessionId;
    QString codexThreadSource;
    QString codexParentThreadId;
    QString codexAgentRole;
    QString codexAgentNickname;
};
