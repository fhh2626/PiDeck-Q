#pragma once

#include "../MainCopy.h"
#include "SessionFs.h"
#include "SessionImportCommon.h"

#include <QJsonObject>
#include <QString>
#include <QStringList>

/**
 * Codex rollout importer (port of src/main/sessions/CodexSessionImporter.ts).
 *
 * `~/.codex/sessions` stores every project's sessions under UUID directories, so the
 * scan is two-phase: a 64 KiB header read extracts `session_meta.cwd` for project
 * filtering, and only candidates get their full body parsed. A 1 GB rollout therefore
 * costs 64 KiB when it belongs to another project.
 */
namespace codeximport {

constexpr qint64 kMetaHeadLimit = 64 * 1024;

struct Session {
    QJsonObject meta;
    QVector<QJsonObject> entries;
    QString sourcePath;
    qint64 sourceSize = 0;
    qint64 sourceMtime = 0;
};

struct Summary {
    QString id;
    QString sourcePath;
    QString targetPath;
    QString cwd;
    QString title;
    QString preview;
    qint64 createdAt = 0;
    qint64 updatedAt = 0;
    int messageCount = 0;
    QString status;
    qint64 sourceSize = 0;
    bool hasImportedSourceMtime = false;
    qint64 importedSourceMtime = 0;
    QString threadSource;
    QString parentThreadId;
    QString agentRole;
    QString agentNickname;
};

/** Thread metadata recorded by the codex import marker (subagent rollouts). */
struct ThreadInfo {
    QString threadSource;
    QString parentThreadId;
    QString agentRole;
    QString agentNickname;
};

ThreadInfo threadInfoOf(const QJsonObject &meta);

/**
 * Build the pi JSONL for one rollout.
 * `raw` is the full file text; `session.entries` may be empty (header-only scan).
 */
sessionimport::Converted convert(const QString &projectPath, const Session &session,
                                 const maincopy::Translator &translate);

/** Header-only read used for project pre-filtering; empty meta when absent. */
bool readMetaOnly(const SessionFs &fs, const QString &filePath, Session *out);

/** Full read (whole file). */
bool readSession(const SessionFs &fs, const QString &filePath, Session *out);

QString targetPathFor(const QString &piRoot, const QString &projectPath, const Session &session);

} // namespace codeximport
