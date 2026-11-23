#include "ProjectRecord.h"

#include <algorithm>
#include <cmath>
#include <limits>

#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QJsonValue>
#include <QSet>

namespace projects {

const QString kChatProjectId = QStringLiteral("builtin-chat");
const QString kChatProjectName = QStringLiteral("Chat");

namespace {

bool finiteNumber(const QJsonValue &value)
{
    return value.isDouble() && std::isfinite(value.toDouble());
}

/** `\\wsl$` / `\\wsl.localhost` UNC form, the only place where path case is significant. */
struct WslUncPath {
    QString distro;
    QString linuxPath;
};

WslUncPath parseWslUncPath(const QString &path)
{
    static const QRegularExpression pattern(
        QStringLiteral("^[\\\\/]{2}(?:wsl\\$|wsl\\.localhost)[\\\\/]([^\\\\/]+)(?:[\\\\/](.*))?$"),
        QRegularExpression::CaseInsensitiveOption);
    const QRegularExpressionMatch match = pattern.match(path);
    if (!match.hasMatch()) return {};
    QString remainder = match.captured(2);
    remainder.replace(QRegularExpression(QStringLiteral("[\\\\/]+")), QStringLiteral("/"));
    QString linuxPath = QDir::cleanPath(QStringLiteral("/") + remainder);
    if (linuxPath != QStringLiteral("/")) {
        while (linuxPath.endsWith(QLatin1Char('/'))) linuxPath.chop(1);
    }
    return WslUncPath{match.captured(1), linuxPath};
}

} // namespace

QJsonObject parseProjectRecord(const QJsonValue &value)
{
    if (!value.isObject()) return {};
    const QJsonObject record = value.toObject();
    const QJsonValue idValue = record.value(QStringLiteral("id"));
    const QJsonValue pathValue = record.value(QStringLiteral("path"));
    if (!idValue.isString() || idValue.toString().isEmpty()) return {};
    if (!pathValue.isString() || pathValue.toString().isEmpty()) return {};

    const QString path = pathValue.toString();
    const QJsonValue nameValue = record.value(QStringLiteral("name"));
    QJsonObject project{
        {QStringLiteral("id"), idValue.toString()},
        {QStringLiteral("path"), path},
        // The sidebar must always have a label, so a missing name falls back to the path.
        {QStringLiteral("name"),
         nameValue.isString() && !nameValue.toString().isEmpty() ? nameValue.toString() : path},
        {QStringLiteral("lastOpenedAt"),
         finiteNumber(record.value(QStringLiteral("lastOpenedAt")))
             ? record.value(QStringLiteral("lastOpenedAt")).toDouble()
             : 0.0},
    };
    if (record.value(QStringLiteral("pinned")).isBool()) {
        project.insert(QStringLiteral("pinned"), record.value(QStringLiteral("pinned")));
    }
    if (finiteNumber(record.value(QStringLiteral("sortOrder")))) {
        project.insert(QStringLiteral("sortOrder"), record.value(QStringLiteral("sortOrder")));
    }
    if (record.value(QStringLiteral("kind")).toString() == QStringLiteral("chat")) {
        project.insert(QStringLiteral("kind"), QStringLiteral("chat"));
    }
    if (record.value(QStringLiteral("worktreeEnabled")).isBool()) {
        project.insert(QStringLiteral("worktreeEnabled"), record.value(QStringLiteral("worktreeEnabled")));
    }
    if (record.value(QStringLiteral("worktreeParentId")).isString()) {
        project.insert(QStringLiteral("worktreeParentId"),
                       record.value(QStringLiteral("worktreeParentId")));
    }
    const QString environment = record.value(QStringLiteral("environment")).toString();
    if (environment == QStringLiteral("windows") || environment == QStringLiteral("wsl")) {
        project.insert(QStringLiteral("environment"), environment);
    }
    return project;
}

bool parseProjectCatalog(const QJsonValue &value, CatalogParse *out)
{
    if (!value.isArray()) return false;
    CatalogParse result;
    QSet<QString> seen;
    for (const QJsonValue &item : value.toArray()) {
        const QJsonObject project = parseProjectRecord(item);
        const QString id = project.value(QStringLiteral("id")).toString();
        // A duplicate id makes get(id) non-deterministic, so the first record wins.
        if (id.isEmpty() || seen.contains(id)) {
            ++result.dropped;
            continue;
        }
        seen.insert(id);
        result.projects.append(project);
    }
    if (out) *out = result;
    return true;
}

bool isChatProject(const QJsonObject &project)
{
    return project.value(QStringLiteral("kind")).toString() == QStringLiteral("chat")
        || project.value(QStringLiteral("id")).toString() == kChatProjectId;
}

double projectSortOrder(const QJsonObject &project)
{
    const QJsonValue value = project.value(QStringLiteral("sortOrder"));
    if (value.isDouble() && std::isfinite(value.toDouble())) return value.toDouble();
    return double(std::numeric_limits<qint64>::max());
}

QJsonArray sortProjects(const QJsonArray &projects)
{
    QList<QJsonObject> list;
    list.reserve(projects.size());
    for (const QJsonValue &value : projects) list.append(value.toObject());
    std::stable_sort(list.begin(), list.end(), [](const QJsonObject &left, const QJsonObject &right) {
        const int chatRank = int(isChatProject(right)) - int(isChatProject(left));
        if (chatRank != 0) return chatRank < 0;
        const int pinnedRank = int(right.value(QStringLiteral("pinned")).toBool())
            - int(left.value(QStringLiteral("pinned")).toBool());
        if (pinnedRank != 0) return pinnedRank < 0;
        const double leftOrder = projectSortOrder(left);
        const double rightOrder = projectSortOrder(right);
        if (leftOrder != rightOrder) return leftOrder < rightOrder;
        return left.value(QStringLiteral("lastOpenedAt")).toDouble()
            > right.value(QStringLiteral("lastOpenedAt")).toDouble();
    });
    QJsonArray sorted;
    for (const QJsonObject &project : list) sorted.append(project);
    return sorted;
}

QString normalizeProjectPath(const QString &path)
{
    if (path.isEmpty()) return {};
#ifdef Q_OS_WIN
    // A leading slash is a WSL Linux path: resolving it would prepend the current
    // drive and turn /mnt/d/x into D:\mnt\d\x.
    if (path.startsWith(QLatin1Char('/'))) {
        QString trimmed = path;
        while (trimmed.size() > 1 && trimmed.endsWith(QLatin1Char('/'))) trimmed.chop(1);
        return trimmed;
    }
    const QString absolute = QDir::isAbsolutePath(path)
        ? path
        : QDir::current().absoluteFilePath(path);
    return QDir::toNativeSeparators(QDir::cleanPath(absolute));
#else
    const QString absolute = QDir::isAbsolutePath(path)
        ? path
        : QDir::current().absoluteFilePath(path);
    return QDir::cleanPath(absolute);
#endif
}

bool sameProjectPath(const QString &left, const QString &right)
{
    const WslUncPath leftWsl = parseWslUncPath(left);
    const WslUncPath rightWsl = parseWslUncPath(right);
    if (!leftWsl.distro.isEmpty() && !rightWsl.distro.isEmpty()) {
        return leftWsl.distro.compare(rightWsl.distro, Qt::CaseInsensitive) == 0
            && leftWsl.linuxPath == rightWsl.linuxPath;
    }
    const QString a = normalizeProjectPath(left);
    const QString b = normalizeProjectPath(right);
    if (a.isEmpty() || b.isEmpty()) return false;
#ifdef Q_OS_WIN
    // Linux paths keep their case: the Linux filesystem is case sensitive.
    if (left.startsWith(QLatin1Char('/')) && right.startsWith(QLatin1Char('/'))) return a == b;
    return a.compare(b, Qt::CaseInsensitive) == 0;
#else
    return a == b;
#endif
}

QJsonArray readProjectRecords(const QString &filePath, int *dropped)
{
    if (dropped) *dropped = 0;
    QFile file(filePath);
    if (!file.exists()) return {};
    if (!file.open(QIODevice::ReadOnly)) return {};
    QJsonParseError error;
    const QJsonDocument document = QJsonDocument::fromJson(file.readAll(), &error);
    if (error.error != QJsonParseError::NoError) return {};
    CatalogParse parsed;
    if (!parseProjectCatalog(document.isArray() ? QJsonValue(document.array())
                                                : QJsonValue(QJsonValue::Undefined),
                             &parsed)) {
        return {};
    }
    if (dropped) *dropped = parsed.dropped;
    return parsed.projects;
}

} // namespace projects
