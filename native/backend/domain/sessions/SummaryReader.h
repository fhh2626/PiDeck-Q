#pragma once

#include "SessionFs.h"
#include "SessionSummary.h"

#include "../MainCopy.h"

#include <QJsonObject>
#include <QSet>
#include <QString>
#include <QStringList>

/**
 * JSONL → SessionSummary (port of SessionScanner.readSummary).
 *
 * A single damaged line must not remove a session from the list: pi is often killed
 * mid-write, so per-line parse failures are skipped while a file with **no** readable
 * record is treated as "not a session" (and cached as such).
 */
namespace summaryreader {

struct Context {
    SessionFs fs;
    QStringList scanRoots;
    QSet<QString> knownSubagentSessions;
    maincopy::Translator translate;
    QString hostHome;
    /** `~/.codex/sessions`, used to resolve Codex thread metadata. */
    QString codexRoot;
};

struct Result {
    /** False when the file has no readable entry (empty or entirely corrupt). */
    bool isSession = false;
    SessionSummary summary;
};

Result read(const QString &filePath, const QString &raw, qint64 mtimeMs, const Context &context);

/**
 * Wire/summary-cache JSON for one scanned session (`SessionSummary` in shared/types).
 *
 * The same shape is returned by `sessions:list` and persisted by the summary cache, so
 * there is exactly one serializer for it. Absent optional fields are omitted, matching
 * the oracle's `undefined` handling; `id` mirrors `filePath` because the renderer keys
 * session rows by id.
 */
QJsonObject toJson(const SessionSummary &summary);

/**
 * Parse one cached summary. Returns false for a record that cannot be a summary (not an
 * object, or a non-string/non-numeric required field) so the cache drops it instead of
 * serving a half-built entry.
 */
bool fromJson(const QJsonObject &value, SessionSummary *out);

/**
 * JSON number → whole milliseconds, rounded down.
 *
 * The summary cache persists numbers that are compared against `stat()` versions and
 * `updatedAt`; JSON has no integer type, so a truncated or hand-edited cache file can
 * carry `1e308`, `-1e308` or a value outside qint64. Converting those with a plain
 * `qint64(double)` cast is undefined behaviour.
 *
 * Returns false when the value is not a number, is not finite, or does not fit qint64;
 * the caller then drops the record (the cache is derived data, so a rescan is correct).
 */
bool jsonWholeMillis(const QJsonValue &value, qint64 *out);

/** True when the head of a file looks like a pi session (has a `type` field). */
bool hasSessionHeader(const QString &head);

/** pi encoded-cwd directory name → display path. */
QString inferProjectPathFromFile(const QString &filePath);

} // namespace summaryreader
