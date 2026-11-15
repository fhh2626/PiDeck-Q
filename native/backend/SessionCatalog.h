#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QString>

struct SessionCatalogRead {
    bool ok = false;
    QJsonArray sessions;
    QString error;
};

SessionCatalogRead listSessionFiles(const QString &sessionsDir, const QString &projectPath = {});

struct SessionMessagePage {
    bool ok = false;
    QJsonObject page;
    QString error;
};

SessionMessagePage readSessionMessagePage(const QString &filePath, int before, int pageSize);
SessionCatalogRead createSessionDraft(const QString &sessionsDir, const QString &name, const QString &projectPath);
SessionCatalogRead renameSessionFile(const QString &sessionsDir, const QString &filePath, const QString &name);
SessionCatalogRead archiveSessionFile(const QString &sessionsDir, const QString &filePath);
SessionCatalogRead unarchiveSessionFile(const QString &sessionsDir, const QString &archivedPath);
SessionCatalogRead deleteSessionFile(const QString &sessionsDir, const QString &filePath);
SessionCatalogRead copySessionFile(const QString &sessionsDir, const QString &filePath);
