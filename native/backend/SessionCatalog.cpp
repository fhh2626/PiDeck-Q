#include "SessionCatalog.h"

#include <algorithm>

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonValue>
#include <QSaveFile>
#include <QUuid>

namespace {
QString textFromContent(const QJsonValue &content)
{
    if (content.isString()) return content.toString();
    if (!content.isArray()) return {};
    QStringList parts;
    for (const QJsonValue &part : content.toArray()) {
        if (part.isString()) parts.append(part.toString());
        else if (part.isObject()) parts.append(part.toObject().value(QStringLiteral("text")).toString());
    }
    return parts.join(QString());
}

QJsonObject readSessionFile(const QString &filePath)
{
    QFile file(filePath);
    if (!file.open(QIODevice::ReadOnly)) return {};
    QString sessionName;
    QString firstUser;
    QString projectPath;
    int messageCount = 0;
    const QStringList lines = QString::fromUtf8(file.readAll()).split(QLatin1Char('\n'));
    for (const QString &line : lines) {
        if (line.trimmed().isEmpty()) continue;
        const QJsonDocument document = QJsonDocument::fromJson(line.toUtf8());
        if (!document.isObject()) continue;
        const QJsonObject entry = document.object();
        if (entry.value(QStringLiteral("type")).toString() == QStringLiteral("session_info")) {
            const QString name = entry.value(QStringLiteral("name")).toString();
            if (!name.isEmpty()) sessionName = name;
        }
        if (projectPath.isEmpty()) {
            projectPath = entry.value(QStringLiteral("cwd")).toString();
            if (projectPath.isEmpty()) projectPath = entry.value(QStringLiteral("projectPath")).toString();
        }
        const QJsonObject message = entry.value(QStringLiteral("message")).isObject()
            ? entry.value(QStringLiteral("message")).toObject()
            : entry;
        const QString role = message.value(QStringLiteral("role")).toString();
        if (role.isEmpty()) continue;
        messageCount += 1;
        if (role == QStringLiteral("user") && firstUser.isEmpty()) firstUser = textFromContent(message.value(QStringLiteral("content"))).trimmed();
    }
    const QString name = !sessionName.isEmpty() ? sessionName : (!firstUser.isEmpty() ? firstUser : QStringLiteral("Untitled"));
    return QJsonObject{
        {QStringLiteral("id"), filePath},
        {QStringLiteral("filePath"), filePath},
        {QStringLiteral("projectPath"), projectPath},
        {QStringLiteral("name"), name},
        {QStringLiteral("messageCount"), messageCount},
        {QStringLiteral("updatedAt"), static_cast<double>(QFileInfo(filePath).lastModified().toMSecsSinceEpoch())},
        {QStringLiteral("source"), QStringLiteral("pi")},
    };
}

void collectJsonl(const QString &dir, QStringList &files)
{
    const QFileInfoList entries = QDir(dir).entryInfoList(QDir::Files | QDir::Dirs | QDir::NoDotAndDotDot);
    for (const QFileInfo &entry : entries) {
        if (entry.fileName() == QStringLiteral(".pideck-archive")) continue;
        if (entry.isDir()) collectJsonl(entry.absoluteFilePath(), files);
        else if (entry.fileName().endsWith(QStringLiteral(".jsonl"))) files.append(entry.absoluteFilePath());
    }
}
}

SessionCatalogRead listSessionFiles(const QString &sessionsDir, const QString &projectPath)
{
    SessionCatalogRead result;
    if (sessionsDir.trimmed().isEmpty() || !QFileInfo(sessionsDir).isDir()) {
        result.error = QStringLiteral("Session directory is missing");
        return result;
    }
    QStringList files;
    collectJsonl(sessionsDir, files);
    QList<QJsonObject> sessions;
    const QString wanted = QDir::cleanPath(projectPath);
    for (const QString &file : files) {
        const QJsonObject session = readSessionFile(file);
        if (session.isEmpty()) continue;
        if (!wanted.isEmpty()) {
            const QString actual = QDir::cleanPath(session.value(QStringLiteral("projectPath")).toString());
            if (QFileInfo(actual).absoluteFilePath().compare(QFileInfo(wanted).absoluteFilePath(), Qt::CaseInsensitive) != 0 && actual.compare(wanted, Qt::CaseInsensitive) != 0) continue;
        }
        sessions.append(session);
    }
    std::sort(sessions.begin(), sessions.end(), [](const QJsonObject &left, const QJsonObject &right) {
        return left.value(QStringLiteral("updatedAt")).toDouble() > right.value(QStringLiteral("updatedAt")).toDouble();
    });
    for (const QJsonObject &session : sessions) result.sessions.append(session);
    result.ok = true;
    return result;
}

