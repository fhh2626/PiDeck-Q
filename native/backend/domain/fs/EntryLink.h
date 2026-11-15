#pragma once

#include <QString>

/**
 * Link-aware entry primitives, ported from the Node oracle (`src/main/fs/*`).
 *
 * The oracle decides everything with `lstat`: the entry itself is never followed, so a
 * dangling link is still an existing entry and a link to a directory is not a directory.
 * Only when classifying a copied link does it follow the link once (`stat(source)`) to
 * learn whether the *referent* is a directory, because Windows can create an
 * unprivileged junction for that case but needs a privileged symbolic link otherwise.
 *
 * Kept in its own translation unit so FileOperations stays a thin composition layer.
 */
namespace fsops {

/** atime/mtime captured before a copy, replayed onto the copy afterwards. */
struct EntryTimestamps {
    bool valid = false;
    // Windows: FILETIME ticks (100 ns since 1601-01-01). POSIX: nanoseconds since epoch.
    qint64 accessTicks = 0;
    qint64 writeTicks = 0;
};

/** lstat-style existence: a dangling link is an entry, its missing referent is not. */
bool entryExists(const QString &path);

/** True only for a real directory; a link (even one pointing at a directory) is not. */
bool isRealDirectory(const QString &path);

/**
 * True for any link entry: a file symlink or a directory junction.
 *
 * `QFileInfo::isSymLink()` reports Windows junctions as plain directories, so a copy
 * driven by it recurses into the referent instead of copying the link. This checks the
 * reparse tag itself, which is what `lstat` reports on the Node side.
 */
bool isLinkEntry(const QString &path);

/** Capture the source times before copying; mirrors the oracle's `lstat` snapshot. */
EntryTimestamps readTimestamps(const QString &path);

/**
 * Replay captured times onto a finished copy (Node applies `utimes` to every copied
 * file and to every copied directory after its children).
 */
void applyTimestamps(const QString &path, const EntryTimestamps &timestamps);

/**
 * Copy one link entry without touching its referent.
 *
 * The raw target is preserved. A link whose referent is a directory becomes a junction
 * on Windows (unprivileged, like Node's `symlink(..., "junction")`); a link with a
 * missing or non-directory referent becomes a file symbolic link. Never traverses or
 * copies the referent's content.
 */
void copyLinkEntry(const QString &source, const QString &destination);

/**
 * Remove exactly one entry.
 *
 * A link is unlinked/removed as a link, never recursed into, so deleting a junction
 * can never delete the directory it points at. A real (non-empty) directory is left
 * for the caller's recursive removal path. A read-only entry has its read-only bit
 * cleared and the delete retried once, like rimraf's `fixWinEPERM`.
 */
bool removeEntry(const QString &path);

/**
 * Remove one entry tree without ever following a link.
 *
 * Port of `fs.rm(path, {recursive:true, force:true})` at the entry level: a link is
 * unlinked as a link (its referent is untouched), a real directory is emptied child by
 * child and then removed. Throws `Unable to remove <path>` when an entry cannot be deleted.
 *
 * Use this instead of `QDir::removeRecursively()`: Qt classifies a Windows junction as a
 * plain directory, so the Qt helper would delete the whole content behind the link.
 */
void removeEntryTree(const QString &path);

} // namespace fsops
