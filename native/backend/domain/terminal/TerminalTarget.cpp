#include "TerminalTarget.h"

#include <QJsonValue>
#include <QRegularExpression>

namespace terminal {
namespace {

/**
 * Split `\\wsl$\<distro>\<linux path>` (or `\\wsl.localhost\...`) into a stable
 * prefix and the Linux path. Mirrors `parseWslTerminalUnc`.
 */
bool parseWslUnc(const QString &cwd, QString *prefix, QString *linuxPath)
{
    static const QRegularExpression pattern(
        QStringLiteral("^[\\\\/]{2}(wsl\\$|wsl\\.localhost)[\\\\/]([^\\\\/]+)[\\\\/](.*)$"),
        QRegularExpression::CaseInsensitiveOption);
    const QRegularExpressionMatch match = pattern.match(cwd);
    if (!match.hasMatch()) return false;
    QString path = match.captured(3);
    path.replace(QRegularExpression(QStringLiteral("[\\\\/]+")), QStringLiteral("/"));
    path.replace(QRegularExpression(QStringLiteral("/+$")), QString());
    *linuxPath = QLatin1Char('/') + path;
    if (*linuxPath == QLatin1String("/")) *linuxPath = QStringLiteral("/");
    *prefix = QStringLiteral("//%1/%2").arg(match.captured(1).toLower(), match.captured(2).toLower());
    return true;
}

bool isWindowsLocalPath(const QString &cwd, bool isWindows)
{
    static const QRegularExpression driveWithSeparator(QStringLiteral("^[A-Za-z]:[\\\\/]"));
    static const QRegularExpression driveOnly(QStringLiteral("^[A-Za-z]:$"));
    static const QRegularExpression uncPrefix(QStringLiteral("^[\\\\/]{2}"));
    if (driveWithSeparator.match(cwd).hasMatch() || driveOnly.match(cwd).hasMatch()) return true;
    if (uncPrefix.match(cwd).hasMatch()) return true;
    return isWindows && !cwd.startsWith(QLatin1Char('/'));
}

QString normalizeWindowsLocalPath(const QString &cwd)
{
    QString normalized = cwd;
    normalized.replace(QRegularExpression(QStringLiteral("[\\\\/]+")), QStringLiteral("/"));
    static const QRegularExpression driveRoot(QStringLiteral("^[A-Za-z]:/?$"));
    if (driveRoot.match(normalized).hasMatch()) {
        return normalized.left(2).toLower() + QLatin1Char('/');
    }
    if (normalized == QLatin1String("//")) return normalized;
    normalized.replace(QRegularExpression(QStringLiteral("/+$")), QString());
    return normalized.toLower();
}

} // namespace

bool platformIsWindows()
{
#ifdef Q_OS_WIN
    return true;
#else
    return false;
#endif
}

QString normalizeCwd(const QString &cwd, bool isWindows)
{
    QString prefix;
    QString linuxPath;
    if (parseWslUnc(cwd, &prefix, &linuxPath)) return prefix + linuxPath;
    if (isWindowsLocalPath(cwd, isWindows)) return normalizeWindowsLocalPath(cwd);
    QString normalized = cwd;
    normalized.replace(QRegularExpression(QStringLiteral("/+")), QStringLiteral("/"));
    if (normalized == QLatin1String("/")) return normalized;
    normalized.replace(QRegularExpression(QStringLiteral("/+$")), QString());
    return normalized.isEmpty() ? QStringLiteral("/") : normalized;
}

Target targetFromJson(const QJsonObject &value)
{
    Target target;
    const QString kind = value.value(QStringLiteral("kind")).toString();
    if (kind == QLatin1String("project")) {
        target.kind = Target::Kind::Project;
        target.projectId = value.value(QStringLiteral("projectId")).toString();
        target.cwd = value.value(QStringLiteral("cwd")).toString();
        return target;
    }
    // Everything else is an agent target. The coordinator validates the triple, so an
    // unknown kind cannot silently become a project terminal.
    target.kind = Target::Kind::Agent;
    target.sessionId = value.value(QStringLiteral("sessionId")).toString();
    target.agentId = value.value(QStringLiteral("agentId")).toString();
    target.runtimeGeneration = value.value(QStringLiteral("runtimeGeneration")).toInt();
    return target;
}

QString ownerKeyFor(const Target &target, const QString &resolvedCwd)
{
    if (target.kind == Target::Kind::Agent) return QStringLiteral("agent:") + target.agentId;
    return QStringLiteral("cwd:") + normalizeCwd(resolvedCwd, platformIsWindows());
}

QJsonObject Target::toJson() const
{
    if (kind == Target::Kind::Project) {
        return QJsonObject{
            {QStringLiteral("kind"), QStringLiteral("project")},
            {QStringLiteral("projectId"), projectId},
            {QStringLiteral("cwd"), cwd},
        };
    }
    return QJsonObject{
        {QStringLiteral("kind"), QStringLiteral("agent")},
        {QStringLiteral("sessionId"), sessionId},
        {QStringLiteral("agentId"), agentId},
        {QStringLiteral("runtimeGeneration"), runtimeGeneration},
    };
}

} // namespace terminal
