#pragma once

#include <QJsonArray>
#include <QString>
#include <QStringList>

/**
 * Filesystem primitives, ported from src/main/fs/*.
 *
 * These are the operations only; authorization lives in PathPolicy and the channel
 * layer composes the two. Everything here is synchronous and is expected to be
 * called from a worker thread (see process/BackgroundWork.h) so a large directory
 * walk never stalls the renderer RPC or SSE stream.
 */
namespace fsops {

/** Raised when a rename target already exists; the channel layer localizes it. */
extern const char *const kRenameTargetExistsCode;
/** Raised for FIFO/device/socket sources that cannot be copied item by item. */
extern const char *const kUnsupportedCopyTypeCode;

/** Default recursion bound for the file drawer (mirrors DEFAULT_FILE_TREE_MAX_DEPTH). */
constexpr int kDefaultMaxDepth = 12;

/** Directory names the file drawer never descends into. */
bool isIgnoredName(const QString &name);

/** Recursive tree with dirs-first name ordering and per-entry stat metadata. */
QJsonArray listTree(const QString &root, int maxDepth = kDefaultMaxDepth);

struct ReadResult {
    bool ok = false;
    QString content;
    QString error;
};

/** UTF-8 read. A missing file yields `ok` with empty content (oracle returns ""). */
ReadResult readText(const QString &path, qint64 maxBytes);
/** Base64 read. A missing file yields `ok` with empty content. */
ReadResult readBase64(const QString &path, qint64 maxBytes);

void writeText(const QString &path, const QString &content);

/** Create one entry; exclusive so an existing entry is never truncated or merged. */
QString createEntry(const QString &parentDir, const QString &name, const QString &type);

/** Rename without overwriting; throws kRenameTargetExistsCode on conflict. */
QString renameEntry(const QString &path, const QString &newName);

/** Copy to `targetDir/name`, auto-renaming to "name (n).ext" on conflict. */
QString copyToFreeName(const QString &source, const QString &targetDir, const QString &name);

/**
 * Why a single exclusive copy attempt failed.
 *
 * `copyToFreeName` may only move on to the next candidate name when the *top-level*
 * destination could not be reserved (the oracle retries on `EEXIST` at the candidate path
 * only). An inner-entry failure leaves the candidate behind, so the caller must not infer a
 * collision from "the path exists now".
 */
struct CopyAttempt {
    /** True when the top-level destination entry already existed (a name collision). */
    bool destinationTaken = false;
};

/**
 * Item-by-item exclusive copy: never follows source links, never merges directories.
 *
 * `attempt`, when given, reports whether the failure was a top-level collision or an
 * inner-entry failure.
 */
void copyWithoutOverwrite(const QString &source, const QString &destination,
                          CopyAttempt *attempt = nullptr);

/** True when both paths resolve to the same entry (case-insensitive on Windows). */
bool samePath(const QString &left, const QString &right);
/** True when `candidate` is strictly below `parent`. */
bool isPathInside(const QString &parent, const QString &candidate);

/** Join one directory entry name onto a directory, rejecting separators and "..". */
QString joinEntryName(const QString &parentDir, const QString &name);

} // namespace fsops
