#pragma once

#include "../MainCopy.h"
#include "SessionFs.h"
#include "SessionImportCommon.h"

#include <QJsonObject>
#include <QString>
#include <QVector>

/**
 * OpenCode importer (port of src/main/sessions/OpenCodeSessionImporter.ts).
 *
 * OpenCode keeps every project's history in one SQLite database
 * (`~/.local/share/opencode/opencode.db`), so the source is read through Qt SQL in
 * read-only mode and never modified. `sourcePath` is `<db>#<sessionId>` because a
 * session has no file of its own.
 */
namespace opencodeimport {

struct Part {
    QString id;
    QString messageId;
    qint64 timeCreated = 0;
    qint64 timeUpdated = 0;
    QJsonObject data;
};

struct Message {
    QString id;
    qint64 timeCreated = 0;
    qint64 timeUpdated = 0;
    QJsonObject data;
    QVector<Part> parts;
};

struct Session {
    QJsonObject meta;
    QVector<Message> messages;
    QString sourcePath;
    qint64 sourceSize = 0;
    qint64 sourceMtime = 0;
};

/** True when the SQLite driver and the database file are both available. */
bool available(const QString &databasePath, QString *error);

/** Read every session whose project worktree or directory matches `projectPath`. */
QVector<Session> readSessions(const QString &databasePath, const QString &projectPath, QString *error);

QString targetPathFor(const QString &piRoot, const QString &projectPath, const Session &session);

sessionimport::Converted convert(const QString &projectPath, const Session &session,
                                 const maincopy::Translator &translate);

} // namespace opencodeimport
