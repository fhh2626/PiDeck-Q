#pragma once

#include <QJsonArray>
#include <QJsonValue>
#include <QString>
#include <QStringList>

/**
 * Read-only git history surface: log, refs, branch comparison, commit detail and the
 * per-file two-sided snapshots. Port of the corresponding GitService methods.
 */
namespace githistory {

struct LogOptions {
    int maxEntries = 32;
    QString ref;
    QString path;
    bool allBranches = true;
};

QJsonArray getCommitLog(const QString &cwd, const LogOptions &options);
QJsonArray getRefs(const QString &cwd);
QJsonObject compareBranches(const QString &cwd, const QString &base, const QString &target);
QString diffFileBetweenRefs(const QString &cwd, const QString &ref1, const QString &ref2, const QString &filePath);

/** Commit metadata plus the file list relative to the first parent; null on failure. */
QJsonValue getCommitDetail(const QString &cwd, const QString &ref);

/** Two-sided content for one file of one commit; null when the file is not in it. */
QJsonValue getCommitFileDiff(const QString &cwd, const QString &ref, const QString &filePath,
                             const QString &originalPath, bool hasOriginalPath, qint64 maxBytes);

/** Full staged diff text for AI commit-message generation, truncated with a marker. */
QString getStagedDiff(const QString &cwd, int maxChars = 100 * 1024);

/** `HEAD` original content of one file, or "" when it is untracked/outside a repo. */
QString getOriginalContent(const QString &filePath, qint64 maxBytes);

} // namespace githistory
