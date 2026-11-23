#include "ScratchPad.h"

#include "JsonFile.h"

#include "../../process/TextEncoding.h"

#include <algorithm>

#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>

namespace scratchpad {
namespace {

QString draftsDir(const QString &userDataDir)
{
    return QDir(userDataDir).filePath(QStringLiteral("drafts"));
}

/** `YYYY-MM-DD HH-mm-ss` — the same shape the oracle's generateDraftName produces. */
QString timestampName(const QDateTime &value)
{
    return value.toString(QStringLiteral("yyyy-MM-dd HH-mm-ss"));
}

QJsonObject metaFor(const QString &path)
{
    const QFileInfo info(path);
    const QString base = info.completeBaseName();
    return QJsonObject{
        {QStringLiteral("id"), base},
        {QStringLiteral("name"), base},
        {QStringLiteral("path"), info.absoluteFilePath()},
        {QStringLiteral("createdAt"), double(info.birthTime().toMSecsSinceEpoch())},
        {QStringLiteral("updatedAt"), double(info.lastModified().toMSecsSinceEpoch())},
    };
}

} // namespace

void ensureDraftsDir(const QString &userDataDir)
{
    QDir().mkpath(draftsDir(userDataDir));
    // Legacy single-file scratch pad: keep the content as a dated draft, then drop it.
    const QString legacy = QDir(userDataDir).filePath(QStringLiteral("scratch-pad.md"));
    const QFileInfo legacyInfo(legacy);
    if (!legacyInfo.exists()) return;
    if (legacyInfo.size() > 0) {
        const QString name = timestampName(legacyInfo.lastModified()) + QStringLiteral(".md");
        QFile::copy(legacy, QDir(draftsDir(userDataDir)).filePath(name));
    }
    QFile::remove(legacy);
}

QJsonArray list(const QString &userDataDir)
{
    ensureDraftsDir(userDataDir);
    const QFileInfoList entries =
        QDir(draftsDir(userDataDir)).entryInfoList(QStringList{QStringLiteral("*.md")},
                                                   QDir::Files, QDir::NoSort);
    QList<QJsonObject> drafts;
    for (const QFileInfo &entry : entries) {
        if (!entry.exists()) continue;
        drafts.append(metaFor(entry.absoluteFilePath()));
    }
    std::stable_sort(drafts.begin(), drafts.end(),
                     [](const QJsonObject &left, const QJsonObject &right) {
                         return left.value(QStringLiteral("updatedAt")).toDouble()
                             > right.value(QStringLiteral("updatedAt")).toDouble();
                     });
    QJsonArray result;
    for (const QJsonObject &draft : drafts) result.append(draft);
    return result;
}

QJsonObject create(const QString &userDataDir)
{
    ensureDraftsDir(userDataDir);
    const QString name = timestampName(QDateTime::currentDateTime());
    const QString path = QDir(draftsDir(userDataDir)).filePath(name + QStringLiteral(".md"));
    QString error;
    if (!jsonfile::writeBytesAtomic(path, QByteArray(), &error)) {
        throw textenc::error(error);
    }
    return metaFor(path);
}

QJsonObject load(const QString &draftPath)
{
    if (draftPath.isEmpty()) {
        return QJsonObject{{QStringLiteral("content"), QString()},
                           {QStringLiteral("lastEditedAt"), 0},
                           {QStringLiteral("cursorPosition"), 0}};
    }
    QString content;
    if (!jsonfile::readText(draftPath, &content)) {
        return QJsonObject{{QStringLiteral("content"), QString()},
                           {QStringLiteral("lastEditedAt"), 0},
                           {QStringLiteral("cursorPosition"), 0}};
    }
    const QFileInfo info(draftPath);
    return QJsonObject{
        {QStringLiteral("content"), content},
        {QStringLiteral("lastEditedAt"), double(info.lastModified().toMSecsSinceEpoch())},
        {QStringLiteral("cursorPosition"), 0},
    };
}

void save(const QString &userDataDir, const QString &draftPath, const QString &content)
{
    ensureDraftsDir(userDataDir);
    QString error;
    if (!jsonfile::writeBytesAtomic(draftPath, content.toUtf8(), &error)) {
        throw textenc::error(error);
    }
}

QString draftPathFor(const QString &draftPath)
{
    return draftPath.isEmpty() ? QString() : QFileInfo(draftPath).absoluteFilePath();
}

bool insideDrafts(const QString &userDataDir, const QString &draftPath)
{
    const QString path = draftPathFor(draftPath);
    if (path.isEmpty()) return false;
    const QString root = QDir::cleanPath(QDir(draftsDir(userDataDir)).absolutePath());
    const QString target = QDir::cleanPath(path);
    if (root.isEmpty()) return false;
#ifdef Q_OS_WIN
    return target.compare(root, Qt::CaseInsensitive) == 0
        || target.startsWith(root + QStringLiteral("/"), Qt::CaseInsensitive);
#else
    return target == root || target.startsWith(root + QStringLiteral("/"));
#endif
}

} // namespace scratchpad
