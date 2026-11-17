#pragma once

#include "SessionFs.h"
#include "SessionIdentity.h"

#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLockFile>
#include <QSaveFile>

/** Durable scan provenance, scoped to the project and exact filesystem environment. */
namespace sessionroothistory {
inline QString canonicalRoot(const SessionFs &fs, const QString &root)
{
    if (!fs.wsl()) return QFileInfo(root).canonicalFilePath();
    const auto result = fs.runCapture({QStringLiteral("realpath"), QStringLiteral("-e"),
                                       QStringLiteral("--"), root}, 10000, 16384);
    if (!result.ok()) return {};
    const QString path = result.stdoutText.trimmed();
    return path.startsWith(QLatin1Char('/')) && !path.contains(QLatin1Char('\n')) ? path : QString();
}

inline QString key(const SessionFs &fs, const QString &project, const QString &runtimeProject)
{
    const auto &config = fs.config();
    const QJsonArray scope{config.wsl, config.distro, config.user, config.home,
                           sessionidentity::normalizeScanPath(project), runtimeProject};
    return QString::fromLatin1(QCryptographicHash::hash(QJsonDocument(scope).toJson(QJsonDocument::Compact),
                                                       QCryptographicHash::Sha256).toHex());
}

inline QJsonObject load(const QString &path)
{
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly) || file.size() > 4 * 1024 * 1024) return {};
    return QJsonDocument::fromJson(file.readAll()).object();
}

inline QString historyPath(const QString &userData)
{
    return userData.isEmpty() ? QString() : QDir(userData).filePath(QStringLiteral("session-root-history.json"));
}

/** Record only roots resolved from actual settings, never paths supplied by the catalog. */
inline void remember(const QString &userData, const SessionFs &fs, const QString &project,
                     const QString &runtimeProject, const QStringList &roots)
{
    const QString path = historyPath(userData);
    if (path.isEmpty() || project.isEmpty() || runtimeProject.isEmpty()) return;
    QLockFile lock(path + QStringLiteral(".lock"));
    if (!lock.tryLock(1000)) return;
    QJsonObject all = load(path);
    const QString scope = key(fs, project, runtimeProject);
    QJsonArray entries = all.value(scope).toArray();
    for (const QString &root : roots) {
        const QString canonical = canonicalRoot(fs, root);
        if (canonical.isEmpty()) continue;
        bool present = false;
        for (const QJsonValue &entry : entries) {
            const QJsonObject object = entry.toObject();
            if (object.value(QStringLiteral("root")).toString() == root
                && object.value(QStringLiteral("canonical")).toString() == canonical) { present = true; break; }
        }
        if (!present && entries.size() < 256)
            entries.append(QJsonObject{{QStringLiteral("root"), root}, {QStringLiteral("canonical"), canonical}});
    }
    all.insert(scope, entries);
    const QByteArray data = QJsonDocument(all).toJson(QJsonDocument::Compact);
    if (data.size() > 4 * 1024 * 1024) return;
    QSaveFile file(path);
    if (file.open(QIODevice::WriteOnly) && file.write(data) == data.size()) file.commit();
}

/** Reject roots retargeted since the trusted scan, including configured root symlinks. */
inline QStringList roots(const QString &userData, const SessionFs &fs, const QString &project,
                         const QString &runtimeProject)
{
    QStringList result;
    const QString path = historyPath(userData);
    if (path.isEmpty() || project.isEmpty() || runtimeProject.isEmpty()) return result;
    const QJsonArray entries = load(path).value(key(fs, project, runtimeProject)).toArray();
    for (const QJsonValue &entry : entries) {
        const QJsonObject object = entry.toObject();
        const QString root = object.value(QStringLiteral("root")).toString();
        const QString canonical = object.value(QStringLiteral("canonical")).toString();
        if (!root.isEmpty() && !canonical.isEmpty() && canonicalRoot(fs, root) == canonical) result.append(root);
    }
    return result;
}
} // namespace sessionroothistory
