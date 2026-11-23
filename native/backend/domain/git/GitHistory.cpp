#include "GitHistory.h"

#include "GitExec.h"
#include "GitStatusContext.h"
#include "PorcelainStatus.h"

#include <QDir>
#include <QFileInfo>
#include <QHash>
#include <QJsonObject>
#include <QRegularExpression>

#include <algorithm>

namespace githistory {
namespace {

/** Root commit parent: git's well-known empty tree. */
const QString kEmptyTree = QStringLiteral("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
constexpr int kCommitDetailCacheLimit = 16;
constexpr qint64 kCommitDetailCacheByteLimit = 2 * 1024 * 1024;

struct CacheEntry {
    QJsonObject detail;
    qint64 bytes = 0;
};

/**
 * Small LRU for commit metadata and file lists only. Bodies are never cached, and the
 * byte budget also acts as the IPC cap so an abnormal commit cannot reach the renderer.
 */
QHash<QString, CacheEntry> &detailCache()
{
    static QHash<QString, CacheEntry> cache;
    return cache;
}

QStringList &detailCacheOrder()
{
    static QStringList order;
    return order;
}

qint64 &detailCacheBytes()
{
    static qint64 bytes = 0;
    return bytes;
}

qint64 estimateBytes(const QJsonObject &detail)
{
    const QJsonObject commit = detail.value(QStringLiteral("commit")).toObject();
    QStringList text;
    text << commit.value(QStringLiteral("hash")).toString()
         << commit.value(QStringLiteral("shortHash")).toString()
         << commit.value(QStringLiteral("authorName")).toString()
         << commit.value(QStringLiteral("authorEmail")).toString()
         << commit.value(QStringLiteral("message")).toString()
         << commit.value(QStringLiteral("fullMessage")).toString();
    for (const QJsonValue &parent : commit.value(QStringLiteral("parents")).toArray()) text << parent.toString();
    for (const QJsonValue &ref : commit.value(QStringLiteral("refNames")).toArray()) text << ref.toString();
    const QJsonArray files = detail.value(QStringLiteral("files")).toArray();
    for (const QJsonValue &file : files) {
        text << file.toObject().value(QStringLiteral("path")).toString()
             << file.toObject().value(QStringLiteral("originalPath")).toString();
    }
    qint64 total = 0;
    for (const QString &value : text) total += qint64(value.size()) * 2;
    return total + qint64(files.size()) * 64;
}

QJsonObject readDetailCache(const QString &key)
{
    auto &cache = detailCache();
    const auto found = cache.find(key);
    if (found == cache.end()) return QJsonObject();
    const QJsonObject detail = found->detail;
    detailCacheOrder().removeAll(key);
    detailCacheOrder().append(key);
    return detail;
}

void writeDetailCache(const QString &key, const QJsonObject &detail)
{
    const qint64 bytes = estimateBytes(detail);
    if (bytes > kCommitDetailCacheByteLimit) return;
    auto &cache = detailCache();
    if (cache.contains(key)) {
        detailCacheBytes() -= cache.value(key).bytes;
        cache.remove(key);
        detailCacheOrder().removeAll(key);
    }
    cache.insert(key, CacheEntry{detail, bytes});
    detailCacheOrder().append(key);
    detailCacheBytes() += bytes;
    while (detailCacheOrder().size() > kCommitDetailCacheLimit || detailCacheBytes() > kCommitDetailCacheByteLimit) {
        if (detailCacheOrder().isEmpty()) break;
        const QString oldest = detailCacheOrder().first();
        detailCacheBytes() -= cache.value(oldest).bytes;
        cache.remove(oldest);
        detailCacheOrder().removeFirst();
    }
}

bool readBlob(const QString &cwd, const QString &blobRef, qint64 limit, QString *out)
{
    const gitexec::Result result =
        gitexec::run(cwd, QStringList{QStringLiteral("show"), blobRef}, gitexec::kDefaultTimeoutMs, limit + 1);
    if (!result.ok()) return false;
    const QString content = QString::fromUtf8(result.stdoutBytes);
    if (qint64(content.toUtf8().size()) > limit || content.contains(QChar(0))) return false;
    *out = content;
    return true;
}

} // namespace

QJsonArray getCommitLog(const QString &cwd, const LogOptions &options)
{
    // The list only needs the subject; the full body is read on demand by detail.
    const QString format = QStringLiteral("%H%n%aN%n%aE%n%at%n%ct%n%P%n%D%n%s");
    const int maxEntries = std::min(500, std::max(1, options.maxEntries));
    QStringList arguments{QStringLiteral("log"), QStringLiteral("--format=%1").arg(format), QStringLiteral("-z"),
                          QStringLiteral("--topo-order"), QStringLiteral("-n%1").arg(maxEntries)};
    if (options.allBranches && options.ref.isEmpty()) arguments.append(QStringLiteral("--all"));
    if (!options.ref.isEmpty()) {
        const QString hash = gitstatus::resolveCommitHash(cwd, options.ref);
        if (hash.isEmpty()) return QJsonArray{};
        arguments.append(hash);
    }
    if (!options.path.isEmpty()) {
        arguments.append(QStringLiteral("--"));
        arguments.append(options.path);
    }
    const gitexec::Result result = gitexec::run(cwd, arguments);
    if (!result.ok() || result.stdoutBytes.isEmpty()) return QJsonArray{};
    return porcelain::parseCommits(result.stdoutText, false);
}

QJsonArray getRefs(const QString &cwd)
{
    const QString format = QStringLiteral("%(refname)%00%(objectname)%00%(*objectname)");
    const gitexec::Result result = gitexec::run(
        cwd, QStringList{QStringLiteral("for-each-ref"), QStringLiteral("--format=%1").arg(format),
                         QStringLiteral("--sort=-committerdate")});
    if (!result.ok()) return QJsonArray{};
    return porcelain::parseRefs(result.stdoutText);
}

QJsonObject compareBranches(const QString &cwd, const QString &base, const QString &target)
{
    const QJsonObject empty{
        {QStringLiteral("files"), QJsonArray{}},
        {QStringLiteral("ahead"), 0},
        {QStringLiteral("behind"), 0},
    };
    const QString baseHash = gitstatus::resolveCommitHash(cwd, base);
    const QString targetHash = gitstatus::resolveCommitHash(cwd, target);
    if (baseHash.isEmpty() || targetHash.isEmpty()) return empty;
    const QString range = QStringLiteral("%1...%2").arg(baseHash, targetHash);
    const gitexec::Result diff = gitexec::run(
        cwd, QStringList{QStringLiteral("diff"), QStringLiteral("--name-status"), QStringLiteral("-z"),
                         QStringLiteral("--diff-filter=ADMR"), range});
    if (!diff.ok()) return empty;
    const gitexec::Result counts = gitexec::run(
        cwd, QStringList{QStringLiteral("rev-list"), QStringLiteral("--left-right"), QStringLiteral("--count"), range});
    int behind = 0;
    int ahead = 0;
    if (counts.ok()) {
        const QStringList parts = counts.stdoutText.trimmed().split(QRegularExpression(QStringLiteral("\\s+")),
                                                                    Qt::SkipEmptyParts);
        if (parts.size() >= 2) {
            behind = parts.at(0).toInt();
            ahead = parts.at(1).toInt();
        }
    }
    return QJsonObject{
        {QStringLiteral("files"), porcelain::parseDiffNameStatus(diff.stdoutBytes)},
        {QStringLiteral("ahead"), ahead},
        {QStringLiteral("behind"), behind},
    };
}

QString diffFileBetweenRefs(const QString &cwd, const QString &ref1, const QString &ref2, const QString &filePath)
{
    const QString leftHash = gitstatus::resolveCommitHash(cwd, ref1);
    const QString rightHash = gitstatus::resolveCommitHash(cwd, ref2);
    if (leftHash.isEmpty() || rightHash.isEmpty()) return QString();
    const QString range = QStringLiteral("%1...%2").arg(leftHash, rightHash);
    const gitexec::Result result = gitexec::run(
        cwd, QStringList{QStringLiteral("diff"), range, QStringLiteral("--"), filePath});
    if (!result.ok()) return QString();
    return result.stdoutText;
}

QJsonValue getCommitDetail(const QString &cwd, const QString &ref)
{
    static const QRegularExpression fullHash(QStringLiteral("^[0-9a-fA-F]{40}$"));
    QString commitHash = fullHash.match(ref).hasMatch() ? ref : gitstatus::resolveCommitHash(cwd, ref);
    if (commitHash.isEmpty()) return QJsonValue(QJsonValue::Null);
    const QString cacheKey = QStringLiteral("%1\u0000%2").arg(QDir(cwd).absolutePath(), commitHash.toLower());
    const QJsonObject cached = readDetailCache(cacheKey);
    if (!cached.isEmpty()) return cached;

    const QString format = QStringLiteral("%H%n%aN%n%aE%n%at%n%ct%n%P%n%D%n%B");
    const gitexec::Result show = gitexec::run(
        cwd, QStringList{QStringLiteral("show"), QStringLiteral("-s"), QStringLiteral("--shortstat"),
                         QStringLiteral("--format=%1").arg(format), QStringLiteral("-z"), commitHash,
                         QStringLiteral("--")});
    if (!show.ok() || show.stdoutBytes.isEmpty()) return QJsonValue(QJsonValue::Null);
    const QJsonArray commits = porcelain::parseCommits(show.stdoutText, true);
    if (commits.isEmpty()) return QJsonValue(QJsonValue::Null);
    const QJsonObject commit = commits.at(0).toObject();

    const QJsonArray parents = commit.value(QStringLiteral("parents")).toArray();
    QStringList diffArgs;
    if (!parents.isEmpty()) {
        diffArgs = QStringList{QStringLiteral("diff"), QStringLiteral("--name-status"), QStringLiteral("-z"),
                               QStringLiteral("--find-renames"), parents.at(0).toString(),
                               commit.value(QStringLiteral("hash")).toString()};
    } else {
        // A root commit is compared with the empty tree rather than a fake parent.
        diffArgs = QStringList{QStringLiteral("diff-tree"), QStringLiteral("--root"), QStringLiteral("--no-commit-id"),
                               QStringLiteral("--name-status"), QStringLiteral("-r"), QStringLiteral("-z"),
                               QStringLiteral("--find-renames"), commit.value(QStringLiteral("hash")).toString()};
    }
    const gitexec::Result files = gitexec::run(cwd, diffArgs);
    if (!files.ok()) return QJsonValue(QJsonValue::Null);
    const QJsonObject detail{
        {QStringLiteral("commit"), commit},
        {QStringLiteral("files"), porcelain::parseDiffNameStatus(files.stdoutBytes)},
    };
    if (estimateBytes(detail) > kCommitDetailCacheByteLimit) return QJsonValue(QJsonValue::Null);
    writeDetailCache(cacheKey, detail);
    return detail;
}

QJsonValue getCommitFileDiff(const QString &cwd, const QString &ref, const QString &filePath,
                             const QString &originalPath, bool hasOriginalPath, qint64 maxBytes)
{
    const QJsonValue detailValue = getCommitDetail(cwd, ref);
    if (!detailValue.isObject()) return QJsonValue(QJsonValue::Null);
    const QJsonObject detail = detailValue.toObject();
    QJsonObject file;
    bool matched = false;
    for (const QJsonValue &candidate : detail.value(QStringLiteral("files")).toArray()) {
        const QJsonObject entry = candidate.toObject();
        if (entry.value(QStringLiteral("path")).toString() != filePath) continue;
        const bool candidateHasOriginal = entry.contains(QStringLiteral("originalPath"));
        if (candidateHasOriginal != hasOriginalPath) continue;
        if (hasOriginalPath && entry.value(QStringLiteral("originalPath")).toString() != originalPath) continue;
        file = entry;
        matched = true;
        break;
    }
    // Only files that the commit actually changed may be read.
    if (!matched) return QJsonValue(QJsonValue::Null);

    const QJsonObject commit = detail.value(QStringLiteral("commit")).toObject();
    const QJsonArray parents = commit.value(QStringLiteral("parents")).toArray();
    const QString parent = parents.isEmpty() ? kEmptyTree : parents.at(0).toString();
    const QString oldPath = file.contains(QStringLiteral("originalPath"))
        ? file.value(QStringLiteral("originalPath")).toString()
        : file.value(QStringLiteral("path")).toString();
    const QString status = file.value(QStringLiteral("status")).toString();
    const qint64 limit = maxBytes > 0 ? maxBytes : 1;

    QString originalContent;
    if (status == QLatin1String("added")) {
        originalContent = QString();
    } else if (!readBlob(cwd, QStringLiteral("%1:%2").arg(parent, oldPath), limit, &originalContent)) {
        return QJsonValue(QJsonValue::Null);
    }
    QString modifiedContent;
    if (status == QLatin1String("deleted")) {
        modifiedContent = QString();
    } else if (!readBlob(cwd, QStringLiteral("%1:%2").arg(commit.value(QStringLiteral("hash")).toString(),
                                                        file.value(QStringLiteral("path")).toString()),
                         limit, &modifiedContent)) {
        return QJsonValue(QJsonValue::Null);
    }
    QJsonObject result{
        {QStringLiteral("path"), file.value(QStringLiteral("path"))},
        {QStringLiteral("originalContent"), originalContent},
        {QStringLiteral("modifiedContent"), modifiedContent},
    };
    if (file.contains(QStringLiteral("originalPath"))) {
        result.insert(QStringLiteral("originalPath"), file.value(QStringLiteral("originalPath")));
    }
    return result;
}

QString getStagedDiff(const QString &cwd, int maxChars)
{
    const gitexec::Result result = gitexec::run(
        cwd, QStringList{QStringLiteral("diff"), QStringLiteral("--staged"), QStringLiteral("--unified=3")});
    if (!result.ok()) return QString();
    const QString diff = result.stdoutText;
    if (diff.trimmed().isEmpty()) return QString();
    if (diff.size() > maxChars) return diff.left(maxChars) + QStringLiteral("\n\n... (diff truncated)");
    return diff;
}

QString getOriginalContent(const QString &filePath, qint64 maxBytes)
{
    const QFileInfo info(filePath);
    const QString directory = info.path();
    const QString rootRaw = gitexec::tryRun(directory, QStringList{QStringLiteral("rev-parse"), QStringLiteral("--show-toplevel")});
    if (rootRaw.isEmpty()) return QString();
    const QString repoRoot = QDir::cleanPath(QDir::fromNativeSeparators(rootRaw));
    QString relative = QDir(repoRoot).relativeFilePath(QDir::cleanPath(QDir::fromNativeSeparators(filePath)));
    relative.replace(QLatin1Char('\\'), QLatin1Char('/'));
    if (relative.isEmpty() || relative.startsWith(QLatin1String(".."))) return QString();
    const qint64 limit = maxBytes > 0 ? maxBytes : 1;
    QString content;
    if (!readBlob(repoRoot, QStringLiteral("HEAD:%1").arg(relative), limit, &content)) return QString();
    return content;
}

} // namespace githistory
