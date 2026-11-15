#include "PorcelainStatus.h"

#include <QJsonObject>
#include <QRegularExpression>
#include <QStringList>

namespace porcelain {
namespace {

QString letterFor(int status)
{
    switch (status) {
    case INDEX_MODIFIED:
    case MODIFIED:
        return QStringLiteral("M");
    case INDEX_ADDED:
        return QStringLiteral("A");
    case INDEX_DELETED:
    case DELETED:
        return QStringLiteral("D");
    case INDEX_RENAMED:
    case INTENT_TO_RENAME:
        return QStringLiteral("R");
    case INDEX_COPIED:
        return QStringLiteral("C");
    case UNTRACKED:
        return QStringLiteral("U");
    case IGNORED:
        return QStringLiteral("I");
    case TYPE_CHANGED:
    case INDEX_TYPE_CHANGED:
        return QStringLiteral("T");
    default:
        return QStringLiteral("!");
    }
}

QString statusTokenFor(int status)
{
    switch (status) {
    case INDEX_MODIFIED:
    case MODIFIED:
        return QStringLiteral("modified");
    case INDEX_ADDED:
        return QStringLiteral("added");
    case INDEX_DELETED:
    case DELETED:
        return QStringLiteral("deleted");
    case INDEX_RENAMED:
    case INDEX_COPIED:
    case INTENT_TO_RENAME:
        return QStringLiteral("renamed");
    default:
        return QStringLiteral("modified");
    }
}

bool isHexHash(const QString &value)
{
    if (value.size() != 40) return false;
    for (const QChar character : value) {
        if (!character.isDigit() && !(character >= QLatin1Char('a') && character <= QLatin1Char('f'))
            && !(character >= QLatin1Char('A') && character <= QLatin1Char('F'))) {
            return false;
        }
    }
    return true;
}

} // namespace

QList<Resource> parseStatus(const QByteArray &raw)
{
    QList<Resource> result;
    QList<QByteArray> fields = raw.split('\0');
    fields.removeAll(QByteArray());
    int index = 0;
    while (index < fields.size()) {
        const QByteArray line = fields.at(index++);
        if (line.size() < 3) continue;
        const char x = line.at(0);
        const char y = line.at(1);
        const QString filePath = QString::fromUtf8(line.mid(3));
        // porcelain -z puts the *current* path first and the original path in the
        // following NUL field, which is the reverse of the readable format.
        QString oldPath;
        bool hasOldPath = false;
        if (x == 'R' || x == 'C' || y == 'R' || y == 'C') {
            if (index < fields.size()) {
                oldPath = QString::fromUtf8(fields.at(index++));
                hasOldPath = true;
            }
        }
        const auto push = [&result, &filePath, &oldPath, hasOldPath](int status, const QString &letter,
                                                                    bool includeOldPath) {
            Resource resource;
            resource.path = filePath;
            resource.status = status;
            resource.letter = letter;
            if (includeOldPath && hasOldPath) {
                resource.oldPath = oldPath;
                resource.hasOldPath = true;
            }
            result.append(resource);
        };

        // An unresolved conflict is one resource; it must not be split into
        // index/workingTree as well.
        if (x == 'U' && y == 'U') { push(BOTH_MODIFIED, QStringLiteral("!"), false); continue; }
        if (x == 'A' && y == 'A') { push(BOTH_ADDED, QStringLiteral("!"), false); continue; }
        if (x == 'D' && y == 'D') { push(BOTH_DELETED, QStringLiteral("!"), false); continue; }
        if (x == 'A' && y == 'U') { push(ADDED_BY_US, QStringLiteral("!"), false); continue; }
        if (x == 'U' && y == 'A') { push(ADDED_BY_THEM, QStringLiteral("!"), false); continue; }
        if (x == 'D' && y == 'U') { push(DELETED_BY_US, QStringLiteral("!"), false); continue; }
        if (x == 'U' && y == 'D') { push(DELETED_BY_THEM, QStringLiteral("!"), false); continue; }
        if (x == '?' && y == '?') { push(UNTRACKED, QStringLiteral("U"), false); continue; }
        if (x == '!' && y == '!') { push(IGNORED, QStringLiteral("I"), false); continue; }

        // X and Y are separate resources: one file can be staged and modified.
        if (x == 'M') push(INDEX_MODIFIED, letterFor(INDEX_MODIFIED), false);
        else if (x == 'A') push(INDEX_ADDED, letterFor(INDEX_ADDED), false);
        else if (x == 'D') push(INDEX_DELETED, letterFor(INDEX_DELETED), false);
        else if (x == 'R') push(INDEX_RENAMED, letterFor(INDEX_RENAMED), true);
        else if (x == 'C') push(INDEX_COPIED, letterFor(INDEX_COPIED), true);
        else if (x == 'T') push(INDEX_TYPE_CHANGED, letterFor(INDEX_TYPE_CHANGED), false);

        if (y == 'M') push(MODIFIED, letterFor(MODIFIED), false);
        else if (y == 'D') push(DELETED, letterFor(DELETED), false);
        else if (y == 'R' || y == 'C') push(INTENT_TO_RENAME, letterFor(INTENT_TO_RENAME), true);
        else if (y == 'T') push(TYPE_CHANGED, letterFor(TYPE_CHANGED), false);
    }
    return result;
}

QJsonArray parseDiffNameStatus(const QByteArray &raw)
{
    QJsonArray files;
    const QList<QByteArray> fields = raw.split('\0');
    int index = 0;
    while (index < fields.size() - 1) {
        const QString statusToken = QString::fromUtf8(fields.at(index++));
        const QString originalOrCurrentPath = QString::fromUtf8(fields.at(index++));
        const QChar statusChar = statusToken.isEmpty() ? QChar() : statusToken.at(0);
        const bool isRenameOrCopy = statusChar == QLatin1Char('R') || statusChar == QLatin1Char('C');
        const QString currentPath = isRenameOrCopy
            ? (index < fields.size() ? QString::fromUtf8(fields.at(index++)) : QString())
            : originalOrCurrentPath;
        if (currentPath.isEmpty()) continue;
        QJsonObject file{
            {QStringLiteral("path"), currentPath},
            {QStringLiteral("status"), statusChar == QLatin1Char('A') ? QStringLiteral("added")
                     : statusChar == QLatin1Char('D') ? QStringLiteral("deleted")
                     : isRenameOrCopy                 ? QStringLiteral("renamed")
                                                      : QStringLiteral("modified")},
        };
        if (isRenameOrCopy && !originalOrCurrentPath.isEmpty()) {
            file.insert(QStringLiteral("originalPath"), originalOrCurrentPath);
        }
        files.append(file);
    }
    return files;
}

void parseShortStat(const QString &data, int *files, int *insertions, int *deletions)
{
    *files = 0;
    *insertions = 0;
    *deletions = 0;
    static const QRegularExpression pattern(
        QStringLiteral("(\\d+) files? changed(?:, (\\d+) insertions?\\(\\+\\))?(?:, (\\d+) deletions?\\(-\\))?"));
    const QRegularExpressionMatch match = pattern.match(data.trimmed());
    if (!match.hasMatch()) return;
    *files = match.captured(1).toInt();
    if (!match.captured(2).isEmpty()) *insertions = match.captured(2).toInt();
    if (!match.captured(3).isEmpty()) *deletions = match.captured(3).toInt();
}

QJsonArray parseCommits(const QString &data, bool includeFullMessage)
{
    QJsonArray commits;
    const QList<QString> chunks = data.split(QChar(0), Qt::KeepEmptyParts);
    for (int index = 0; index < chunks.size(); ++index) {
        const QString chunk = chunks.at(index);
        if (chunk.isEmpty()) continue;
        const QStringList lines = chunk.split(QLatin1Char('\n'), Qt::KeepEmptyParts);
        if (lines.size() < 8 || !isHexHash(lines.at(0))) {
            // A trailing `--shortstat` fragment belongs to the previous commit.
            if (!commits.isEmpty() && chunk.contains(QLatin1String("changed"))) {
                int files = 0;
                int insertions = 0;
                int deletions = 0;
                parseShortStat(chunk, &files, &insertions, &deletions);
                QJsonObject commit = commits.last().toObject();
                commit.insert(QStringLiteral("shortStat"), QJsonObject{
                    {QStringLiteral("files"), files},
                    {QStringLiteral("insertions"), insertions},
                    {QStringLiteral("deletions"), deletions},
                });
                commits.replace(commits.size() - 1, commit);
            }
            continue;
        }
        QString message = QStringList(lines.mid(7)).join(QLatin1Char('\n'));
        if (message.endsWith(QLatin1Char('\n'))) message.chop(1);
        const QString parentsRaw = lines.at(5);
        const QString refNamesRaw = lines.at(6);
        QStringList parents;
        for (const QString &parent : parentsRaw.split(QLatin1Char(' '), Qt::SkipEmptyParts)) parents.append(parent);
        QStringList refNames;
        for (const QString &ref : refNamesRaw.split(QLatin1Char(','))) {
            const QString trimmed = ref.trimmed();
            if (!trimmed.isEmpty()) refNames.append(trimmed);
        }
        QJsonArray parentsJson;
        for (const QString &parent : parents) parentsJson.append(parent);
        QJsonArray refsJson;
        for (const QString &ref : refNames) refsJson.append(ref);
        const QString subject = message.split(QLatin1Char('\n')).value(0);
        QJsonObject commit{
            {QStringLiteral("hash"), lines.at(0)},
            {QStringLiteral("shortHash"), lines.at(0).left(7)},
            {QStringLiteral("message"), subject},
            {QStringLiteral("authorName"), lines.at(1)},
            {QStringLiteral("authorEmail"), lines.at(2)},
            {QStringLiteral("authorDate"), lines.at(3).toDouble() * 1000.0},
            {QStringLiteral("parents"), parentsJson},
            {QStringLiteral("refNames"), refsJson},
            {QStringLiteral("graph"), QJsonArray{}},
        };
        if (includeFullMessage) commit.insert(QStringLiteral("fullMessage"), message);
        commits.append(commit);
    }
    return commits;
}

QJsonArray parseRefs(const QString &data)
{
    QJsonArray refs;
    const QStringList lines = data.split(QLatin1Char('\n'), Qt::SkipEmptyParts);
    for (const QString &line : lines) {
        const QStringList fields = line.split(QChar(0), Qt::KeepEmptyParts);
        if (fields.size() < 2) continue;
        const QString fullName = fields.at(0);
        if (!fullName.startsWith(QLatin1String("refs/"))) continue;
        const QString objectName = fields.at(1);
        if (!isHexHash(objectName)) continue;
        const QString peeled = fields.size() > 2 ? fields.at(2) : QString();
        const QString effectiveHash = isHexHash(peeled) ? peeled : objectName;
        QString type;
        QString name;
        if (fullName.startsWith(QLatin1String("refs/heads/"))) {
            type = QStringLiteral("head");
            name = fullName.mid(11);
        } else if (fullName.startsWith(QLatin1String("refs/remotes/"))) {
            type = QStringLiteral("remote");
            name = fullName.mid(13);
        } else if (fullName.startsWith(QLatin1String("refs/tags/"))) {
            type = QStringLiteral("tag");
            name = fullName.mid(10);
        } else {
            continue;
        }
        refs.append(QJsonObject{
            {QStringLiteral("name"), name},
            {QStringLiteral("fullName"), fullName},
            {QStringLiteral("hash"), effectiveHash},
            {QStringLiteral("type"), type},
        });
    }
    return refs;
}

QString statusToken(int status)
{
    return statusTokenFor(status);
}

} // namespace porcelain