SessionMessagePage readSessionMessagePage(const QString &filePath, int before, int pageSize)
{
    SessionMessagePage result;
    const QString cleaned = QDir::cleanPath(filePath);
    if (cleaned.contains(QStringLiteral("/../")) || cleaned.contains(QStringLiteral("\\..\\")) || !QFileInfo(cleaned).isFile()) {
        result.error = QStringLiteral("Session file is missing");
        return result;
    }
    QFile file(cleaned);
    if (!file.open(QIODevice::ReadOnly)) {
        result.error = QStringLiteral("Unable to read session");
        return result;
    }
    QJsonArray messages;
    const QStringList lines = QString::fromUtf8(file.readAll()).split(QLatin1Char('\n'), Qt::SkipEmptyParts);
    for (const QString &line : lines) {
        const QJsonDocument document = QJsonDocument::fromJson(line.toUtf8());
        if (!document.isObject()) continue;
        const QJsonObject entry = document.object();
        if (entry.contains(QStringLiteral("type")) && entry.value(QStringLiteral("type")).toString() != QStringLiteral("message")) continue;
        const QJsonObject message = entry.value(QStringLiteral("message")).isObject() ? entry.value(QStringLiteral("message")).toObject() : entry;
        const QString role = message.value(QStringLiteral("role")).toString();
        if (role != QStringLiteral("user") && role != QStringLiteral("assistant")) continue;
        const QString content = message.value(QStringLiteral("content")).toString().trimmed();
        if (content.isEmpty()) continue;
        messages.append(QJsonObject{
            {QStringLiteral("role"), role},
            {QStringLiteral("content"), content},
            {QStringLiteral("timestamp"), entry.value(QStringLiteral("timestamp")).toDouble()},
        });
    }
    const int total = messages.size();
    const int size = std::clamp(pageSize <= 0 ? 50 : pageSize, 1, 200);
    const int end = before < 0 || before > total ? total : before;
    const int start = std::max(0, end - size);
    QJsonArray page;
    for (int index = start; index < end; ++index) page.append(messages.at(index));
    result.ok = true;
    result.page = QJsonObject{
        {QStringLiteral("messages"), page},
        {QStringLiteral("total"), total},
        {QStringLiteral("nextBefore"), start == 0 ? QJsonValue(QJsonValue::Null) : QJsonValue(start)},
    };
    return result;
}

namespace {
QString normalizedPath(const QString &path)
{
    return QDir::cleanPath(QFileInfo(path).absoluteFilePath());
}

bool pathInside(const QString &root, const QString &path)
{
    const QString base = normalizedPath(root);
    const QString target = normalizedPath(path);
    return target.compare(base, Qt::CaseInsensitive) == 0 || target.startsWith(base + QStringLiteral("/"), Qt::CaseInsensitive);
}

bool sessionNameAllowed(const QString &name)
{
    return !name.trimmed().isEmpty() && !name.contains(QStringLiteral("..")) && !name.contains(QLatin1Char('/')) && !name.contains(QLatin1Char('\\')) && !name.startsWith(QLatin1Char('-'));
}

QJsonObject readArchiveIndex(const QString &indexPath)
{
    QFile file(indexPath);
    if (!file.open(QIODevice::ReadOnly)) return {};
    return QJsonDocument::fromJson(file.readAll()).object();
}

bool writeArchiveIndex(const QString &indexPath, const QJsonObject &index, QString *error)
{
    QSaveFile file(indexPath);
    if (!file.open(QIODevice::WriteOnly) || file.write(QJsonDocument(index).toJson(QJsonDocument::Compact)) < 0 || !file.commit()) {
        if (error) *error = QStringLiteral("Unable to write archive index");
        return false;
    }
    return true;
}

QJsonObject sessionByPath(const QString &sessionsDir, const QString &filePath)
{
    const SessionCatalogRead listed = listSessionFiles(sessionsDir);
    for (const QJsonValue &session : listed.sessions) {
        if (normalizedPath(session.toObject().value(QStringLiteral("filePath")).toString()).compare(normalizedPath(filePath), Qt::CaseInsensitive) == 0) return session.toObject();
    }
    return {};
}
}

SessionCatalogRead createSessionDraft(const QString &sessionsDir, const QString &name, const QString &projectPath)
{
    SessionCatalogRead result;
    if (!sessionNameAllowed(name) || !QFileInfo(sessionsDir).isDir()) {
        result.error = QStringLiteral("Session draft is invalid");
        return result;
    }
    const QString filePath = QDir(sessionsDir).filePath(QStringLiteral("draft-%1.jsonl").arg(QUuid::createUuid().toString(QUuid::WithoutBraces)));
    QSaveFile file(filePath);
    const QJsonObject info{
        {QStringLiteral("type"), QStringLiteral("session_info")},
        {QStringLiteral("name"), name.trimmed()},
        {QStringLiteral("cwd"), projectPath},
    };
    if (!file.open(QIODevice::WriteOnly) || file.write(QJsonDocument(info).toJson(QJsonDocument::Compact) + "\n") < 0 || !file.commit()) {
        result.error = QStringLiteral("Unable to create session draft");
        return result;
    }
    result.sessions.append(sessionByPath(sessionsDir, filePath));
    result.ok = true;
    return result;
}

