#include "WslEnvironment.h"

#include "ChannelContext.h"
#include "PiCli.h"
#include "WslExec.h"

#include "ChildEnvironment.h"

#include <QDir>
#include <QProcess>
#include <QTimer>

#include <utility>

namespace wsl {
namespace {

/** Oracle `process.env.PIDECK_WSL_UNC_ROOT`-style seam is read once per process. */
const QString kDefaultUncRoot = QStringLiteral("\\\\wsl.localhost");

QString trimmedUncRoot(const QString &uncRoot)
{
    QString value = uncRoot.isEmpty() ? kDefaultUncRoot : uncRoot.trimmed();
    while (value.endsWith(QLatin1Char('\\')) || value.endsWith(QLatin1Char('/'))) value.chop(1);
    return value.isEmpty() ? kDefaultUncRoot : value;
}

bool isAbsoluteLinuxPath(const QString &path)
{
    return path.startsWith(QLatin1Char('/'));
}

} // namespace

QString defaultUncRoot()
{
    // A fixture points this at a temp directory so the Windows-side managers can be
    // verified without a real distro. The renderer can never influence it (env only).
    const QString override = qEnvironmentVariable("PIDECK_WSL_UNC_ROOT").trimmed();
    return trimmedUncRoot(override);
}

QString normalizeLinuxPath(const QString &path)
{
    QString normalized = path;
    normalized.replace(QLatin1Char('\\'), QLatin1Char('/'));
    // Collapse `//`, `.` and `..` the way node's posix.normalize does for the shapes the
    // oracle actually feeds in (absolute HOME paths). A relative result is never valid.
    QStringList segments;
    for (const QString &segment : normalized.split(QLatin1Char('/'), Qt::SkipEmptyParts)) {
        if (segment == QLatin1String(".")) continue;
        if (segment == QLatin1String("..")) {
            if (!segments.isEmpty()) segments.removeLast();
            continue;
        }
        segments.append(segment);
    }
    const QString joined = segments.join(QLatin1Char('/'));
    if (joined.isEmpty()) return QStringLiteral("/");
    return QStringLiteral("/") + joined;
}

QString linuxPathToWslUnc(const QString &linuxPath, const QString &distro, const QString &uncRoot)
{
    if (!isAbsoluteLinuxPath(linuxPath)) return QString();
    if (distro.isEmpty()) return QString();
    const QString normalized = normalizeLinuxPath(linuxPath);
    QString suffix = normalized == QLatin1String("/") ? QString()
                                                      : normalized.mid(1);
    suffix.replace(QLatin1Char('/'), QLatin1Char('\\'));
    // An explicit root wins; otherwise the process-wide default (which honours the
    // `PIDECK_WSL_UNC_ROOT` fixture seam) applies.
    const QString root = uncRoot.isEmpty() ? defaultUncRoot() : trimmedUncRoot(uncRoot);
#ifndef Q_OS_WIN
    // The explicit test seam may back the distro with a POSIX host directory. Keep
    // the default UNC representation and Windows behavior unchanged, but do not put
    // literal backslash filename bytes into the host paths read by those fixtures.
    if (uncRoot.isEmpty() && !qEnvironmentVariable("PIDECK_WSL_UNC_ROOT").trimmed().isEmpty()
        && root.startsWith(QLatin1Char('/')) && !root.startsWith(QLatin1String("//"))) {
        return QDir(root).filePath(distro + (normalized == QLatin1String("/") ? QString() : normalized));
    }
#endif
    return suffix.isEmpty() ? root + QLatin1Char('\\') + distro
                            : root + QLatin1Char('\\') + distro + QLatin1Char('\\') + suffix;
}

QString fallbackLinuxHome(const QString &user)
{
    return user == QLatin1String("root") ? QStringLiteral("/root")
                                         : QStringLiteral("/home/") + user;
}

CreateResult createEnvironment(const QString &distro, const QString &user, const QString &linuxHome,
                               const QString &uncRoot)
{
    CreateResult result;
    if (linuxHome.isEmpty() || !isAbsoluteLinuxPath(linuxHome)) {
        result.error = QStringLiteral("INVALID_WSL_PATH: WSL HOME must be absolute, received \"%1\".")
                           .arg(linuxHome);
        return result;
    }
    if (distro.isEmpty()) {
        result.error = QStringLiteral("INVALID_WSL_PATH: the WSL distribution is required.");
        return result;
    }
    result.environment.distro = distro;
    result.environment.user = user;
    result.environment.linuxHome = normalizeLinuxPath(linuxHome);
    result.environment.windowsHome =
        linuxPathToWslUnc(result.environment.linuxHome, distro, uncRoot);
    result.ok = !result.environment.windowsHome.isEmpty();
    if (!result.ok) result.error = QStringLiteral("INVALID_WSL_PATH: cannot map the WSL HOME.");
    return result;
}

Resolver::Resolver(const ChannelServices &services, ResolveOptions options, QObject *parent)
    : QObject(parent), m_executable(executable(services)), m_options(std::move(options))
{
    if (m_options.timeoutMs <= 0) m_options.timeoutMs = 8'000;
}

Resolver::~Resolver()
{
    cancel();
}

void Resolver::resolve(const QString &distro, const QString &user,
                       std::function<void(const Environment &)> done)
{
    if (m_process) return;
    m_done = std::move(done);

    // `printenv HOME` is the only command that needs an async child here: the blocking
    // wsl::run helper is shared with the WSL channels, but an 8 s cold-distro probe on
    // the main thread would freeze the heartbeat and every RPC.
    auto *process = new QProcess(this);
    const QStringList arguments{QStringLiteral("-d"), distro, QStringLiteral("-u"), user,
                                QStringLiteral("--exec"), QStringLiteral("printenv"),
                                QStringLiteral("HOME")};
    const pilaunch::Cli cli = picli::buildCli(m_executable, arguments, childenv::sanitized());
    process->setProcessEnvironment(cli.environment);
    process->setProcessChannelMode(QProcess::SeparateChannels);
#ifdef Q_OS_WIN
    if (!cli.nativeArguments.isEmpty()) {
        process->setNativeArguments(cli.nativeArguments);
        process->start(cli.program);
    } else
#endif
    {
        process->start(cli.program, cli.arguments);
    }
    m_process = process;

    connect(process, QOverload<int, QProcess::ExitStatus>::of(&QProcess::finished), this,
            [this, process, distro, user](int, QProcess::ExitStatus status) {
                if (m_process != process) return;
                const QString output = QString::fromUtf8(process->readAllStandardOutput());
                const QString errors = QString::fromUtf8(process->readAllStandardError()).trimmed();
                settle(distro, user,
                       status == QProcess::NormalExit && process->exitCode() == 0 ? output
                                                                                  : QString(),
                       errors);
            });
    connect(process, &QProcess::errorOccurred, this, [this, process, distro, user](QProcess::ProcessError error) {
        if (m_process != process) return;
        if (error != QProcess::FailedToStart) return;
        settle(distro, user, QString(), process->errorString());
    });

    if (m_options.timeoutMs > 0) {
        auto *timeout = new QTimer(this);
        timeout->setSingleShot(true);
        timeout->setInterval(m_options.timeoutMs);
        connect(timeout, &QTimer::timeout, this, [this, process, distro, user] {
            if (m_process != process) return;
            settle(distro, user, QString(), QStringLiteral("wsl printenv HOME timed out"));
        });
        timeout->start();
        m_timeout = timeout;
    }
}

void Resolver::settle(const QString &distro, const QString &user, const QString &stdoutText,
                      const QString &errorText)
{
    if (!m_process) return;
    QProcess *process = m_process;
    m_process = nullptr;
    if (m_timeout) {
        m_timeout->stop();
        m_timeout->deleteLater();
        m_timeout = nullptr;
    }
    // Disconnect before tearing the process down: `settle` may be entered from the
    // process's own finished/error signal, and the owner must not see a second settle.
    process->disconnect(this);
    if (process->state() != QProcess::NotRunning) {
        process->kill();
        process->waitForFinished(1'000);
    }
    process->deleteLater();

    const QString candidate = stdoutText.trimmed();
    QString linuxHome;
    QString detail;
    if (isAbsoluteLinuxPath(candidate)) {
        linuxHome = candidate;
    } else {
        // The oracle keeps the user running with the documented compatibility fallback
        // instead of failing startup: a broken printenv must not hide every skill,
        // prompt and extension behind an error.
        linuxHome = fallbackLinuxHome(user);
        detail = errorText.isEmpty()
            ? (candidate.isEmpty() ? QStringLiteral("empty output") : candidate)
            : errorText;
        if (m_options.warn) {
            m_options.warn(QStringLiteral("Failed to resolve WSL HOME; using the compatibility fallback."),
                           QJsonObject{{QStringLiteral("distro"), distro},
                                       {QStringLiteral("user"), user},
                                       {QStringLiteral("fallback"), linuxHome},
                                       {QStringLiteral("error"), detail}});
        }
    }

    const CreateResult created =
        createEnvironment(distro, user, linuxHome, m_options.uncRoot);
    if (!created.ok) {
        // An unparsable HOME (a relative fallback is impossible, but a bad distro name is
        // not) degrades to "no WSL environment" so the caller keeps the local directories.
        if (m_options.warn) {
            m_options.warn(QStringLiteral("Failed to build the WSL environment."),
                           QJsonObject{{QStringLiteral("distro"), distro},
                                       {QStringLiteral("user"), user},
                                       {QStringLiteral("error"), created.error}});
        }
        finish(Environment{});
        return;
    }
    finish(created.environment);
}

void Resolver::finish(const Environment &environment)
{
    auto done = m_done;
    m_done = nullptr;
    if (done) done(environment);
}

void Resolver::cancel()
{
    if (m_timeout) {
        m_timeout->stop();
        m_timeout->deleteLater();
        m_timeout = nullptr;
    }
    m_done = nullptr;
    if (!m_process) return;
    QProcess *process = m_process;
    m_process = nullptr;
    process->disconnect(this);
    if (process->state() != QProcess::NotRunning) {
        process->kill();
        process->waitForFinished(1'000);
    }
    process->deleteLater();
}

} // namespace wsl
