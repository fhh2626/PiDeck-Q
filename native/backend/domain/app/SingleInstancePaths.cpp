#include "app/SingleInstancePaths.h"

#include <QCryptographicHash>
#include <QDir>

namespace singleinstance {

QString sanitizeVersion(const QString &version)
{
    QString sanitized;
    sanitized.reserve(version.size());
    for (const QChar character : version) {
        // Only `[\w.-]` survives, exactly like the oracle's replace. Anything else would
        // make the endpoint name depend on characters a shell/pipe API treats specially.
        if (character.isLetterOrNumber() || character == QLatin1Char('_') || character == QLatin1Char('.')
            || character == QLatin1Char('-')) {
            sanitized.append(character);
        } else {
            sanitized.append(QLatin1Char('_'));
        }
    }
    return sanitized.isEmpty() ? QStringLiteral("unknown") : sanitized;
}

QString endpointDigest(const QString &userDataDir, const QString &version)
{
    const QByteArray material = (userDataDir + QChar(0) + version).toUtf8();
    return QString::fromLatin1(QCryptographicHash::hash(material, QCryptographicHash::Sha256).toHex().left(32));
}

QString locksDirectory(const QString &userDataDir)
{
    return QDir(userDataDir).filePath(QStringLiteral("instance-locks"));
}

QString lockPathFor(const QString &userDataDir, const QString &version)
{
    return QDir(locksDirectory(userDataDir)).filePath(sanitizeVersion(version) + QStringLiteral(".lock"));
}

QString claimPathFor(const QString &userDataDir, const QString &version)
{
    return QDir(locksDirectory(userDataDir)).filePath(sanitizeVersion(version) + QStringLiteral(".claim"));
}

QString endpointFor(const QString &userDataDir, const QString &version)
{
    const QString digest = endpointDigest(userDataDir, version);
#ifdef Q_OS_WIN
    return QStringLiteral("\\\\.\\pipe\\pideck-") + digest;
#else
    return QDir(locksDirectory(userDataDir)).filePath(QStringLiteral("pideck-") + digest
                                                      + QStringLiteral(".sock"));
#endif
}

QString endpointName(const QString &endpoint)
{
#ifdef Q_OS_WIN
    static const QString prefix = QStringLiteral("\\\\.\\pipe\\");
    return endpoint.startsWith(prefix) ? endpoint.mid(prefix.size()) : endpoint;
#else
    return endpoint;
#endif
}

} // namespace singleinstance
