#include "ScanRoots.h"

#include "SessionFiles.h"
#include "SessionIdentity.h"

#include <QDir>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>

namespace scanroots {
namespace {

QString readSessionDirSetting(const QString &settingsPath)
{
    QString raw;
    QString error;
    if (!sessionfiles::readText(settingsPath, &raw, &error)) return QString();
    const QJsonDocument document = QJsonDocument::fromJson(raw.toUtf8());
    if (!document.isObject()) return QString();
    const QJsonValue value = document.object().value(QStringLiteral("sessionDir"));
    if (!value.isString()) return QString();
    const QString trimmed = value.toString().trimmed();
    return trimmed;
}

QString resolveSessionDirPath(const SessionFs &fs, const QString &sessionDir, const QString &projectCwd)
{
    const QString expanded = expandHomePrefix(sessionDir, fs.home());
    if (fs.wsl()) {
        QString normalized = expanded;
        normalized.replace(QLatin1Char('\\'), QLatin1Char('/'));
        if (normalized.startsWith(QLatin1Char('/'))) return normalized;
        static const QRegularExpression drive(QStringLiteral("^[A-Za-z]:[\\\\/]"));
        if (drive.match(expanded).hasMatch()) {
            return sessionidentity::windowsPathToWslBase(expanded);
        }
        QString base = projectCwd;
        base.replace(QLatin1Char('\\'), QLatin1Char('/'));
        while (base.endsWith(QLatin1Char('/'))) base.chop(1);
        return base + QLatin1Char('/') + normalized;
    }
    static const QRegularExpression drive(QStringLiteral("^[A-Za-z]:[\\\\/]"));
    if (QFileInfo(expanded).isAbsolute() || drive.match(expanded).hasMatch()) {
        return QDir::cleanPath(expanded);
    }
    return QDir::cleanPath(QDir(projectCwd).filePath(expanded));
}

} // namespace

QString defaultSessionsRoot(const SessionFs &fs, const QString &hostHome)
{
    if (fs.wsl()) {
        QString home = fs.home();
        while (home.endsWith(QLatin1Char('/'))) home.chop(1);
        return home + QStringLiteral("/.pi/agent/sessions");
    }
    return QDir(hostHome).filePath(QStringLiteral(".pi/agent/sessions"));
}

QString expandHomePrefix(const QString &input, const QString &home)
{
    if (input == QLatin1String("~")) return home;
    if (input.startsWith(QLatin1String("~/")) || input.startsWith(QLatin1String("~\\"))) {
        const QString tail = input.mid(2);
        QString normalized = tail;
        normalized.replace(QLatin1Char('\\'), QLatin1Char('/'));
        return home + QLatin1Char('/') + normalized;
    }
    return input;
}

QString toHostReadablePath(const QString &path)
{
    static const QRegularExpression mount(QStringLiteral("^/mnt/([a-zA-Z])/(.*)$"));
    QString normalized = path;
    normalized.replace(QLatin1Char('\\'), QLatin1Char('/'));
    const QRegularExpressionMatch match = mount.match(normalized);
    if (!match.hasMatch()) return path;
    QString tail = match.captured(2);
    tail.replace(QLatin1Char('/'), QLatin1Char('\\'));
    return match.captured(1).toUpper() + QStringLiteral(":\\") + tail;
}

QStringList resolve(const SessionFs &fs, const QString &hostHome, const QString &projectPath,
                    const QString &runtimeProjectPath, const QString &baseRoot)
{
    //  is the configured session directory (PIDECK_SESSIONS_DIR / the desktop
    // setting); it replaces the default root so a custom layout is scanned instead of
    // the user profile.
    QStringList roots{baseRoot.isEmpty() ? defaultSessionsRoot(fs, hostHome) : baseRoot};
    if (projectPath.isEmpty() || runtimeProjectPath.isEmpty()) return roots;

    // Project settings win over the global file, matching pi's own precedence.
    const QString projectSettings =
        QDir(toHostReadablePath(projectPath)).filePath(QStringLiteral(".pi/settings.json"));
    QString configured = readSessionDirSetting(projectSettings);
    if (configured.isEmpty()) {
        configured = readSessionDirSetting(QDir(hostHome).filePath(QStringLiteral(".pi/agent/settings.json")));
    }
    if (configured.isEmpty()) return roots;

    const QString resolved = resolveSessionDirPath(fs, configured, runtimeProjectPath);
    const QString normalizedResolved = sessionidentity::normalizeScanPath(resolved);
    for (const QString &root : roots) {
        if (sessionidentity::normalizeScanPath(root) == normalizedResolved) return roots;
    }
    if (fs.isDirectory(resolved)) roots.append(resolved);
    return roots;
}

} // namespace scanroots
