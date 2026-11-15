#include "FileOperations.h"
#include "CopyStream.h"
#include "EntryLink.h"
#include "../../process/TextEncoding.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonObject>
#include <QSaveFile>
#include <QUuid>

#include <algorithm>
#include <stdexcept>

#ifdef Q_OS_WIN
#include <windows.h>
#else
#include <unistd.h>
#endif
namespace fsops {

const char *const kRenameTargetExistsCode = "RENAME_TARGET_EXISTS";
const char *const kUnsupportedCopyTypeCode = "FILE_COPY_UNSUPPORTED_TYPE";

namespace {

const QStringList kIgnoredNames = {
    QStringLiteral(".git"),  QStringLiteral("node_modules"), QStringLiteral("dist"),
    QStringLiteral("build"), QStringLiteral(".next"),        QStringLiteral("coverage"),
    QStringLiteral(".venv"), QStringLiteral("__pycache__"),
};

std::runtime_error failure(const QString &message)
{
    return textenc::error(message);
}

void assertSingleEntryName(const QString &name)
{
    // Names are single directory entries: reject separators and traversal so a
    // create/rename cannot move an entry out of its parent.
    if (name.isEmpty() || name == QLatin1String(".") || name == QLatin1String("..")
        || name.contains(QLatin1String("..")) || name.contains(QLatin1Char('/'))
        || name.contains(QLatin1Char('\\'))) {
        throw failure(QStringLiteral("Invalid path: \"%1\" escapes parent directory").arg(name));
    }
}

#ifdef Q_OS_WIN
/**
 * Read 100 ns file times straight from the handle.
 *
 * Node exposes `stat().mtimeMs`/`ctimeMs` at 100 ns resolution on Windows, while
 * `QDateTime` truncates to milliseconds. The drawer sorts on these values, so the
 * listing keeps the same precision the renderer already receives from the Node
 * sidecar.
 */
void readWindowsFileTimes(const QString &path, double *mtimeMs, double *ctimeMs)
{
    const HANDLE handle = CreateFileW(reinterpret_cast<LPCWSTR>(path.utf16()), FILE_READ_ATTRIBUTES,
                                      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                                      OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
    if (handle == INVALID_HANDLE_VALUE) return;
    FILE_BASIC_INFO info{};
    const bool ok = GetFileInformationByHandleEx(handle, FileBasicInfo, &info, sizeof(info)) != 0;
    CloseHandle(handle);
    if (!ok) return;
    // FILETIME counts 100 ns ticks from 1601-01-01 UTC. Split into whole seconds and
    // nanoseconds before converting, exactly like libuv + Node do: dividing the raw
    // tick count would lose precision (it needs 58 bits) and drift from the oracle.
    constexpr qint64 kUnixEpochTicks = 116444736000000000LL;
    const auto toMilliseconds = [](qint64 fileTime) {
        const qint64 ticks = fileTime - kUnixEpochTicks;
        qint64 seconds = ticks / 10000000LL;
        qint64 nanos = (ticks % 10000000LL) * 100LL;
        if (nanos < 0) {
            nanos += 1000000000LL;
            seconds -= 1;
        }
        return double(seconds) * 1000.0 + double(nanos) / 1e6;
    };
    *mtimeMs = toMilliseconds(info.LastWriteTime.QuadPart);
    *ctimeMs = toMilliseconds(info.ChangeTime.QuadPart);
}
#endif

QJsonArray readDirectory(const QString &root, const QString &current, int depth, int maxDepth)
{
    QDir directory(current);
    const QFileInfoList entries =
        directory.entryInfoList(QDir::AllEntries | QDir::NoDotAndDotDot | QDir::Hidden, QDir::NoSort);
    QList<QJsonObject> nodes;
    nodes.reserve(entries.size());
    for (const QFileInfo &entry : entries) {
        if (isIgnoredName(entry.fileName())) continue;
        const QString absolutePath = entry.absoluteFilePath();
        // The Node oracle reads dirent types, which do not follow links, so a symlinked entry
        // is neither a directory nor a file and is not listed. `QFileInfo::isSymLink()` alone
        // is not enough on Windows: Qt reports a junction as a plain directory
        // (`isDir() == true`, `isSymLink() == false`), which would emit it as a directory node
        // and then walk the referent - listing names outside the authorized root. The reparse
        // tag probe is the same `lstat` semantic the oracle sees.
        if (entry.isSymLink()) continue;
        if (entry.isDir() && isLinkEntry(absolutePath)) continue;
        QString relativePath = QDir(root).relativeFilePath(absolutePath);
        relativePath.replace(QLatin1Char('\\'), QLatin1Char('/'));
        QJsonObject node{
            {QStringLiteral("name"), entry.fileName()},
            {QStringLiteral("path"), absolutePath},
            {QStringLiteral("relativePath"), relativePath},
        };
        // A racing delete or a permission failure must not abort the whole listing:
        // the node is still shown, just without sort metadata.
        if (entry.exists()) {
            double mtimeMs = double(entry.lastModified().toMSecsSinceEpoch());
            double ctimeMs = double(entry.metadataChangeTime().toMSecsSinceEpoch());
#ifdef Q_OS_WIN
            readWindowsFileTimes(absolutePath, &mtimeMs, &ctimeMs);
#endif
            node.insert(QStringLiteral("mtimeMs"), mtimeMs);
            // Node reports the Windows change time as ctime, which is what the drawer
            // sorts on; QFileInfo only exposes it with millisecond precision.
            node.insert(QStringLiteral("ctimeMs"), ctimeMs);
            node.insert(QStringLiteral("size"), entry.isDir() ? 0.0 : double(entry.size()));
        }
        if (entry.isDir()) {
            node.insert(QStringLiteral("type"), QStringLiteral("directory"));
            node.insert(QStringLiteral("children"),
                        depth < maxDepth ? readDirectory(root, absolutePath, depth + 1, maxDepth) : QJsonArray{});
        } else if (entry.isFile()) {
            node.insert(QStringLiteral("type"), QStringLiteral("file"));
        } else {
            continue;
        }
        nodes.append(node);
    }
    std::stable_sort(nodes.begin(), nodes.end(), [](const QJsonObject &left, const QJsonObject &right) {
        const bool leftDir = left.value(QStringLiteral("type")).toString() == QLatin1String("directory");
        const bool rightDir = right.value(QStringLiteral("type")).toString() == QLatin1String("directory");
        if (leftDir != rightDir) return leftDir;
        return QString::localeAwareCompare(left.value(QStringLiteral("name")).toString(),
                                           right.value(QStringLiteral("name")).toString())
            < 0;
    });
    QJsonArray result;
    for (const QJsonObject &node : nodes) result.append(node);
    return result;
}

ReadResult readBytes(const QString &path, qint64 maxBytes, bool base64)
{
    ReadResult result;
    QFile file(path);
    if (!file.exists()) {
        // The oracle returns "" for ENOENT so the renderer can show "unsupported"
        // instead of a filesystem error.
        result.ok = true;
        return result;
    }
    if (!file.open(QIODevice::ReadOnly)) throw failure(QStringLiteral("Unable to read file"));
    const qint64 size = file.size();
    if (maxBytes > 0 && size > maxBytes) {
        // Structured prefix so the renderer can offer a fallback instead of showing
        // a raw filesystem error.
        throw failure(QStringLiteral("FILE_TOO_LARGE:%1:%2").arg(size).arg(maxBytes));
    }
    const QByteArray bytes = readAllChecked(file, path, maxBytes);
    if (maxBytes > 0 && bytes.size() > maxBytes) {
        // Fallback for a file that grew past the limit after `size()` was sampled: the
        // reported size is the bounded prefix, not the whole file, because reading it all
        // to print the exact size is what this guard exists to prevent.
        throw failure(QStringLiteral("FILE_TOO_LARGE:%1:%2").arg(bytes.size()).arg(maxBytes));
    }
    result.ok = true;
    result.content = base64 ? QString::fromLatin1(bytes.toBase64()) : QString::fromUtf8(bytes);
    return result;
}

} // namespace

bool isIgnoredName(const QString &name)
{
    return kIgnoredNames.contains(name);
}

QJsonArray listTree(const QString &root, int maxDepth)
{
    const QFileInfo info(root);
    if (!info.exists() || !info.isDir()) throw failure(QStringLiteral("Project directory is missing"));
    return readDirectory(root, root, 0, maxDepth);
}

ReadResult readText(const QString &path, qint64 maxBytes)
{
    return readBytes(path, maxBytes, false);
}

ReadResult readBase64(const QString &path, qint64 maxBytes)
{
    return readBytes(path, maxBytes, true);
}

void writeText(const QString &path, const QString &content)
{
    // QSaveFile is atomic: a crash mid-write leaves the previous content intact
    // rather than a truncated file.
    QSaveFile file(path);
    if (!file.open(QIODevice::WriteOnly)) throw failure(QStringLiteral("Unable to write file"));
    file.write(content.toUtf8());
    if (!file.commit()) throw failure(QStringLiteral("Unable to commit file"));
}

QString createEntry(const QString &parentDir, const QString &name, const QString &type)
{
    const QString fullPath = joinEntryName(parentDir, name);
    if (type == QLatin1String("directory")) {
        if (!QDir().mkdir(fullPath)) throw failure(QStringLiteral("File already exists: %1").arg(fullPath));
        return fullPath;
    }
    if (type != QLatin1String("file")) throw failure(QStringLiteral("File type must be file or directory."));
    // QIODevice::NewOnly is the exclusive-create equivalent of Node's "wx": an
    // existing file is never truncated and concurrent creates have one winner.
    QFile file(fullPath);
    if (!file.open(QIODevice::WriteOnly | QIODevice::NewOnly)) {
        throw failure(QStringLiteral("File already exists: %1").arg(fullPath));
    }
    file.close();
    return fullPath;
}

QString renameEntry(const QString &path, const QString &newName)
{
    assertSingleEntryName(newName);
    const QFileInfo info(path);
    const QString target = QDir(info.path()).filePath(newName);
    if (path == target) return target;

#ifdef Q_OS_WIN
    const bool caseOnlyChange = path.compare(target, Qt::CaseInsensitive) == 0;
#else
    const bool caseOnlyChange = false;
#endif
    if (caseOnlyChange) {
        // Windows/macOS treat the two names as one entry, so a pre-check would see
        // the source as a conflict. Go through a temporary name instead.
        const QString temporary = QDir(info.path())
                                      .filePath(QStringLiteral(".%1.%2.renaming")
                                                    .arg(info.fileName(),
                                                         QUuid::createUuid().toString(QUuid::WithoutBraces)));
        if (!QDir().rename(path, temporary)) throw failure(QStringLiteral("Unable to rename %1").arg(path));
        if (!QDir().rename(temporary, target)) {
            QDir().rename(temporary, path);
            throw failure(QStringLiteral("Unable to rename %1").arg(path));
        }
        return target;
    }
    if (entryExists(target)) {
        throw failure(QStringLiteral("%1: %2").arg(QLatin1String(kRenameTargetExistsCode), target));
    }
    if (!QDir().rename(path, target)) throw failure(QStringLiteral("Unable to rename %1").arg(path));
    return target;
}

void copyWithoutOverwrite(const QString &source, const QString &destination, CopyAttempt *attempt)
{
    const QFileInfo sourceInfo(source);
    // Reparse-tag probe, not QFileInfo::isSymLink(): Qt reports Windows junctions as
    // plain directories, and copying one that way would recurse into its referent.
    if (isLinkEntry(source)) {
        // Links are copied as links: the raw target is preserved, a directory referent
        // becomes a junction, and the referent's content is never read or traversed.
        if (entryExists(destination)) {
            if (attempt) attempt->destinationTaken = true;
            throw failure(QStringLiteral("Destination already exists: %1").arg(destination));
        }
        try {
            fsops::copyLinkEntry(source, destination);
        } catch (...) {
            // A link create that lost a race reports EEXIST at the destination path, which is
            // the only failure `copyToFreeName` may retry.
            if (attempt) attempt->destinationTaken = entryExists(destination);
            throw;
        }
        return;
    }
    if (sourceInfo.isDir()) {
        // Never merge into an existing directory: that would write into a directory
        // a competing writer may own. A dangling link at `destination` is an existing
        // entry (lstat semantics), not a free name.
        if (entryExists(destination)) {
            if (attempt) attempt->destinationTaken = true;
            throw failure(QStringLiteral("Destination already exists: %1").arg(destination));
        }
        // Captured before copying because the oracle replays the pre-copy times.
        const EntryTimestamps timestamps = readTimestamps(source);
        if (!QDir().mkdir(destination)) {
            // A failed reserve is a name collision only when something now holds the name.
            if (attempt) attempt->destinationTaken = entryExists(destination);
            throw failure(QStringLiteral("Unable to create %1").arg(destination));
        }
        const QFileInfoList children = QDir(source).entryInfoList(
            QDir::AllEntries | QDir::NoDotAndDotDot | QDir::Hidden, QDir::NoSort);
        for (const QFileInfo &child : children) {
            // The candidate directory now exists, so any child failure below is reported with
            // `destinationTaken == false`: it is an inner-entry failure, never a collision.
            copyWithoutOverwrite(child.absoluteFilePath(), QDir(destination).filePath(child.fileName()));
        }
        QFile::setPermissions(destination, sourceInfo.permissions());
        // Applied last so writing the children cannot disturb the copied directory time.
        applyTimestamps(destination, timestamps);
        return;
    }
    if (!sourceInfo.isFile()) throw failure(QLatin1String(kUnsupportedCopyTypeCode));
    const EntryTimestamps timestamps = readTimestamps(source);
    // Exclusive create: no-clobber must be guaranteed by the syscall, not by a
    // pre-check that a racing writer can invalidate.
    QFile sourceFile(source);
    if (!sourceFile.open(QIODevice::ReadOnly)) throw failure(QStringLiteral("Unable to read %1").arg(source));
    QFile destinationFile(destination);
    if (!destinationFile.open(QIODevice::WriteOnly | QIODevice::NewOnly)) {
        // NewOnly fails for EEXIST and for EACCES; only an entry at the destination makes
        // this a collision the free-name loop may retry.
        if (attempt) attempt->destinationTaken = entryExists(destination);
        throw failure(QStringLiteral("Destination already exists: %1").arg(destination));
    }
    // Stream in bounded blocks and fail on any short write/read error: a single
    // `readAll()` + `write()` reported ENOSPC/EIO as success and left `files:move`
    // deleting the source behind an empty destination (the oracle's `copyFile` rejects).
    // The wrapper also closes both handles and, on any failure *after* this exclusive
    // create, removes the truncated destination it just created - the same cleanup the
    // oracle's `copyFile` performs. Only a file this call created can be removed: a
    // pre-existing target never gets past the `NewOnly` open above.
    copyNewFileContentsWithCleanup(sourceFile, destinationFile, destination, source);
    QFile::setPermissions(destination, sourceInfo.permissions());
    // Node copies the bytes and then restores atime/mtime, so a copied file keeps the
    // source's timestamps instead of the copy time.
    applyTimestamps(destination, timestamps);
}

QString copyToFreeName(const QString &source, const QString &targetDir, const QString &name)
{
    const QFileInfo nameInfo(name);
    const QString extension = nameInfo.suffix().isEmpty() ? QString() : QStringLiteral(".") + nameInfo.suffix();
    const QString stem = extension.isEmpty() ? name : name.left(name.size() - extension.size());
    constexpr int kMaxAttempts = 1000;
    for (int attempt = 0; attempt < kMaxAttempts; ++attempt) {
        const QString candidate = attempt == 0
            ? QDir(targetDir).filePath(name)
            : QDir(targetDir).filePath(QStringLiteral("%1 (%2)%3").arg(stem).arg(attempt).arg(extension));
        if (entryExists(candidate)) continue;
        CopyAttempt copy;
        try {
            copyWithoutOverwrite(source, candidate, &copy);
            return candidate;
        } catch (const std::exception &) {
            // Only a *top-level* collision is retried (oracle `copyToFreeName`: retry on
            // `EEXIST` at the candidate path only). An inner-entry failure leaves the
            // candidate directory behind, so "the candidate exists now" is not evidence of a
            // collision: retrying it created up to 1000 orphan partial copies and reported
            // COPY_NAME_EXHAUSTED instead of the real cause. A partial *directory* tree stays,
            // exactly like the oracle's non-recursive `cp`; a failed *file* copy removes the
            // truncated destination its own create produced (see `copyWithoutOverwrite`).
            if (copy.destinationTaken) continue;
            throw;
        }
    }
    throw failure(QStringLiteral("COPY_NAME_EXHAUSTED: %1").arg(name));
}

bool samePath(const QString &left, const QString &right)
{
    const QString a = QDir::cleanPath(QDir::fromNativeSeparators(left));
    const QString b = QDir::cleanPath(QDir::fromNativeSeparators(right));
#ifdef Q_OS_WIN
    return a.compare(b, Qt::CaseInsensitive) == 0;
#else
    return a == b;
#endif
}

bool isPathInside(const QString &parent, const QString &candidate)
{
    const QString a = QDir::cleanPath(QDir::fromNativeSeparators(parent));
    const QString b = QDir::cleanPath(QDir::fromNativeSeparators(candidate));
    if (a.isEmpty() || b.isEmpty()) return false;
    QString prefix = a;
    if (!prefix.endsWith(QLatin1Char('/'))) prefix += QLatin1Char('/');
#ifdef Q_OS_WIN
    return b.startsWith(prefix, Qt::CaseInsensitive);
#else
    return b.startsWith(prefix);
#endif
}

QString joinEntryName(const QString &parentDir, const QString &name)
{
    assertSingleEntryName(name);
    return QDir(parentDir).filePath(name);
}

} // namespace fsops
