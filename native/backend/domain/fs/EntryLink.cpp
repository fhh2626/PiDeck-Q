#include "EntryLink.h"
#include "../../../common/ScopedMutation.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>

#include <climits>
#include <cstring>
#include <stdexcept>
#include <vector>

#ifdef Q_OS_WIN
#include <windows.h>
#include <winioctl.h>
#else
#include <sys/stat.h>
#include <unistd.h>

#include <fcntl.h>
#endif

namespace fsops {
namespace {

std::runtime_error failure(const QString &message)
{
    return std::runtime_error(message.toUtf8().constData());
}

#ifdef Q_OS_WIN
/**
 * Wide buffer for one Win32 call.
 *
 * `QString::toStdWString()` must not be used: std::wstring has no stable ABI on MSVC and
 * the debug build's _ITERATOR_DEBUG_LEVEL differs from the release-built Qt DLL, so the
 * returned object faults when it is destroyed (same reason as PtyProcessWindows.cpp).
 */
std::vector<wchar_t> wideBuffer(const QString &path)
{
    QString native = QDir::toNativeSeparators(path);
    // Qt enumerates long paths, but its child QFileInfo values can drop an existing
    // extended prefix. Reapply it at every Win32 boundary so recursive deletion
    // cannot mistake a long descendant for a missing entry and leave its parent.
    if (native.size() >= MAX_PATH - 12 && !native.startsWith(QLatin1String("\\\\?\\"))) {
        if (native.startsWith(QLatin1String("\\\\"))) {
            native = QStringLiteral("\\\\?\\UNC\\") + native.mid(2);
        } else if (native.size() >= 3 && native.at(1) == QLatin1Char(':')
                   && native.at(2) == QLatin1Char('\\')) {
            native.prepend(QStringLiteral("\\\\?\\"));
        }
    }
    std::vector<wchar_t> buffer(static_cast<size_t>(native.size()) + 1, L'\0');
    native.toWCharArray(buffer.data());
    return buffer;
}

/** Owns a Win32 handle so every early return still closes it. */
class ScopedHandle
{
public:
    explicit ScopedHandle(HANDLE handle = INVALID_HANDLE_VALUE) : handle_(handle) {}
    ~ScopedHandle()
    {
        if (handle_ != INVALID_HANDLE_VALUE) CloseHandle(handle_);
    }
    ScopedHandle(const ScopedHandle &) = delete;
    ScopedHandle &operator=(const ScopedHandle &) = delete;
    bool valid() const { return handle_ != nullptr && handle_ != INVALID_HANDLE_VALUE; }
    HANDLE get() const { return handle_; }

private:
    HANDLE handle_;
};

HANDLE openEntry(const QString &path, DWORD access, DWORD flagsAndAttributes)
{
    const std::vector<wchar_t> native = wideBuffer(path);
    return CreateFileW(native.data(), access, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                       nullptr, OPEN_EXISTING, flagsAndAttributes, nullptr);
}

DWORD attributesOf(const QString &path)
{
    const std::vector<wchar_t> native = wideBuffer(path);
    return GetFileAttributesW(native.data());
}

bool linkEntryProbe(const QString &path)
{
    ScopedHandle handle(openEntry(path, 0, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS));
    if (!handle.valid()) return false;
    FILE_ATTRIBUTE_TAG_INFO info{};
    if (!GetFileInformationByHandleEx(handle.get(), FileAttributeTagInfo, &info, sizeof(info))) return false;
    if ((info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0) return false;
    // Only tags a link copy can reproduce; other reparse points (dedup, cloud
    // placeholders) are not links and must not be treated as one.
    return info.ReparseTag == IO_REPARSE_TAG_SYMLINK || info.ReparseTag == IO_REPARSE_TAG_MOUNT_POINT;
}

/**
 * Windows errors libuv reports as ENOENT, i.e. "the referent does not exist".
 *
 * The oracle tolerates only ENOENT when it stats a link's target
 * (`src/main/fs/copyWithoutOverwrite.ts`); every other failure (EACCES, ELOOP, a dead
 * drive) has to propagate instead of being read as "this is a file link".
 */
bool isMissingReferentError(DWORD code)
{
    return code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND
        || code == ERROR_BAD_NETPATH || code == ERROR_BAD_NET_NAME || code == ERROR_INVALID_DRIVE;
}

// The mount-point/symlink reparse payload starts after the 8-byte reparse header; all
// offsets and lengths below are byte counts relative to that payload.
struct ReparseNamePair {
    USHORT substituteOffset = 0;
    USHORT substituteLength = 0;
    USHORT printOffset = 0;
    USHORT printLength = 0;
};

constexpr DWORD kMaxReparseBytes = 16 * 1024;

/**
 * Read the raw target of `source` exactly like Node's `readlink`, and report whether the
 * *referent* is currently a directory.
 *
 * Opening the path without FILE_FLAG_OPEN_REPARSE_POINT follows the link, so the handle
 * names the referent; a dangling link fails to open and is therefore classified as a
 * file link, matching the oracle's `stat(...)`-ENOENT handling.
 */
QString readLinkTarget(const QString &source, bool *referentIsDirectory)
{
    ScopedHandle handle(openEntry(source, 0, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS));
    if (!handle.valid()) throw failure(QStringLiteral("Unable to read link %1").arg(source));

    *referentIsDirectory = false;
    ScopedHandle referent(openEntry(source, FILE_READ_ATTRIBUTES, FILE_FLAG_BACKUP_SEMANTICS));
    if (referent.valid()) {
        FILE_ATTRIBUTE_TAG_INFO info{};
        if (GetFileInformationByHandleEx(referent.get(), FileAttributeTagInfo, &info, sizeof(info))) {
            *referentIsDirectory = (info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
        }
    } else if (!isMissingReferentError(GetLastError())) {
        // Only a missing referent means "this is a file link". Any other failure (access
        // denied, a reparse loop, a dead drive) must surface: silently turning it into a
        // file link would copy a directory link as a privileged symlink or report a
        // misleading error.
        throw failure(QStringLiteral("Unable to read link %1").arg(source));
    }

    std::vector<unsigned char> buffer(kMaxReparseBytes);
    DWORD returned = 0;
    if (!DeviceIoControl(handle.get(), FSCTL_GET_REPARSE_POINT, nullptr, 0, buffer.data(),
                         static_cast<DWORD>(buffer.size()), &returned, nullptr)
        || returned < 16) {
        throw failure(QStringLiteral("Unable to read link %1").arg(source));
    }
    const ULONG tag = *reinterpret_cast<const ULONG *>(buffer.data());
    if (tag != IO_REPARSE_TAG_SYMLINK && tag != IO_REPARSE_TAG_MOUNT_POINT) {
        throw failure(QStringLiteral("Unable to read link %1").arg(source));
    }
    ReparseNamePair names;
    std::memcpy(&names, buffer.data() + 8, sizeof(names));
    // The four USHORTs occupy bytes 8..15; the path buffer follows them, plus the
    // symlink-only Flags ULONG before it.
    const size_t pathBuffer = 16 + (tag == IO_REPARSE_TAG_SYMLINK ? 4 : 0);
    const auto slice = [&](USHORT offset, USHORT length) {
        if (length == 0 || pathBuffer + offset + length > returned) return QString();
        return QString(reinterpret_cast<const QChar *>(buffer.data() + pathBuffer + offset), length / 2);
    };
    const QString substitute = slice(names.substituteOffset, names.substituteLength);
    if (!substitute.isEmpty()) return substitute;
    return slice(names.printOffset, names.printLength);
}

/**
 * Convert a raw link target into the absolute NT path a junction requires.
 *
 * A relative target is relative to the link's own directory, never the process CWD:
 * resolving it against the CWD is what made `QFileInfo(target).isDir()` misclassify links.
 */
QString junctionTarget(const QString &sourceLink, const QString &rawTarget)
{
    QString absolute = rawTarget;
    if (rawTarget.startsWith(QLatin1String("\\??\\"))) {
        absolute = rawTarget.mid(4);
        if (absolute.startsWith(QLatin1String("UNC\\"), Qt::CaseInsensitive)) {
            absolute = QStringLiteral("\\\\") + absolute.mid(4);
        }
    } else if (QDir::isRelativePath(rawTarget)) {
        absolute = QDir(QFileInfo(sourceLink).absolutePath()).absoluteFilePath(rawTarget);
    }
    const QString native = QDir::toNativeSeparators(QDir::cleanPath(absolute));
    if (native.startsWith(QLatin1String("\\\\"))) return QStringLiteral("\\??\\UNC\\") + native.mid(2);
    return QStringLiteral("\\??\\") + native;
}

/** Create a directory junction (mount point reparse tag): no privilege required. */
void createJunction(const QString &sourceLink, const QString &destination, const QString &rawTarget)
{
    const QString substitute = junctionTarget(sourceLink, rawTarget);
    // The junction must use the NT form; the printed name is what Explorer shows.
    const QString printName = substitute.mid(4);
    const USHORT substituteBytes = USHORT(substitute.size() * sizeof(wchar_t));
    const USHORT printBytes = USHORT(printName.size() * sizeof(wchar_t));
    std::vector<wchar_t> substituteBuffer(static_cast<size_t>(substitute.size()) + 1, L'\0');
    substitute.toWCharArray(substituteBuffer.data());
    std::vector<wchar_t> printBuffer(static_cast<size_t>(printName.size()) + 1, L'\0');
    printName.toWCharArray(printBuffer.data());

    const std::vector<wchar_t> nativeDestination = wideBuffer(destination);
    if (!CreateDirectoryW(nativeDestination.data(), nullptr)) {
        throw failure(QStringLiteral("Unable to copy link %1").arg(destination));
    }
    bool linked = false;
    {
        ScopedHandle handle(openEntry(destination, GENERIC_WRITE,
                                      FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS));
        if (handle.valid()) {
            // Layout: reparse header, four USHORT name offsets/lengths, then the path
            // buffer holding the substitute and print names, each null terminated.
            const USHORT pathBufferBytes = USHORT(substituteBytes + sizeof(wchar_t) + printBytes + sizeof(wchar_t));
            const USHORT reparseDataBytes = USHORT(8 + pathBufferBytes);
            std::vector<unsigned char> buffer(size_t(8) + reparseDataBytes, 0);
            ULONG tag = IO_REPARSE_TAG_MOUNT_POINT;
            std::memcpy(buffer.data(), &tag, sizeof(tag));
            std::memcpy(buffer.data() + 4, &reparseDataBytes, sizeof(reparseDataBytes));
            const USHORT substituteOffset = 0;
            const USHORT printOffset = USHORT(substituteBytes + sizeof(wchar_t));
            unsigned char *names = buffer.data() + 8;
            std::memcpy(names, &substituteOffset, sizeof(substituteOffset));
            std::memcpy(names + 2, &substituteBytes, sizeof(substituteBytes));
            std::memcpy(names + 4, &printOffset, sizeof(printOffset));
            std::memcpy(names + 6, &printBytes, sizeof(printBytes));
            std::memcpy(names + 8, substituteBuffer.data(), substituteBytes);
            std::memcpy(names + 8 + printOffset, printBuffer.data(), printBytes);
            DWORD returned = 0;
            linked = DeviceIoControl(handle.get(), FSCTL_SET_REPARSE_POINT, buffer.data(),
                                     static_cast<DWORD>(buffer.size()), nullptr, 0, &returned, nullptr) != 0;
        }
    }
    if (!linked) {
        // Roll back only the placeholder directory this call created; any pre-existing
        // entry (and the source/referent) is left untouched.
        RemoveDirectoryW(nativeDestination.data());
        throw failure(QStringLiteral("Unable to copy link %1").arg(destination));
    }
}

/** Create a file symbolic link; needs Developer Mode or elevation on Windows. */
void createFileLink(const QString &destination, const QString &rawTarget)
{
    const std::vector<wchar_t> nativeDestination = wideBuffer(destination);
    const std::vector<wchar_t> nativeTarget = wideBuffer(rawTarget);
    // 0x2 == SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE; kept numeric so older SDKs
    // still compile.
    if (!CreateSymbolicLinkW(nativeDestination.data(), nativeTarget.data(), 0x2)) {
        throw failure(QStringLiteral("Unable to copy link %1").arg(destination));
    }
}

/**
 * Clear the read-only attribute so a delete can proceed (rimraf `fixWinEPERM`).
 *
 * `DeleteFileW`/`RemoveDirectoryW` fail with ERROR_ACCESS_DENIED on a read-only entry. The
 * oracle removes with `fs.rm(recursive, force)`, whose Windows path chmods the entry and
 * retries, so a move of a read-only file must not fail after its copy succeeded. Only the
 * read-only bit is rewritten: directory/system/hidden stay as they are.
 */
bool clearReadOnlyAttribute(const QString &path, DWORD attributes)
{
    if ((attributes & FILE_ATTRIBUTE_READONLY) == 0) return false;
    const std::vector<wchar_t> native = wideBuffer(path);
    return SetFileAttributesW(native.data(), attributes & ~DWORD(FILE_ATTRIBUTE_READONLY)) != 0;
}
#endif

} // namespace

bool entryExists(const QString &path)
{
#ifdef Q_OS_WIN
    // GetFileAttributesW reports the reparse point itself, so a dangling link exists
    // while its missing referent does not: exactly the oracle's `lstat` semantics.
    return attributesOf(path) != INVALID_FILE_ATTRIBUTES;
#else
    struct stat info {};
    return ::lstat(QFile::encodeName(path).constData(), &info) == 0;
#endif
}

bool isLinkEntry(const QString &path)
{
#ifdef Q_OS_WIN
    return linkEntryProbe(path);
#else
    struct stat info {};
    if (::lstat(QFile::encodeName(path).constData(), &info) != 0) return false;
    return S_ISLNK(info.st_mode);
#endif
}

bool isRealDirectory(const QString &path)
{
#ifdef Q_OS_WIN
    const DWORD attributes = attributesOf(path);
    if (attributes == INVALID_FILE_ATTRIBUTES) return false;
    return (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0 && (attributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0;
#else
    struct stat info {};
    if (::lstat(QFile::encodeName(path).constData(), &info) != 0) return false;
    return S_ISDIR(info.st_mode);
#endif
}

EntryTimestamps readTimestamps(const QString &path)
{
    EntryTimestamps stamps;
#ifdef Q_OS_WIN
    ScopedHandle handle(openEntry(path, FILE_READ_ATTRIBUTES,
                                  FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS));
    if (!handle.valid()) return stamps;
    FILE_BASIC_INFO info{};
    if (!GetFileInformationByHandleEx(handle.get(), FileBasicInfo, &info, sizeof(info))) return stamps;
    stamps.valid = true;
    stamps.accessTicks = qint64(info.LastAccessTime.QuadPart);
    stamps.writeTicks = qint64(info.LastWriteTime.QuadPart);
#else
    struct stat info {};
    if (::lstat(QFile::encodeName(path).constData(), &info) != 0) return stamps;
    stamps.valid = true;
    stamps.accessTicks = qint64(info.st_atim.tv_sec) * 1000000000LL + info.st_atim.tv_nsec;
    stamps.writeTicks = qint64(info.st_mtim.tv_sec) * 1000000000LL + info.st_mtim.tv_nsec;
#endif
    return stamps;
}

void applyTimestamps(const QString &path, const EntryTimestamps &timestamps)
{
    if (!timestamps.valid) return;
#ifdef Q_OS_WIN
    ScopedHandle handle(openEntry(path, FILE_WRITE_ATTRIBUTES,
                                  FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS));
    if (!handle.valid()) return;
    FILE_BASIC_INFO info{};
    info.LastAccessTime.QuadPart = LONGLONG(timestamps.accessTicks);
    info.LastWriteTime.QuadPart = LONGLONG(timestamps.writeTicks);
    // -1 leaves the value unchanged; attributes are not part of the oracle contract.
    info.ChangeTime.QuadPart = -1;
    info.FileAttributes = 0;
    SetFileInformationByHandle(handle.get(), FileBasicInfo, &info, sizeof(info));
#else
    struct timespec times[2] = {};
    times[0].tv_sec = time_t(timestamps.accessTicks / 1000000000LL);
    times[0].tv_nsec = long(timestamps.accessTicks % 1000000000LL);
    times[1].tv_sec = time_t(timestamps.writeTicks / 1000000000LL);
    times[1].tv_nsec = long(timestamps.writeTicks % 1000000000LL);
    ::utimensat(AT_FDCWD, QFile::encodeName(path).constData(), times, 0);
#endif
}

void copyLinkEntry(const QString &source, const QString &destination)
{
#ifdef Q_OS_WIN
    bool referentIsDirectory = false;
    const QString rawTarget = readLinkTarget(source, &referentIsDirectory);
    if (rawTarget.isEmpty()) throw failure(QStringLiteral("Unable to read link %1").arg(source));
    if (referentIsDirectory) {
        createJunction(source, destination, rawTarget);
        return;
    }
    createFileLink(destination, rawTarget);
#else
    char buffer[PATH_MAX] = {};
    const ssize_t length = ::readlink(QFile::encodeName(source).constData(), buffer, sizeof(buffer) - 1);
    // `readlink` truncates silently when the target does not fit; a shortened target would
    // make the copied link point somewhere else, so treat the full buffer as an error.
    if (length < 0 || length >= ssize_t(sizeof(buffer) - 1)
        || ::symlink(buffer, QFile::encodeName(destination).constData()) != 0) {
        throw failure(QStringLiteral("Unable to copy link %1").arg(destination));
    }
#endif
}

bool removeEntry(const QString &path)
{
#ifdef Q_OS_WIN
    const std::vector<wchar_t> native = wideBuffer(path);
    const DWORD attributes = GetFileAttributesW(native.data());
    if (attributes == INVALID_FILE_ATTRIBUTES) return false;
    if ((attributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
        // A junction is a directory reparse point: RemoveDirectoryW deletes the link
        // itself, never the directory it points at. A real directory must be empty.
        if (RemoveDirectoryW(native.data())) return true;
        // rimraf's `fixWinEPERMSync`: a read-only directory is not removable, so clear the
        // flag and retry once. Without the retry a move fails after its copy already exists.
        if (GetLastError() != ERROR_ACCESS_DENIED || !clearReadOnlyAttribute(path, attributes)) {
            return false;
        }
        return RemoveDirectoryW(native.data()) != 0;
    }
    if (DeleteFileW(native.data())) return true;
    // Same `fixWinEPERM` retry for a read-only file (DeleteFileW -> ERROR_ACCESS_DENIED).
    if (GetLastError() != ERROR_ACCESS_DENIED || !clearReadOnlyAttribute(path, attributes)) return false;
    return DeleteFileW(native.data()) != 0;
#else
    struct stat info {};
    if (::lstat(QFile::encodeName(path).constData(), &info) != 0) return false;
    if (S_ISDIR(info.st_mode)) return ::rmdir(QFile::encodeName(path).constData()) == 0;
    return ::unlink(QFile::encodeName(path).constData()) == 0;
#endif
}

void removeEntryTree(const QString &path)
{
    // Port of the oracle's `fs.rm(path, {recursive:true, force:true})` on the *entry* level:
    // rimraf lstats first, unlinks a link without following it, and only then recurses into a
    // real directory. `QDir::removeRecursively()` cannot be used for this: Qt reports a
    // Windows junction as a plain directory (`QFileInfo::isSymLink()` is false for it), so it
    // pushes the junction as a directory, deletes every file behind it and only then rmdirs
    // the link - silent data loss on a path outside the project.
    if (!entryExists(path)) return;
    if (isLinkEntry(path) || !isRealDirectory(path)) {
        if (!removeEntry(path)) throw failure(QStringLiteral("Unable to remove %1").arg(path));
        return;
    }
#ifdef Q_OS_WIN
    // Keep the directory real and immovable for the entire enumeration/recursion.
    // A metadata probe alone leaves a junction-swap window before QDir opens it.
    auto directoryLock = scopedmutation::lockDirectory(path);
#endif
    const QFileInfoList children = QDir(path).entryInfoList(
        QDir::AllEntries | QDir::NoDotAndDotDot | QDir::Hidden, QDir::NoSort);
    for (const QFileInfo &child : children) removeEntryTree(child.absoluteFilePath());
#ifdef Q_OS_WIN
    directoryLock.reset(); // Removing the entry does not traverse it; release its delete denial.
#endif
    if (!removeEntry(path)) throw failure(QStringLiteral("Unable to remove %1").arg(path));
}

} // namespace fsops
