#include "SessionFiles.h"

#include "SessionIdentity.h"

#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QThread>

#ifdef Q_OS_WIN
#include <io.h>
#include <windows.h>
#else
#include <unistd.h>
#endif

namespace sessionfiles {

const char *const kArchiveDirName = ".pideck-archive";
const char *const kTrashDirName = ".pideck-trash";
const char *const kArchiveIndexName = "index.json";

namespace {

constexpr int kRenameAttempts = 12;
constexpr int kRenameDelayMs = 15;

void syncHandle(QFile &file)
{
    // Durability step before the rename. Only Qt's own flush is used: QFile::handle()
    // is a CRT descriptor owned by the Qt DLL's CRT instance, so calling
    // _get_osfhandle() on it from this module hits the invalid-parameter handler and
    // aborts the process. Atomicity comes from the temp-file + rename below.
    file.flush();
}

bool isRetryableRenameError(const QString &error)
{
    // Windows returns sharing violations / access denied while another process
    // (an antivirus scanner, the indexer, or pi itself) holds a transient handle.
    return error.contains(QLatin1String("denied"), Qt::CaseInsensitive)
        || error.contains(QLatin1String("sharing"), Qt::CaseInsensitive)
        || error.contains(QLatin1String("busy"), Qt::CaseInsensitive);
}

QString tempSibling(const QString &path)
{
    const QFileInfo info(path);
    return info.absolutePath() + QLatin1Char('/') + info.fileName() + QLatin1Char('.')
        + QString::number(QDateTime::currentMSecsSinceEpoch()) + QLatin1Char('-')
        + QString::number(quintptr(QThread::currentThreadId())) + QStringLiteral(".tmp");
}

} // namespace

bool readText(const QString &path, QString *content, QString *error)
{
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) {
        if (error) *error = file.errorString();
        return false;
    }
    *content = QString::fromUtf8(file.readAll());
    return true;
}

bool readHead(const QString &path, qint64 maxBytes, QString *content, QString *error)
{
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) {
        if (error) *error = file.errorString();
        return false;
    }
    *content = QString::fromUtf8(file.read(maxBytes));
    return true;
}

bool exists(const QString &path)
{
    return QFileInfo::exists(path);
}

bool isFile(const QString &path)
{
    return QFileInfo(path).isFile();
}

bool isDirectory(const QString &path)
{
    return QFileInfo(path).isDir();
}

bool makeDirectory(const QString &path, QString *error)
{
    if (path.isEmpty()) return true;
    if (QDir().mkpath(path)) return true;
    if (error) *error = QStringLiteral("Unable to create directory: %1").arg(path);
    return false;
}

bool writeAtomic(const QString &path, const QByteArray &content, QString *error)
{
    const QString directory = QFileInfo(path).absolutePath();
    if (!makeDirectory(directory, error)) return false;
    const QString temp = tempSibling(path);
    {
        QFile file(temp);
        if (!file.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
            if (error) *error = file.errorString();
            return false;
        }
        if (file.write(content) != content.size()) {
            if (error) *error = file.errorString();
            file.close();
            QFile::remove(temp);
            return false;
        }
            syncHandle(file);
        }
    if (!renameWithRetry(temp, path, error)) {
        QFile::remove(temp);
        return false;
    }
    return true;
}

bool copyAtomic(const QString &source, const QString &destination, QString *error)
{
    QFile input(source);
    if (!input.open(QIODevice::ReadOnly)) {
        if (error) *error = input.errorString();
        return false;
    }
    return writeAtomic(destination, input.readAll(), error);
}

bool renameWithRetry(const QString &from, const QString &to, QString *error)
{
    QString lastError;
    for (int attempt = 0; attempt < kRenameAttempts; ++attempt) {
        // QFile::rename refuses to overwrite on Windows, which is exactly what an
        // atomic replace needs on POSIX but not on Windows. Remove the destination
        // first only when it exists and the caller asked for a replace.
        if (QFileInfo::exists(to)) QFile::remove(to);
        if (QFile::rename(from, to)) return true;
        lastError = QStringLiteral("Unable to rename %1 to %2").arg(from, to);
        QThread::msleep(quint64(kRenameDelayMs));
    }
    if (error) *error = lastError;
    return false;
}

bool renameNoOverwrite(const QString &from, const QString &to, QString *error)
{
    if (QFileInfo::exists(to)) {
        if (error) *error = QStringLiteral("Target already exists: %1").arg(to);
        return false;
    }
    return renameWithRetry(from, to, error);
}

bool removeFile(const QString &path)
{
    if (!QFileInfo::exists(path)) return true;
    return QFile::remove(path);
}

QStringList listNames(const QString &directory)
{
    QDir dir(directory);
    if (!dir.exists()) return {};
    return dir.entryList(QDir::AllEntries | QDir::NoDotAndDotDot | QDir::Hidden | QDir::System);
}

bool isIgnoredScanPath(const QString &pathOrName, bool allowArchive)
{
    if (pathOrName.isEmpty()) return false;
    QString normalized = pathOrName;
    normalized.replace(QLatin1Char('\\'), QLatin1Char('/'));
    while (normalized.endsWith(QLatin1Char('/'))) normalized.chop(1);
    const QString lower = normalized.toLower();
    const QString base = lower.section(QLatin1Char('/'), -1);

    // Soft-deleted WSL sessions must never come back, not even through an archive scan.
    if (base == QLatin1String(kTrashDirName) || lower.contains(QStringLiteral("/%1/").arg(kTrashDirName))) {
        return true;
    }
    if (!allowArchive && base == QLatin1String(kArchiveDirName)) return true;
    if (base == QLatin1String("subagent-artifacts")
        || lower.contains(QStringLiteral("/subagent-artifacts/"))
        || lower.endsWith(QStringLiteral("/subagent-artifacts"))) {
        return true;
    }
    if (lower == QLatin1String(".pi/subagents/artifacts")
        || lower.endsWith(QStringLiteral("/.pi/subagents/artifacts"))
        || lower.contains(QStringLiteral("/.pi/subagents/artifacts/"))) {
        return true;
    }
    return false;
}

QStringList collectJsonlFiles(const QString &root, bool allowArchive)
{
    QStringList files;
    if (root.isEmpty() || isIgnoredScanPath(root, allowArchive)) return files;
    const QDir directory(root);
    if (!directory.exists()) return files;
    const QFileInfoList entries =
        directory.entryInfoList(QDir::AllEntries | QDir::NoDotAndDotDot | QDir::Hidden | QDir::System);
    for (const QFileInfo &entry : entries) {
        const QString path = entry.absoluteFilePath();
        if (entry.isDir()) {
            if (isIgnoredScanPath(path, allowArchive)) continue;
            files.append(collectJsonlFiles(path, allowArchive));
        } else if (entry.isFile() && entry.fileName().endsWith(QLatin1String(".jsonl"), Qt::CaseInsensitive)) {
            files.append(path);
        }
    }
    return files;
}

} // namespace sessionfiles
