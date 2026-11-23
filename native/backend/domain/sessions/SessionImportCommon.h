#pragma once

#include "../MainCopy.h"
#include "SessionFs.h"
#include "SessionSummary.h"

#include <QJsonArray>
#include <QJsonObject>
#include <QString>
#include <QStringList>

/**
 * Shared pieces of the Codex / Claude / OpenCode importers.
 *
 * The three importers differ only in how they read their source format; the pi
 * session they emit, the title/preview derivation, the import-meta freshness check and
 * the `session_info` trailer are identical, so they live here to keep one behavior.
 */
namespace sessionimport {

/** Result of converting one foreign session into pi JSONL. */
struct Converted {
    QString raw;
    QString title;
    QString preview;
    int messageCount = 0;
};

/** Freshness marker read back from an already imported file. */
struct ImportMeta {
    bool found = false;
    qint64 sourceMtime = 0;
    qint64 sourceSize = 0;
};

/** `new` / `current` / `outdated`, matching the oracle's status derivation. */
QString statusOf(const ImportMeta &meta, qint64 sourceMtime, qint64 sourceSize);

/** `--C--Users-x--` style project session directory name. */
QString safePathToken(const QString &path);

/** `<piRoot>/<safePathToken(projectPath)>`. */
QString projectSessionDir(const QString &piRoot, const QString &projectPath);

/** Collapse whitespace, drop "untitled", clip to 40 characters with an ellipsis. */
QString cleanTitle(const QString &value);

/** First 8 hex characters of sha1(`<sessionId>:<sequence>`). */
QString makeId(const QString &sessionId, int sequence);

/** Random 8-character id for the appended `session_info` line. */
QString randomShortId();

/** `text` / `thinking` / `name` of each content block, space-joined. */
QString extractPiText(const QJsonArray &content);

QJsonObject zeroUsage();

/** String / text-array / JSON pretty-print of a tool output payload. */
QString extractToolOutput(const QJsonValue &payload);

/** Forward-slash, no trailing slash, lower-cased comparison key. */
QString normalizePath(const QString &path);

/** Recursive `*.jsonl` collection that tolerates unreadable directories. */
QStringList collectJsonl(const SessionFs &fs, const QString &directory);

/** Read the `<key>_import` marker from the first lines of an imported file. */
ImportMeta readImportMeta(const SessionFs &fs, const QString &targetPath, const QString &key);

/** Tolerant JSONL parse: non-object / truncated lines are skipped. */
QVector<QJsonObject> parseJsonl(const QString &raw);

/** `{source} 会话` / `{source} session` via the main-process copy table. */
QString importedTitle(const maincopy::Translator &translate, const QString &source);
QString importedPreview(const maincopy::Translator &translate, const QString &source);

/**
 * Append the pi-native `session_info` trailer.
 *
 * Only this form is emitted: the legacy header `sessionName` line (no `type`) breaks
 * pi's first-line validation and makes the session unloadable.
 */
QString sessionInfoLine(const QString &title, const QString &parentId, const QString &cwd);

/** Write UTF-8 text, creating the parent directory first. */
bool writeImported(const SessionFs &fs, const QString &path, const QString &raw, QString *error);

} // namespace sessionimport
