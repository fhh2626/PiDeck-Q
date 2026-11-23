#pragma once

#include "../MainCopy.h"
#include "SessionFs.h"
#include "SessionImportCommon.h"

#include <QJsonObject>
#include <QString>

/**
 * Claude Code importer (port of src/main/sessions/ClaudeSessionImporter.ts).
 *
 * Sources live under `~/.claude/projects/<path-token>/**.jsonl`. The first `user` entry
 * carries `sessionId` + `cwd`; without it the file is not a Claude session and is
 * skipped instead of failing the whole scan.
 */
namespace claudeimport {

struct Session {
    QString sessionId;
    QString cwd;
    qint64 firstTimestamp = 0;
    qint64 lastTimestamp = 0;
    QVector<QJsonObject> entries;
    QString sourcePath;
    qint64 sourceSize = 0;
    qint64 sourceMtime = 0;
};

/** `~/.claude/projects/<token>` for one project path. */
QString projectDir(const QString &claudeRoot, const QString &projectPath);

QString targetPathFor(const QString &piRoot, const QString &projectPath, const Session &session);

/** Read + validate one Claude JSONL; false when the metadata is missing. */
bool readSession(const SessionFs &fs, const QString &filePath, Session *out);

sessionimport::Converted convert(const QString &projectPath, const Session &session,
                                 const maincopy::Translator &translate);

} // namespace claudeimport
