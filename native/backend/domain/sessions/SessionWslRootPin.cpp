#include "SessionWslRootPin.h"
#include "../ChannelRegistry.h"
#include "../extensions/PiCli.h"
#include "../process/ChildEnvironment.h"
#include "../wsl/WslExec.h"

#include <QDeadlineTimer>
#include <QRegularExpression>
#ifdef Q_OS_WIN
#include <windows.h>
#endif

namespace sessiondelete {
namespace {
/** A dedicated stdio lifetime, not a detached task or a filesystem lease file. */
const QString &pinScript()
{
    static const QString script = QStringLiteral(R"PIDECK_PIN(
# pideck-root-pin-v1
set -efu
root=$1
cd -P -- "$root" || exit 1
[ "$(pwd -P)" = "$root" ] || exit 1
exec 3<. || exit 1
record=$(cat "/proc/$$/stat") || exit 1
record=${record##*) }
set -- $record
start=${20}
identity=$(stat -Lc '%d:%i' -- /proc/self/fd/3) || exit 1
printf 'pideck-root-v1\t%s\t%s\t%s\n' "$$" "$start" "$identity"
# EOF from the owner is also a release, including planning failure and shutdown.
IFS= read -r release || :
)PIDECK_PIN").replace(QStringLiteral("\r\n"), QStringLiteral("\n"));
    return script;
}
}

WslRootPin::WslRootPin(const SessionFs::Config &config, const QString &root)
{
    try {
        const QString program = wsl::executableFor(config.executable);
        if (program.isEmpty()) throw ChannelError(QStringLiteral("Unable to pin session deletion root"));
        const QStringList arguments{QStringLiteral("-d"), config.distro, QStringLiteral("-u"), config.user,
            QStringLiteral("sh"), QStringLiteral("-c"), pinScript(), QStringLiteral("--"), root};
        const auto cli = picli::buildCli(program, arguments, childenv::sanitized());
        m_process.setProcessEnvironment(cli.environment);
#ifdef Q_OS_WIN
        m_process.setCreateProcessArgumentsModifier([](QProcess::CreateProcessArguments *args) { args->flags |= CREATE_NO_WINDOW; });
        if (!cli.nativeArguments.isEmpty()) {
            m_process.setNativeArguments(cli.nativeArguments);
            m_process.start(cli.program);
        } else
#endif
        { m_process.start(cli.program, cli.arguments); }
        if (!m_process.waitForStarted(10'000))
            throw ChannelError(QStringLiteral("Unable to pin session deletion root"));
        QDeadlineTimer deadline(10'000);
        while (!m_process.canReadLine()) {
            if (m_process.bytesAvailable() > 1024 || deadline.hasExpired()
                || !m_process.waitForReadyRead(int(deadline.remainingTime())))
                throw ChannelError(QStringLiteral("Unable to pin session deletion root"));
        }
        const auto parts = QString::fromUtf8(m_process.readLine(1025)).trimmed().split('\t');
        const QRegularExpression number(QStringLiteral("^[0-9]+$"));
        const QRegularExpression identity(QStringLiteral("^[0-9]+:[0-9]+$"));
        if (parts.size() != 4 || parts.at(0) != QStringLiteral("pideck-root-v1")
            || !number.match(parts.at(1)).hasMatch() || parts.at(1) == QStringLiteral("0")
            || !number.match(parts.at(2)).hasMatch() || !identity.match(parts.at(3)).hasMatch())
            throw ChannelError(QStringLiteral("Unable to pin session deletion root"));
        m_pid = parts.at(1); m_startTime = parts.at(2); m_identity = parts.at(3);
    } catch (...) {
        stop();
        throw;
    }
}

WslRootPin::~WslRootPin() { stop(); }

/** Release stdin first, so the Linux holder closes its descriptor without a detached survivor. */
void WslRootPin::stop()
{
    if (m_process.state() == QProcess::NotRunning) return;
    m_process.closeWriteChannel();
    if (!m_process.waitForFinished(2'000)) {
        m_process.kill();
        m_process.waitForFinished(2'000);
    }
}
} // namespace sessiondelete