SessionCatalogRead renameSessionFile(const QString &sessionsDir, const QString &filePath, const QString &name)
{
    SessionCatalogRead result;
    if (!sessionNameAllowed(name) || !pathInside(sessionsDir, filePath) || !QFileInfo(filePath).isFile()) {
        result.error = QStringLiteral("Session rename is invalid");
        return result;
    }
    QFile file(filePath);
    const QJsonObject info{{QStringLiteral("type"), QStringLiteral("session_info")}, {QStringLiteral("name"), name.trimmed()}};
    if (!file.open(QIODevice::Append) || file.write(QByteArray("\n") + QJsonDocument(info).toJson(QJsonDocument::Compact) + QByteArray("\n")) < 0 || !file.flush()) {
        result.error = QStringLiteral("Unable to rename session");
        return result;
    }
    file.close();
    result.sessions.append(sessionByPath(sessionsDir, filePath));
    result.ok = true;
    return result;
}

SessionCatalogRead archiveSessionFile(const QString &sessionsDir, const QString &filePath)
{
    SessionCatalogRead result;
    if (!pathInside(sessionsDir, filePath) || filePath.contains(QStringLiteral(".pideck-archive")) || !QFileInfo(filePath).isFile()) {
        result.error = QStringLiteral("Session archive is invalid");
        return result;
    }
    const QString archiveDir = QDir(sessionsDir).filePath(QStringLiteral(".pideck-archive"));
    if (!QDir().mkpath(archiveDir)) {
        result.error = QStringLiteral("Unable to create archive directory");
        return result;
    }
    const QString destination = QDir(archiveDir).filePath(QFileInfo(filePath).fileName());
    if (QFileInfo::exists(destination) || !QFile::rename(filePath, destination)) {
        result.error = QStringLiteral("Unable to archive session");
        return result;
    }
    QJsonObject index = readArchiveIndex(QDir(archiveDir).filePath(QStringLiteral("index.json")));
    index.insert(normalizedPath(destination), normalizedPath(filePath));
    QString error;
    if (!writeArchiveIndex(QDir(archiveDir).filePath(QStringLiteral("index.json")), index, &error)) {
        QFile::rename(destination, filePath);
        result.error = error;
        return result;
    }
    result.sessions.append(QJsonObject{{QStringLiteral("filePath"), destination}});
    result.ok = true;
    return result;
}

SessionCatalogRead unarchiveSessionFile(const QString &sessionsDir, const QString &archivedPath)
{
    SessionCatalogRead result;
    const QString archiveDir = QDir(sessionsDir).filePath(QStringLiteral(".pideck-archive"));
    if (!pathInside(archiveDir, archivedPath) || !QFileInfo(archivedPath).isFile()) {
        result.error = QStringLiteral("Archived session is invalid");
        return result;
    }
    const QString indexPath = QDir(archiveDir).filePath(QStringLiteral("index.json"));
    QJsonObject index = readArchiveIndex(indexPath);
    const QString original = index.value(normalizedPath(archivedPath)).toString();
    if (original.isEmpty() || !pathInside(sessionsDir, original) || QFileInfo::exists(original) || !QFile::rename(archivedPath, original)) {
        result.error = QStringLiteral("Unable to restore archived session");
        return result;
    }
    index.remove(normalizedPath(archivedPath));
    QString error;
    if (!writeArchiveIndex(indexPath, index, &error)) {
        result.error = error;
        return result;
    }
    result.sessions.append(sessionByPath(sessionsDir, original));
    result.ok = true;
    return result;
}

SessionCatalogRead deleteSessionFile(const QString &sessionsDir, const QString &filePath)
{
    SessionCatalogRead result;
    if (!pathInside(sessionsDir, filePath)) {
        result.error = QStringLiteral("Session delete is invalid");
        return result;
    }
    if (!QFileInfo::exists(filePath)) {
        result.ok = true;
        return result;
    }
    if (!QFile::moveToTrash(filePath)) {
        result.error = QStringLiteral("Unable to move session to trash");
        return result;
    }
    result.ok = true;
    return result;
}

SessionCatalogRead copySessionFile(const QString &sessionsDir, const QString &filePath)
{
    SessionCatalogRead result;
    if (!pathInside(sessionsDir, filePath) || !QFileInfo(filePath).isFile()) {
        result.error = QStringLiteral("Session copy is invalid");
        return result;
    }
    const QFileInfo info(filePath);
    const QString destination = info.dir().filePath(info.completeBaseName() + QStringLiteral("-copy.jsonl"));
    if (QFileInfo::exists(destination) || !QFile::copy(filePath, destination)) {
        result.error = QStringLiteral("Unable to copy session");
        return result;
    }
    result.sessions.append(sessionByPath(sessionsDir, destination));
    result.ok = true;
    return result;
}
