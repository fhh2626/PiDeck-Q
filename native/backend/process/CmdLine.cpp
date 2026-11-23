#include "CmdLine.h"

#include <QRegularExpression>

namespace cmdline {
namespace {

/**
 * The oracle's character class, kept byte-for-byte (`/[\s&()\[\]{}^=;!'+,`~|<>]/`).
 *
 * Do not "improve" it here: parity is decided against `PiLocator.ts`, and a narrower
 * or wider set changes which command lines reach cmd.exe.
 */
const QRegularExpression &quoteTrigger()
{
    static const QRegularExpression pattern(
        QStringLiteral("[\\s&()\\[\\]{}^=;!'+,`~|<>]"));
    return pattern;
}

} // namespace

bool needsQuoting(const QString &value)
{
    return quoteTrigger().match(value).hasMatch();
}

QString quoteArgument(const QString &value)
{
    if (!needsQuoting(value)) return value;
    // cmd.exe escapes an embedded quote by doubling it, so `say "hi"` stays one argument.
    QString quoted = value;
    quoted.replace(QLatin1Char('"'), QStringLiteral("\"\""));
    return QStringLiteral("\"%1\"").arg(quoted);
}

QString commandLine(const QString &command, const QStringList &arguments)
{
    QStringList parts;
    parts.reserve(arguments.size() + 1);
    parts.append(quoteArgument(command));
    for (const QString &argument : arguments) parts.append(quoteArgument(argument));
    const QString inner = parts.join(QLatin1Char(' '));
    return needsQuoting(command) ? QStringLiteral("\"%1\"").arg(inner) : inner;
}

QString nativeArguments(const QString &command, const QStringList &arguments)
{
    return QStringLiteral("/d /s /c %1").arg(commandLine(command, arguments));
}

QString startArgument(const QString &value)
{
    QString escaped = value;
    escaped.replace(QLatin1Char('"'), QStringLiteral("\\\""));
    return QLatin1Char('"') + escaped + QLatin1Char('"');
}

} // namespace cmdline
