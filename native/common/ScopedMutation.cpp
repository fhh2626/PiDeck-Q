#include "ScopedMutation.h"
#include "NativeCanonicalPath.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QStringList>
#include <stdexcept>
#include <vector>

#ifdef Q_OS_WIN
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace scopedmutation {
namespace {
[[noreturn]] void unsafe() { throw std::runtime_error("Session deletion path authorization failed"); }
QString normalized(const QString &value)
{
    if (value.contains(QChar(0)) || !QDir::isAbsolutePath(value)) unsafe();
    return QDir::cleanPath(QDir::fromNativeSeparators(value));
}
QStringList relativeParts(const Root &root, const QString &target)
{
    // Never turn an ambiguous symlink/.. source spelling into a different entry.
    if (QDir::fromNativeSeparators(target).split('/').contains(QStringLiteral(".."))) unsafe();
    const QString path = normalized(target);
#ifdef Q_OS_WIN
    constexpr auto sensitivity = Qt::CaseInsensitive;
#else
    constexpr auto sensitivity = Qt::CaseSensitive;
#endif
    QString prefix = normalized(root.path);
    if (!prefix.endsWith('/')) prefix += '/';
    if (!path.startsWith(prefix, sensitivity)) unsafe();
    const auto parts = path.mid(prefix.size()).split('/');
    for (const auto &part : parts) {
        if (part.isEmpty() || part == "." || part == "..") unsafe();
#ifdef Q_OS_WIN
        // Shell paths must not collapse a distinct extended-path entry or open ADS.
        if (part.endsWith('.') || part.endsWith(' ') || part.contains(':')) unsafe();
#endif
    }
    return parts;
}
#ifdef Q_OS_WIN
std::vector<wchar_t> wide(const QString &path)
{
    QString native = QDir::toNativeSeparators(path);
    if (!native.startsWith("\\\\?\\")) {
        native = native.startsWith("\\\\") ? QStringLiteral("\\\\?\\UNC\\") + native.mid(2)
                                               : QStringLiteral("\\\\?\\") + native;
    }
    std::vector<wchar_t> result(size_t(native.size()) + 1, L'\0');
    native.toWCharArray(result.data());
    return result;
}
QString identity(HANDLE handle)
{
    BY_HANDLE_FILE_INFORMATION info{};
    if (!GetFileInformationByHandle(handle, &info) || !(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) unsafe();
    if (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) {
        FILE_ATTRIBUTE_TAG_INFO tag{};
        // Cloud/dedup tags do not redirect path traversal. Reject name-surrogate
        // tags (junctions/symlinks), without disabling ordinary OneDrive roots.
        if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag, sizeof(tag))
            || IsReparseTagNameSurrogate(tag.ReparseTag)) unsafe();
    }
    return QStringLiteral("%1:%2:%3").arg(info.dwVolumeSerialNumber, 0, 16)
        .arg(info.nFileIndexHigh, 0, 16).arg(info.nFileIndexLow, 0, 16);
}
std::shared_ptr<void> openDirectory(const QString &path, bool lock, bool followRoot = false)
{
    const auto name = wide(path);
    // Attribute-only opens do not participate in Windows share-access accounting.
    // FILE_LIST_DIRECTORY is required for the write/delete share denials to hold.
    HANDLE handle = CreateFileW(name.data(), FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY,
        lock ? FILE_SHARE_READ : FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | (followRoot ? 0 : FILE_FLAG_OPEN_REPARSE_POINT), nullptr);
    if (handle == INVALID_HANDLE_VALUE) unsafe();
    std::shared_ptr<void> result(handle, [](void *value) { CloseHandle(value); });
    identity(handle);
    return result;
}
/** Qt canonicalFilePath does not resolve junctions; bind the name to this same handle. */
QString physicalName(HANDLE handle)
{
    const DWORD count = GetFinalPathNameByHandleW(handle, nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (!count || count > 32768) unsafe();
    std::vector<wchar_t> buffer(size_t(count) + 1, L'\0');
    const DWORD size = GetFinalPathNameByHandleW(handle, buffer.data(), DWORD(buffer.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (!size || size >= buffer.size()) unsafe();
    QString result = QString::fromWCharArray(buffer.data(), int(size));
    if (result.startsWith("\\\\?\\UNC\\")) result = QStringLiteral("\\\\") + result.mid(8);
    else if (result.startsWith("\\\\?\\") && result.size() > 6 && result.at(5) == ':') result = result.mid(4);
    return normalized(result);
}
#else
struct Descriptor {
    int value;
    explicit Descriptor(int value) : value(value) {}
    Descriptor(const Descriptor &) = delete;
    Descriptor &operator=(const Descriptor &) = delete;
    ~Descriptor() { if (value >= 0) close(value); }
};
QString identity(int fd)
{
    struct stat info{};
    if (fstat(fd, &info) || !S_ISDIR(info.st_mode)) unsafe();
    return QStringLiteral("%1:%2").arg(qulonglong(info.st_dev), 0, 16).arg(qulonglong(info.st_ino), 0, 16);
}
#endif
} // namespace

struct Parent::State {
    QString target;
    QString name;
#ifdef Q_OS_WIN
    std::vector<std::shared_ptr<void>> handles;
#else
    int fd = -1;
    ~State() { if (fd >= 0) close(fd); }
#endif
};

QJsonObject Root::toJson() const
{
    return {{QStringLiteral("root"), path}, {QStringLiteral("identity"), identity}};
}
Root Root::fromJson(const QJsonObject &value)
{
    if (value.size() != 2 || !value.value("root").isString() || !value.value("identity").isString()
        || value.value("identity").toString().isEmpty()) unsafe();
    return {normalized(value.value("root").toString()), value.value("identity").toString()};
}
Root captureRoot(const QString &directory)
{
    // A configured root link is explicit authority. Resolve it once, then carry its
    // physical identity rather than reinterpreting its spelling at each host callback.
    Root root;
#ifdef Q_OS_WIN
    auto handle = openDirectory(normalized(directory), false, true);
    root.path = physicalName(handle.get());
    // SMB/WSL redirectors cannot prevent server-local writers from bypassing a
    // Windows share lock. Do not claim this path-based Shell guard is safe there.
    QString volume;
    if (root.path.size() >= 3 && root.path.at(1) == ':') volume = root.path.left(3);
    else if (root.path.startsWith("//?/Volume{")) {
        const qsizetype end = root.path.indexOf('}');
        if (end < 0) unsafe();
        volume = root.path.left(end + 1) + '/';
    }
    else unsafe();
    const auto volumeName = wide(volume);
    const UINT driveType = GetDriveTypeW(volumeName.data());
    if (driveType != DRIVE_FIXED && driveType != DRIVE_REMOVABLE && driveType != DRIVE_RAMDISK && driveType != DRIVE_CDROM) unsafe();
    root.identity = identity(handle.get());
    root.lifetime = std::move(handle);
#else
    const QString canonical = nativecanonical::existing(directory).path;
    if (canonical.isEmpty()) unsafe();
    root.path = normalized(canonical);
    Descriptor descriptor(open(QFile::encodeName(root.path).constData(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
    if (descriptor.value < 0) unsafe();
    auto handle = std::make_shared<Descriptor>(descriptor.value);
    descriptor.value = -1;
    root.identity = identity(handle->value);
    root.lifetime = std::move(handle);
#endif
    return root;
}
QString mapTarget(const Root &root, const QString &directory, const QString &target)
{
    QStringList parts;
    try { parts = relativeParts({normalized(directory), {}}, target); }
    catch (const std::runtime_error &) { parts = relativeParts(root, target); }
    return QDir(root.path).filePath(parts.join('/'));
}
Parent::Parent(const Root &root, const QString &target) : state(std::make_unique<State>())
{
    const auto parts = relativeParts(root, target);
    state->target = normalized(target);
    state->name = parts.last();
#ifdef Q_OS_WIN
    // Hold the complete physical chain. No FILE_SHARE_WRITE/DELETE: neither a
    // pathname swap nor FSCTL_SET_REPARSE_POINT may redirect the actual Qt call.
    QStringList chain;
    QString cursor = QFileInfo(state->target).absolutePath();
    while (true) {
        chain.prepend(cursor);
        QDir parent(cursor);
        if (!parent.cdUp() || parent.path() == cursor) break;
        cursor = parent.path();
    }
    bool matched = false;
    for (const auto &directory : chain) {
        auto handle = openDirectory(directory, true);
        if (directory.compare(normalized(root.path), Qt::CaseInsensitive) == 0) {
            if (identity(handle.get()) != root.identity) unsafe();
            matched = true;
        }
        state->handles.push_back(std::move(handle));
    }
    if (!matched) unsafe();
#else
    // Open the physical root component by component, then traverse relative to
    // retained descriptors. Renaming ancestors cannot redirect openat/unlinkat.
    state->fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (state->fd < 0) unsafe();
    QStringList directories = normalized(root.path).split('/', Qt::SkipEmptyParts);
    const qsizetype rootCount = directories.size();
    for (qsizetype i = 0; i + 1 < parts.size(); ++i) directories.append(parts.at(i));
    if (rootCount == 0 && identity(state->fd) != root.identity) unsafe();
    for (qsizetype i = 0; i < directories.size(); ++i) {
        const int next = openat(state->fd, QFile::encodeName(directories.at(i)).constData(),
                                O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (next < 0) unsafe();
        close(state->fd);
        state->fd = next;
        if (i + 1 == rootCount && identity(next) != root.identity) unsafe();
    }
#endif
}
Parent::~Parent() = default;
QString Parent::path() const { return state->target; }
QString Parent::leaf() const { return state->name; }
int Parent::descriptor() const
{
#ifdef Q_OS_WIN
    return -1;
#else
    return state->fd;
#endif
}
#ifdef Q_OS_WIN
std::shared_ptr<void> lockDirectory(const QString &path) { return openDirectory(path, true); }
bool moveToTrash(const Root &root, const QString &target)
{
    const Parent parent(root, target);
    return moveToTrash(parent);
}
bool moveToTrash(const Parent &parent)
{
    QFile file(parent.path());
    return file.moveToTrash();
}
#endif
} // namespace scopedmutation
