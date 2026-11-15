#pragma once

#include <QByteArray>
#include <QJsonArray>
#include <QString>
#include <QList>

/**
 * Pure parsers for git plumbing output.
 *
 * Ported from parsePorcelainStatus / parseDiffNameStatus / parseCommits / parseRefs in
 * src/main/git/GitService.ts. Keeping them free of process and filesystem access is
 * what makes the VS Code status semantics testable without a repository.
 */
namespace porcelain {

/** Numeric GitStatus values; the renderer compares against this enum. */
enum GitStatus {
    INDEX_MODIFIED = 0,
    INDEX_ADDED = 1,
    INDEX_DELETED = 2,
    INDEX_RENAMED = 3,
    INDEX_COPIED = 4,
    MODIFIED = 5,
    DELETED = 6,
    UNTRACKED = 7,
    IGNORED = 8,
    INTENT_TO_ADD = 9,
    INTENT_TO_RENAME = 10,
    TYPE_CHANGED = 11,
    ADDED_BY_US = 12,
    ADDED_BY_THEM = 13,
    DELETED_BY_US = 14,
    DELETED_BY_THEM = 15,
    BOTH_ADDED = 16,
    BOTH_DELETED = 17,
    BOTH_MODIFIED = 18,
    INDEX_TYPE_CHANGED = 19,
};

struct Resource {
    QString path;
    int status = MODIFIED;
    QString letter;
    QString oldPath;
    bool hasOldPath = false;
};

/**
 * Parse `git status --porcelain -z`. X and Y produce **separate** resources because a
 * file can be staged and modified at once; unresolved conflicts are one resource and
 * never split into index/workingTree.
 */
QList<Resource> parseStatus(const QByteArray &raw);

/** Parse `--name-status -z` output into GitChangedFile entries. */
QJsonArray parseDiffNameStatus(const QByteArray &raw);

/** Parse the `%H%n%aN%n%aE%n%at%n%ct%n%P%n%D%n%s` + `-z` log format. */
QJsonArray parseCommits(const QString &data, bool includeFullMessage);

/** Parse `for-each-ref --format=%(refname)%00%(objectname)%00%(*objectname)`. */
QJsonArray parseRefs(const QString &data);

/** Parse the `N files changed, N insertions(+), N deletions(-)` summary line. */
void parseShortStat(const QString &data, int *files, int *insertions, int *deletions);

/** GitChangedFile.status token for one GitStatus value. */
QString statusToken(int status);

} // namespace porcelain
