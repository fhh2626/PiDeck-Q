#include "GitStatusContext.h"
#include "../../process/TextEncoding.h"

#include "GitExec.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QRegularExpression>

#include <stdexcept>
#include <string>

#ifdef Q_OS_WIN
#include <windows.h>
#else
#include <fcntl.h>
#include <unistd.h>
#endif

namespace gitstatus {

#ifdef Q_OS_WIN
namespace {

/**
 * Final volume path for an existing Windows file or directory.
 *
 * QFileInfo::canonicalFilePath() does not resolve a directory junction to its target;
 * a ProjectStore junction would therefore live in a different path space than the
 * repository root: status rows disappear and mutations compare an alias spelling
 * against the canonical root. GetFinalPathNameByHandle follows reparse points and
 * returns the volume's final path, which is the same resolution the Node oracle's
 * realpathSync.native / fs/promises.realpath performs.
 */
QString finalWindowsPath(const QString &path)
{
    const HANDLE handle = ::CreateFileW(reinterpret_cast<LPCWSTR>(path.utf16()), FILE_READ_ATTRIBUTES,
                                        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                                        OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
    if (handle == INVALID_HANDLE_VALUE) return QString();
    QString result;
    const DWORD required =
        ::GetFinalPathNameByHandleW(handle, nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (required > 0) {
        std::wstring buffer(required, L'\0');
        const DWORD written = ::GetFinalPathNameByHandleW(handle, buffer.data(), required,
                                                          FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
        if (written > 0 && written < required) result = QString::fromWCharArray(buffer.data(), int(written));
    }
    ::CloseHandle(handle);
    // Keep the normal Win32 spelling the rest of the backend and the oracle use;
    // the extended-length prefix is only an API detail.
    if (result.startsWith(QLatin1String("\\\\?\\UNC\\"))) {
        result = QStringLiteral("\\\\") + result.mid(8);
    } else if (result.startsWith(QLatin1String("\\\\?\\"))) {
        result = result.mid(4);
    }
    return QDir::cleanPath(QDir::fromNativeSeparators(result));
}

} // namespace
#endif

QString canonicalPath(const QString &path)
{
    const QString lexical = QDir::cleanPath(QDir::fromNativeSeparators(path));
#ifdef Q_OS_WIN
    // A missing path has no final path; the oracle's realpathSync.native catch branch
    // also keeps its lexical form, so a deleted alias row stays outside the boundary.
    const QString finalPath = finalWindowsPath(lexical);
    return finalPath.isEmpty() ? lexical : finalPath;
#else
    if (!QFileInfo::exists(lexical)) return lexical;
    const QString canonical = QFileInfo(lexical).canonicalFilePath();
    return canonical.isEmpty() ? lexical : canonical;
#endif
}

namespace {

QString absolute(const QString &base, const QString &relative)
{
    return QDir::cleanPath(QDir(base).filePath(QDir::fromNativeSeparators(relative)));
}

/** Relative path from `base` to `target`, using '/' separators. */
QString relativeTo(const QString &base, const QString &target)
{
    QString relative = QDir(base).relativeFilePath(target);
    relative.replace(QLatin1Char('\\'), QLatin1Char('/'));
    return relative;
}

bool escapes(const QString &relative)
{
    return relative.isEmpty() || relative == QLatin1String("..") || relative.startsWith(QLatin1String("../"))
        || QDir::isAbsolutePath(relative);
}

bool samePath(const QString &left, const QString &right)
{
#ifdef Q_OS_WIN
    return left.compare(right, Qt::CaseInsensitive) == 0;
#else
    return left == right;
#endif
}

QJsonObject resourceJson(const porcelain::Resource &resource)
{
    QJsonObject value{
        {QStringLiteral("path"), resource.path},
        {QStringLiteral("status"), resource.status},
        {QStringLiteral("letter"), resource.letter},
    };
    if (resource.hasOldPath) value.insert(QStringLiteral("oldPath"), resource.oldPath);
    return value;
}

bool isIndexStatus(int status)
{
    return status == porcelain::INDEX_MODIFIED || status == porcelain::INDEX_ADDED
        || status == porcelain::INDEX_DELETED || status == porcelain::INDEX_RENAMED
        || status == porcelain::INDEX_COPIED || status == porcelain::INDEX_TYPE_CHANGED;
}

bool isMergeStatus(int status)
{
    return status == porcelain::ADDED_BY_US || status == porcelain::ADDED_BY_THEM
        || status == porcelain::DELETED_BY_US || status == porcelain::DELETED_BY_THEM
        || status == porcelain::BOTH_ADDED || status == porcelain::BOTH_DELETED
        || status == porcelain::BOTH_MODIFIED;
}

/** The resource group a status belongs to, matching the oracle's grouping order. */
QString groupOfStatus(int status)
{
    if (status == porcelain::UNTRACKED) return QStringLiteral("untracked");
    if (isIndexStatus(status)) return QStringLiteral("index");
    if (isMergeStatus(status)) return QStringLiteral("merge");
    return QStringLiteral("workingTree");
}

/** Read a blob through `git show`, refusing anything over the byte cap or binary. */
bool readBlob(const QString &repoRoot, const QString &blobRef, qint64 limit, QString *out)
{
    const gitexec::Result result =
        gitexec::run(repoRoot, QStringList{QStringLiteral("show"), blobRef}, gitexec::kDefaultTimeoutMs, limit + 1);
    if (!result.ok()) return false;
    const QString content = QString::fromUtf8(result.stdoutBytes);
    if (qint64(content.toUtf8().size()) > limit || content.contains(QChar(0))) return false;
    *out = content;
    return true;
}

/**
 * Read the working-tree side of a resource without following a leaf symlink.
 *
 * On POSIX the read uses O_NOFOLLOW from a single handle so a stat/read race cannot
 * swap in a link; on Windows the oracle uses a plain read after lstat, so a link
 * check is the equivalent boundary.
 */
bool readWorkingTree(const QString &path, qint64 limit, QString *out)
{
    const QFileInfo info(path);
    if (info.isSymLink()) {
        const QString target = info.symLinkTarget();
        if (target.isEmpty()) return false;
        if (qint64(target.toUtf8().size()) > limit || target.contains(QChar(0))) return false;
        *out = target;
        return true;
    }
#ifdef Q_OS_WIN
    if (!info.isFile()) return false;
    if (info.size() > limit) return false;
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) return false;
    const QByteArray bytes = file.read(limit + 1);
    if (qint64(bytes.size()) > limit) return false;
    if (bytes.contains('\0')) return false;
    *out = QString::fromUtf8(bytes);
    return true;
#else
    const int descriptor = ::open(path.toUtf8().constData(), O_RDONLY | O_NOFOLLOW);
    if (descriptor < 0) return false;
    QByteArray bytes;
    char buffer[64 * 1024];
    bool tooLarge = false;
    while (true) {
        const ssize_t read = ::read(descriptor, buffer, sizeof(buffer));
        if (read < 0) {
            ::close(descriptor);
            return false;
        }
        if (read == 0) break;
        bytes.append(buffer, int(read));
        if (qint64(bytes.size()) > limit) {
            tooLarge = true;
            break;
        }
    }
    ::close(descriptor);
    if (tooLarge || bytes.contains('\0')) return false;
    *out = QString::fromUtf8(bytes);
    return true;
#endif
}

} // namespace

QString repositoryRoot(const QString &cwd)
{
    const QString raw = gitexec::tryRun(cwd, QStringList{QStringLiteral("rev-parse"), QStringLiteral("--show-toplevel")});
    if (raw.isEmpty()) return QString();
    return canonicalPath(raw);
}

QString resolveCommitHash(const QString &cwd, const QString &ref)
{
    if (ref.isEmpty()) return QString();
    const gitexec::Result result = gitexec::run(
        cwd, QStringList{QStringLiteral("rev-parse"), QStringLiteral("--verify"), QStringLiteral("--end-of-options"),
                         QStringLiteral("%1^{commit}").arg(ref)});
    if (!result.ok()) return QString();
    const QString hash = result.stdoutText.trimmed();
    static const QRegularExpression pattern(QStringLiteral("^[0-9a-fA-F]{40}$"));
    return pattern.match(hash).hasMatch() ? hash : QString();
}

Context read(const QString &cwd)
{
    Context context;
    const gitexec::Result statusResult =
        gitexec::run(cwd,
                     QStringList{QStringLiteral("status"), QStringLiteral("--porcelain"), QStringLiteral("-z"),
                                 QStringLiteral("--untracked-files=all"), QStringLiteral("--"),
                                 QStringLiteral(".")},
                     gitexec::kDefaultTimeoutMs, 16 * 1024 * 1024);
    if (!statusResult.ok()) throw textenc::error(statusResult.errorMessage());
    const QString rootRaw = gitexec::tryRun(cwd, QStringList{QStringLiteral("rev-parse"), QStringLiteral("--show-toplevel")});
    if (rootRaw.isEmpty()) throw std::runtime_error("fatal: not a git repository");

    context.repoRoot = canonicalPath(rootRaw);
    context.inputProjectRoot = QDir::cleanPath(QDir::fromNativeSeparators(QDir(cwd).absolutePath()));
    context.projectRoot = canonicalPath(context.inputProjectRoot);

    const auto toProjectPath = [&context](const QString &canonicalPath) -> QString {
        const QString scoped = relativeTo(context.projectRoot, canonicalPath);
        if (escapes(scoped)) return QString();
        // Keep the ProjectStore representation: on Windows that may be an 8.3 path.
        return QDir::cleanPath(QDir(context.inputProjectRoot).filePath(scoped));
    };

    QJsonArray merge;
    QJsonArray index;
    QJsonArray workingTree;
    QJsonArray untracked;
    const QList<porcelain::Resource> parsed = porcelain::parseStatus(statusResult.stdoutBytes);
    for (porcelain::Resource resource : parsed) {
        const QString displayPath = toProjectPath(absolute(context.repoRoot, resource.path));
        if (displayPath.isEmpty()) continue;
        resource.path = displayPath;
        if (resource.hasOldPath) {
            const QString displayOldPath = toProjectPath(absolute(context.repoRoot, resource.oldPath));
            if (displayOldPath.isEmpty()) continue;
            resource.oldPath = displayOldPath;
        }
        context.resources.append(resource);
        const QJsonObject value = resourceJson(resource);
        const QString group = groupOfStatus(resource.status);
        if (group == QLatin1String("untracked")) untracked.append(value);
        else if (group == QLatin1String("index")) index.append(value);
        else if (group == QLatin1String("merge")) merge.append(value);
        else workingTree.append(value);
    }
    context.groups = QJsonObject{
        {QStringLiteral("merge"), merge},
        {QStringLiteral("index"), index},
        {QStringLiteral("workingTree"), workingTree},
        {QStringLiteral("untracked"), untracked},
    };
    return context;
}

QJsonObject getStatus(const QString &cwd)
{
    try {
        return read(cwd).groups;
    } catch (const std::exception &error) {
        const QString message = QString::fromUtf8(error.what());
        // Non-repository and missing-git errors must reach the renderer so it can
        // show the init prompt or the install guide.
        static const QRegularExpression fatal(
            QStringLiteral("not a git repository|fatal:|command not found|ENOENT|spawn.*git.*ENOENT"),
            QRegularExpression::CaseInsensitiveOption);
        if (fatal.match(message).hasMatch()) throw;
        return QJsonObject{
            {QStringLiteral("merge"), QJsonArray{}},
            {QStringLiteral("index"), QJsonArray{}},
            {QStringLiteral("workingTree"), QJsonArray{}},
            {QStringLiteral("untracked"), QJsonArray{}},
        };
    }
}

QJsonValue workspaceFileDiff(const QString &cwd, const QString &group, const QString &filePath, qint64 maxBytes)
{
    if (group != QLatin1String("merge") && group != QLatin1String("index") && group != QLatin1String("workingTree")
        && group != QLatin1String("untracked")) {
        return QJsonValue(QJsonValue::Null);
    }
    Context context;
    try {
        context = read(cwd);
    } catch (const std::exception &) {
        return QJsonValue(QJsonValue::Null);
    }
    const QString requestedPath = QDir::cleanPath(QDir::fromNativeSeparators(filePath));
    const auto findIn = [&context, &requestedPath](const QString &name) -> const porcelain::Resource * {
        for (const porcelain::Resource &candidate : context.resources) {
            if (groupOfStatus(candidate.status) != name) continue;
            if (samePath(candidate.path, requestedPath)) return &candidate;
        }
        return nullptr;
    };
    const porcelain::Resource *found = findIn(group);
    if (!found && group == QLatin1String("workingTree")) {
        // The Git panel merges untracked rows into the workingTree group, so a
        // missing match falls back to the untracked list.
        found = findIn(QStringLiteral("untracked"));
    }
    if (!found) return QJsonValue(QJsonValue::Null);
    const porcelain::Resource resource = *found;
    const QString effectiveGroup =
        (group == QLatin1String("workingTree") && resource.status == porcelain::UNTRACKED)
        ? QStringLiteral("untracked")
        : group;

    const auto toRepoPath = [&context](const QString &absolutePath) -> QString {
        const QString scoped = relativeTo(context.inputProjectRoot, absolutePath);
        if (escapes(scoped)) throw std::runtime_error("Git resource is outside the project");
        const QString canonicalPath = QDir::cleanPath(QDir(context.projectRoot).filePath(scoped));
        const QString result = relativeTo(context.repoRoot, canonicalPath);
        if (escapes(result)) throw std::runtime_error("Git resource is outside the repository");
        return result;
    };

    try {
        const QString currentPath = toRepoPath(resource.path);
        const QString oldPath = resource.hasOldPath ? toRepoPath(resource.oldPath) : currentPath;
        const qint64 limit = maxBytes > 0 ? maxBytes : 1;
        QString originalContent;
        QString modifiedContent;
        if (effectiveGroup == QLatin1String("untracked")) {
            originalContent = QString();
            if (!readWorkingTree(resource.path, limit, &modifiedContent)) return QJsonValue(QJsonValue::Null);
        } else if (effectiveGroup == QLatin1String("index")) {
            if (resource.status == porcelain::INDEX_ADDED) {
                originalContent = QString();
            } else if (!readBlob(context.repoRoot, QStringLiteral("HEAD:%1").arg(oldPath), limit, &originalContent)) {
                return QJsonValue(QJsonValue::Null);
            }
            if (resource.status == porcelain::INDEX_DELETED) {
                modifiedContent = QString();
            } else if (!readBlob(context.repoRoot, QStringLiteral(":%1").arg(currentPath), limit, &modifiedContent)) {
                return QJsonValue(QJsonValue::Null);
            }
        } else if (effectiveGroup == QLatin1String("workingTree")) {
            const QString blobPath = resource.hasOldPath ? oldPath : currentPath;
            if (!readBlob(context.repoRoot, QStringLiteral(":%1").arg(blobPath), limit, &originalContent)) {
                return QJsonValue(QJsonValue::Null);
            }
            if (resource.status == porcelain::DELETED) {
                modifiedContent = QString();
            } else if (!readWorkingTree(resource.path, limit, &modifiedContent)) {
                return QJsonValue(QJsonValue::Null);
            }
        } else {
            const bool missingFromHead = resource.status == porcelain::ADDED_BY_THEM
                || resource.status == porcelain::DELETED_BY_US || resource.status == porcelain::BOTH_DELETED;
            if (missingFromHead) {
                originalContent = QString();
            } else if (!readBlob(context.repoRoot, QStringLiteral("HEAD:%1").arg(currentPath), limit, &originalContent)) {
                return QJsonValue(QJsonValue::Null);
            }
            if (resource.status == porcelain::BOTH_DELETED) {
                modifiedContent = QString();
            } else if (!readWorkingTree(resource.path, limit, &modifiedContent)) {
                return QJsonValue(QJsonValue::Null);
            }
        }
        return QJsonObject{
            {QStringLiteral("path"), resource.path},
            {QStringLiteral("originalContent"), originalContent},
            {QStringLiteral("modifiedContent"), modifiedContent},
        };
    } catch (const std::exception &) {
        return QJsonValue(QJsonValue::Null);
    }
}

} // namespace gitstatus
