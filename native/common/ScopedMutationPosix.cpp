#include "ScopedMutation.h"

#ifndef Q_OS_WIN
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QStandardPaths>
#include <QScopeGuard>
#include <QUrl>
#include <QUuid>
#include <cerrno>
#include <cstdio>
#include <stdexcept>
#include <dirent.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#ifdef Q_OS_LINUX
#include <sys/syscall.h>
#endif

namespace scopedmutation {
namespace {
[[noreturn]] void failure() { throw std::runtime_error("Scoped session filesystem operation failed"); }
struct Fd {
    int value;
    explicit Fd(int value) : value(value) {}
    ~Fd() { if (value >= 0) close(value); }
    Fd(const Fd &) = delete;
    Fd &operator=(const Fd &) = delete;
};
/** Recurse only through descriptor-bound real directories, never a path obtained from readdir. */
void removeAt(int parent, const QByteArray &name, int depth)
{
    if (depth > 256) failure();
    struct stat before{};
    if (fstatat(parent, name.constData(), &before, AT_SYMLINK_NOFOLLOW)) {
        if (errno == ENOENT) return;
        failure();
    }
    if (!S_ISDIR(before.st_mode)) {
        if (unlinkat(parent, name.constData(), 0) && errno != ENOENT) failure();
        return;
    }
    Fd directory(openat(parent, name.constData(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
    struct stat opened{};
    if (directory.value < 0 || fstat(directory.value, &opened)
        || before.st_dev != opened.st_dev || before.st_ino != opened.st_ino) failure();
    const int enumeration = fcntl(directory.value, F_DUPFD_CLOEXEC, 0);
    if (enumeration < 0) failure();
    DIR *stream = fdopendir(enumeration);
    if (!stream) { close(enumeration); failure(); }
    try {
        while (true) {
            errno = 0;
            const dirent *entry = readdir(stream);
            if (!entry) { if (errno) failure(); break; }
            const QByteArray child(entry->d_name);
            if (child != "." && child != "..") removeAt(directory.value, child, depth + 1);
        }
    } catch (...) { closedir(stream); throw; }
    closedir(stream);
    // A replacement link is not a directory to unlinkat(AT_REMOVEDIR), so even a
    // final-entry race cannot turn this into a traversal of its referent.
    if (unlinkat(parent, name.constData(), AT_REMOVEDIR) && errno != ENOENT) failure();
}
int childDirectory(int parent, const char *name)
{
    if (mkdirat(parent, name, 0700) && errno != EEXIST) return -1;
    int fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    struct stat info{};
    if (fd >= 0 && !fstat(fd, &info) && info.st_uid == getuid() && !(info.st_mode & 0022)) return fd;
    if (fd >= 0) close(fd);
    return -1;
}
bool writeAll(int fd, const QByteArray &data)
{
    qsizetype offset = 0;
    while (offset < data.size()) {
        const ssize_t count = write(fd, data.constData() + offset, size_t(data.size() - offset));
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return false;
        offset += count;
    }
    return fsync(fd) == 0;
}
int renameExclusive(int source, const QByteArray &name, int destination, const QByteArray &newName)
{
#if defined(Q_OS_LINUX) && defined(SYS_renameat2)
    // No overwriting an existing trash item, even if another process races our
    // reserved metadata slot. Old kernels/filesystems fail rather than downgrade.
    return int(syscall(SYS_renameat2, source, name.constData(), destination, newName.constData(), 1));
#elif defined(Q_OS_MACOS)
    return renameatx_np(source, name.constData(), destination, newName.constData(), RENAME_EXCL);
#else
    errno = ENOTSUP;
    return -1;
#endif
}
} // namespace

void removeTree(const Root &root, const QString &target)
{
    const Parent parent(root, target);
    removeTree(parent);
}
void removeTree(const Parent &parent)
{
    removeAt(parent.descriptor(), QFile::encodeName(parent.leaf()), 0);
}

bool moveToTrash(const Root &root, const QString &target)
{
    const Parent parent(root, target);
    return moveToTrash(parent);
}
bool moveToTrash(const Parent &source)
{
#ifdef Q_OS_MACOS
    // Home-volume Trash remains recoverable in Finder. Cross-volume trash is a
    // refusal, never an implicit copy/unlink or permanent-delete fallback.
    const QString base = QDir::homePath();
#else
    const QString base = QStandardPaths::writableLocation(QStandardPaths::GenericDataLocation);
#endif
    if (base.isEmpty()) return false;
    // Root links in the user-owned OS trash location are explicit authority just
    // like configured session roots. Resolve once and retain its opened identity.
    if (!QDir().mkpath(base)) return false;
    const Root baseRoot = captureRoot(base);
#ifdef Q_OS_MACOS
    const Parent location(baseRoot, QDir(baseRoot.path).filePath(".Trash"));
    Fd files(childDirectory(location.descriptor(), ".Trash"));
    if (files.value < 0) return false;
#else
    const Parent location(baseRoot, QDir(baseRoot.path).filePath("Trash"));
    Fd trash(childDirectory(location.descriptor(), "Trash"));
    if (trash.value < 0) return false;
    Fd files(childDirectory(trash.value, "files"));
    Fd info(childDirectory(trash.value, "info"));
    if (files.value < 0 || info.value < 0) return false;
#endif
    const QByteArray name = QFile::encodeName(source.leaf());
    const QByteArray unique = QUuid::createUuid().toString(QUuid::WithoutBraces).toUtf8() + "-" + name;
#ifndef Q_OS_MACOS
    const QByteArray metadataName = unique + ".trashinfo";
    Fd metadata(openat(info.value, metadataName.constData(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600));
    if (metadata.value < 0) return false;
    auto rollback = qScopeGuard([&] { unlinkat(info.value, metadataName.constData(), 0); });
    const QByteArray body = "[Trash Info]\nPath=" + QUrl::toPercentEncoding(source.path(), "/")
        + "\nDeletionDate=" + QDateTime::currentDateTime().toString(Qt::ISODate).toUtf8() + "\n";
    if (!writeAll(metadata.value, body)) return false;
#endif
    const bool moved = renameExclusive(source.descriptor(), name, files.value, unique) == 0;
#ifndef Q_OS_MACOS
    if (moved) rollback.dismiss();
#endif
    return moved;
}
} // namespace scopedmutation
#endif
