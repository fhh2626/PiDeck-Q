#pragma once

#include "SessionFs.h"
#include "SessionIdentity.h"
#include "../fs/PathPolicy.h"

#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLockFile>
#include <QSaveFile>

/** Durable scan provenance, scoped to the project and exact filesystem environment. */
namespace sessionroothistory {
/** Version 2 proves canonical path decoding preserved the filesystem's exact bytes. */
constexpr int kCanonicalVersion = 2;

inline QString canonicalRoot(const SessionFs &fs, const QString &root)
{
    // Qt's Windows canonicalFilePath keeps directory junction names. Resolve
    // through the existing handle-based policy so retargeting changes identity.
    if (!fs.wsl()) return pathpolicy::existingRealPath(root);
    const auto result = fs.runCapture({QStringLiteral("realpath"), QStringLiteral("-e"),
                                       QStringLiteral("--"), root}, 10000, 16384);
    if (!result.ok() || !result.stdoutLosslessUtf8) return {};
    // Only realpath's terminator is framing. Trimming a valid trailing space/tab
    // would merge distinct root identities and authorize a retargeted root alias.
    QString path = result.stdoutText;
    if (path.endsWith(QLatin1Char('\n'))) path.chop(1);
    return path.startsWith(QLatin1Char('/')) && !path.contains(QLatin1Char('\n'))
        && !path.contains(QLatin1Char('\r')) && !path.contains(QChar::Null) ? path : QString();
}

inline QString key(const SessionFs &fs, const QString &project, const QString &runtimeProject)
{
    const auto &config = fs.config();
    // Scans receive the runtime cwd, while deletion starts from the catalog's
    // Windows project path. Bind both spellings to the existing runtime-keyed
    // receipt without merging projects or changing the environment scope.
    const QString scopedProject = fs.wsl() ? sessionidentity::windowsPathToWslBase(project) : project;
    const QJsonArray scope{config.wsl, config.distro, config.user, config.home,
                           sessionidentity::normalizeScanPath(scopedProject), runtimeProject};
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
        for (qsizetype index = 0; index < entries.size(); ++index) {
            QJsonObject object = entries.at(index).toObject();
            if (object.value(QStringLiteral("root")).toString() == root
                && object.value(QStringLiteral("canonical")).toString() == canonical) {
                // Only a fresh settings scan can upgrade an old lossy receipt
                // to exact physical provenance in the selected filesystem.
                object.insert(QStringLiteral("canonicalVersion"), kCanonicalVersion);
                entries[index] = object;
                present = true;
                break;
            }
        }
        if (!present && entries.size() < 256)
            entries.append(QJsonObject{{QStringLiteral("root"), root}, {QStringLiteral("canonical"), canonical},
                                       {QStringLiteral("canonicalVersion"), kCanonicalVersion}});
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
        // Old receipts may preserve a junction alias, trim path characters, or
        // replace undecodable bytes with a different real filename. Only a fresh
        // settings scan can restore exact physical provenance for those roots.
        if (object.value(QStringLiteral("canonicalVersion")).toInt() != kCanonicalVersion) continue;
        const QString root = object.value(QStringLiteral("root")).toString();
        const QString canonical = object.value(QStringLiteral("canonical")).toString();
        if (!root.isEmpty() && !canonical.isEmpty() && canonicalRoot(fs, root) == canonical) result.append(root);
    }
    return result;
}
} // namespace sessionroothistory
