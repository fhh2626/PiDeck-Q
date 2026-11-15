#include "SessionIdentity.h"

#include <QRegularExpression>

namespace sessionidentity {
namespace {

QString collapsedSlashes(const QString &path)
{
    QString normalized = path;
    normalized.replace(QLatin1Char('\\'), QLatin1Char('/'));
    while (normalized.endsWith(QLatin1Char('/'))) normalized.chop(1);
    return normalized;
}

bool isUnreserved(QChar character)
{
    const ushort code = character.unicode();
    if (code >= 'A' && code <= 'Z') return true;
    if (code >= 'a' && code <= 'z') return true;
    if (code >= '0' && code <= '9') return true;
    return character == QLatin1Char('-') || character == QLatin1Char('_') || character == QLatin1Char('.')
        || character == QLatin1Char('!') || character == QLatin1Char('~') || character == QLatin1Char('*')
        || character == QLatin1Char('\'') || character == QLatin1Char('(') || character == QLatin1Char(')');
}

} // namespace

bool isValidEnvironment(const QString &environment)
{
    return environment == QLatin1String("native") || environment == QLatin1String("wsl");
}

QString canonicalizeSessionPath(const QString &filePath, const QString &environment)
{
    const QString normalized = collapsedSlashes(filePath);
    // Windows filesystems are case-insensitive; Linux (WSL) is not. Folding WSL
    // paths would merge two genuinely different sessions.
    return environment == QLatin1String("native") ? normalized.toLower() : normalized;
}

bool isAbsoluteSessionPath(const QString &filePath, const QString &environment)
{
    if (environment == QLatin1String("wsl")) return filePath.startsWith(QLatin1Char('/'));
    static const QRegularExpression drive(QStringLiteral("^[A-Za-z]:[\\\\/]"));
    return drive.match(filePath).hasMatch() || filePath.startsWith(QLatin1Char('/'))
        || filePath.startsWith(QLatin1Char('\\'));
}

QString encodeOriginSegment(const QString &value)
{
    QString encoded;
    encoded.reserve(value.size());
    for (const QChar character : value) {
        if (isUnreserved(character)) {
            encoded.append(character);
            continue;
        }
        const QByteArray utf8 = QString(character).toUtf8();
        for (const char byte : utf8) {
            encoded.append(QStringLiteral("%1").arg(static_cast<unsigned char>(byte), 2, 16, QLatin1Char('0')).toUpper());
        }
    }
    return encoded;
}

QString buildSessionOriginKey(const QString &source, const QString &environment, const QString &filePath,
                              const QString &wslDistro, const QString &wslUser,
                              const QString &importedSourceId)
{
    const QString environmentKey = environment == QLatin1String("wsl")
        ? QStringLiteral("wsl:%1:%2")
              .arg(wslDistro.isEmpty() ? QStringLiteral("unknown") : wslDistro,
                   wslUser.isEmpty() ? QStringLiteral("unknown") : wslUser)
        : QStringLiteral("native");
    const QString importedKey =
        importedSourceId.isEmpty() ? QString() : QStringLiteral(":") + encodeOriginSegment(importedSourceId);
    return QStringLiteral("%1:%2:%3%4")
        .arg(source, environmentKey, canonicalizeSessionPath(filePath, environment), importedKey);
}

QString windowsPathToWslBase(const QString &path)
{
    static const QRegularExpression drive(QStringLiteral("^([A-Za-z]):(?:[\\\\/](.*))?$"));
    const QRegularExpressionMatch match = drive.match(path);
    if (match.hasMatch()) {
        QString suffix = match.captured(2);
        static const QRegularExpression slashes(QStringLiteral("[\\\\/]+"));
        suffix.replace(slashes, QStringLiteral("/"));
        return QStringLiteral("/mnt/%1/%2").arg(match.captured(1).toLower(), suffix);
    }
    if (!path.startsWith(QLatin1Char('/'))) return path;
    QString normalized = path;
    static const QRegularExpression slashes(QStringLiteral("[\\\\/]+"));
    normalized.replace(slashes, QStringLiteral("/"));
    return normalized;
}

QString toAbsoluteSessionPath(const QString &filePath, const QString &projectPath, const QString &environment)
{
    if (isAbsoluteSessionPath(filePath, environment)) return filePath;
    const QString base = environment == QLatin1String("wsl") ? windowsPathToWslBase(projectPath) : projectPath;
    QString trimmedBase = base;
    while (trimmedBase.endsWith(QLatin1Char('/')) || trimmedBase.endsWith(QLatin1Char('\\'))) trimmedBase.chop(1);
    QString relative = filePath;
    while (relative.startsWith(QLatin1Char('/')) || relative.startsWith(QLatin1Char('\\'))) relative.remove(0, 1);
    const QString joined = trimmedBase + QLatin1Char('/') + relative;
    // Native keeps the backslash form node:path resolve produces so catalog values
    // match what the scanner writes; WSL keeps POSIX separators.
    return environment == QLatin1String("wsl") ? joined : QString(joined).replace(QLatin1Char('/'), QLatin1Char('\\'));
}

QString normalizeScanPath(const QString &path)
{
    return collapsedSlashes(path).toLower();
}

QString safePathToken(const QString &path)
{
    static const QRegularExpression windowsDrive(QStringLiteral("^([A-Za-z]):/(.+)$"));
    const QString normalized = collapsedSlashes(path);
    const QRegularExpressionMatch match = windowsDrive.match(normalized);
    if (match.hasMatch()) {
        QString tail = match.captured(2);
        tail.replace(QLatin1Char('/'), QLatin1Char('-'));
        return QStringLiteral("--%1--%2--").arg(match.captured(1), tail).toLower();
    }
    QString tail = normalized;
    if (tail.startsWith(QLatin1Char('/'))) tail.remove(0, 1);
    tail.replace(QLatin1Char('/'), QLatin1Char('-'));
    return QStringLiteral("--%1--").arg(tail).toLower();
}

QString decodeSessionDir(const QString &encoded)
{
    QString trimmed = encoded;
    while (trimmed.startsWith(QStringLiteral("--"))) trimmed.remove(0, 2);
    while (trimmed.endsWith(QStringLiteral("--"))) trimmed.chop(2);
    if (trimmed.startsWith(QLatin1String("mnt-"))) {
        return QLatin1Char('/') + QString(trimmed).replace(QLatin1Char('-'), QLatin1Char('/'));
    }
    static const QRegularExpression drive(QStringLiteral("^([A-Za-z])--(.+)$"));
    const QRegularExpressionMatch match = drive.match(trimmed);
    if (match.hasMatch()) {
        QString tail = match.captured(2);
        tail.replace(QLatin1Char('-'), QLatin1Char('/'));
        // Display form mirrors the oracle: `C:/Users/x` -> `C:\Users\x`.
        tail.replace(QLatin1Char('/'), QLatin1Char('\\'));
        return match.captured(1) + QStringLiteral(":\\") + tail;
    }
    return QString(trimmed).replace(QLatin1Char('-'), QLatin1Char('/'));
}

} // namespace sessionidentity
