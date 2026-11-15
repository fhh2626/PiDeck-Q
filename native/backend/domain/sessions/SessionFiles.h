#pragma once

#include <QByteArray>
#include <QString>

/**
 * Durable file primitives for session storage.
 *
 * Every session mutation that replaces a file must survive a crash mid-write: the
 * oracle writes a temp file, fsyncs it, then renames. QSaveFile alone is atomic but
 * does not fsync, so a power loss can leave a zero-length file where a session used
 * to be. These helpers add the flush barrier and the Windows rename retry loop that
 * the oracle has (src/main/utils/fsRetry.ts, atomicWriteFile.ts).
 */
namespace sessionfiles {

/** Read a whole file as UTF-8. Returns false with `error` on IO failure. */
bool readText(const QString &path, QString *content, QString *error);

/** Read at most `maxBytes` from the head of a file as UTF-8. */
bool readHead(const QString &path, qint64 maxBytes, QString *content, QString *error);

/** True when the path exists (file or directory). */
bool exists(const QString &path);
/** True when the path is an existing regular file. */
bool isFile(const QString &path);
/** True when the path is an existing directory. */
bool isDirectory(const QString &path);

/** Create the directory and every missing parent. */
bool makeDirectory(const QString &path, QString *error);

/**
 * Write `content` to `path` atomically: temp file in the same directory, flush,
 * fsync, rename with retry. Never leaves a truncated destination behind.
 */
bool writeAtomic(const QString &path, const QByteArray &content, QString *error);

/**
 * Copy `source` to `destination` atomically (temp + fsync + rename).
 * Used for the `.bak` rotation so a crash cannot corrupt the backup either.
 */
bool copyAtomic(const QString &source, const QString &destination, QString *error);

/** Rename with a short retry loop for Windows file locks. */
bool renameWithRetry(const QString &from, const QString &to, QString *error);

/** Rename that refuses to clobber an existing target. */
bool renameNoOverwrite(const QString &from, const QString &to, QString *error);

/** Remove one file; a missing file counts as success. */
bool removeFile(const QString &path);

/** Directory entry names (files and directories), unsorted. */
QStringList listNames(const QString &directory);

/** Recursive `*.jsonl` collection honouring the scanner's ignore rules. */
QStringList collectJsonlFiles(const QString &root, bool allowArchive);

/** True when the scanner must skip this path or directory name. */
bool isIgnoredScanPath(const QString &pathOrName, bool allowArchive);

/** The archive directory name used under every scan root. */
extern const char *const kArchiveDirName;
/** WSL soft-delete directory name (the Windows recycle bin cannot see WSL). */
extern const char *const kTrashDirName;
/** Archive index file name inside the archive directory. */
extern const char *const kArchiveIndexName;

} // namespace sessionfiles
