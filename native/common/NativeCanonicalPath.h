#pragma once

#include <QByteArray>
#include <QDir>
#include <QFile>
#include <QStringList>

#ifndef Q_OS_WIN
#include <cerrno>
#include <cstdlib>
#include <sys/stat.h>

/** Preserve POSIX filename bytes before treating a decoded path as mutation authority. */
namespace nativecanonical {
enum class Status { Resolved, Missing, Unverified };

struct Result {
    QString path;
    Status status = Status::Unverified;
};

/** Reject text that would change the actual POSIX mutation entry during encoding. */
inline bool validPathText(const QString &path)
{
    return !path.isEmpty() && !path.contains(QChar::Null) && QDir::isAbsolutePath(path)
        && QString::fromUtf8(path.toUtf8()) == path;
}

/** Missing is proven by lstat. An unreadable, dangling or unrepresentable entry stays unverified. */
inline Result existing(const QString &path)
{
    if (!validPathText(path)) return {};
    const QByteArray name = QFile::encodeName(path);
    char *resolved = ::realpath(name.constData(), nullptr);
    if (!resolved) {
        const int failure = errno;
        if (failure != ENOENT) return {};
        struct stat entry{};
        if (::lstat(name.constData(), &entry) == 0 || errno != ENOENT) return {};
        return {{}, Status::Missing};
    }
    const QByteArray bytes(resolved);
    std::free(resolved);
    const QString decoded = QFile::decodeName(bytes);
    // Checking for U+FFFD itself would reject real filenames. A byte round trip
    // distinguishes those names from a different entry decoded with replacement.
    if (QFile::encodeName(decoded) != bytes) return {};
    return {decoded, Status::Resolved};
}

/** Append only proven missing suffixes, preserving symlink/.. traversal order. */
inline Result withMissingSuffix(const QString &path)
{
    QString current = path;
    QStringList missing;
    while (!current.isEmpty()) {
        const Result resolved = existing(current);
        if (resolved.status == Status::Resolved) {
            QString result = resolved.path;
            for (const QString &part : missing) result = QDir(result).filePath(part);
            return {result, Status::Resolved};
        }
        // In particular, an existing path whose bytes cannot be decoded must
        // never be reinterpreted as an ordinary name under its nearest parent.
        if (resolved.status != Status::Missing) return {};
        const qsizetype slash = current.lastIndexOf(QLatin1Char('/'));
        if (slash < 0 || slash == current.size() - 1) return {};
        const QString part = current.mid(slash + 1);
        if (part == QLatin1String(".") || part == QLatin1String("..")) return {};
        missing.prepend(part);
        current = slash == 0 ? QStringLiteral("/") : current.left(slash);
    }
    return {};
}
} // namespace nativecanonical
#endif
