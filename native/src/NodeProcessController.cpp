#include "NodeProcessController.h"

#include "HostRpcServer.h"

#include <QCoreApplication>
#include <QDir>
#include <QJsonArray>
#include <QJsonDocument>
#include <QProcessEnvironment>

#ifdef Q_OS_WIN
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

#include <limits>

NodeProcessController::NodeProcessController(const NativePaths &paths, HostRpcServer *host,
                                             QObject *parent)
    : QObject(parent),
      m_paths(paths),
      m_host(host)
{
    connect(&m_process, &QProcess::errorOccurred, this, [this](QProcess::ProcessError) {
        if (m_host) {
            m_host->sendEvent(QStringLiteral("application.nodeError"),
                              QJsonObject{{QStringLiteral("message"), m_process.errorString()}});
        }
    });
    connect(&m_process, &QProcess::finished, this, [this](int exitCode, QProcess::ExitStatus status) {
        if (m_host) {
            m_host->sendEvent(QStringLiteral("application.nodeExit"), QJsonObject{
                {QStringLiteral("exitCode"), exitCode},
                {QStringLiteral("normal"), status == QProcess::NormalExit},
            });
        }
    });
}

NodeProcessController::~NodeProcessController()
{
    // aboutToQuit normally calls stop(), but keep the Job Object cleanup paired
    // with the controller lifetime for startup failures and abnormal shutdowns.
    stop();
#ifdef Q_OS_WIN
    closeJobObject();
#endif
}

#ifdef Q_OS_WIN
bool NodeProcessController::createJobObject()
{
    closeJobObject();

    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    if (!job) return false;

    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                                 &limits, sizeof(limits))) {
        CloseHandle(job);
        return false;
    }

    m_jobHandle = job;
    return true;
}

bool NodeProcessController::assignProcessToJob()
{
    if (!m_jobHandle) return false;

    const qint64 processId = m_process.processId();
    if (processId <= 0 || processId > static_cast<qint64>(std::numeric_limits<DWORD>::max())) {
        return false;
    }

    HANDLE process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE,
                                 FALSE, static_cast<DWORD>(processId));
    if (!process) return false;

    const bool assigned = AssignProcessToJobObject(
        reinterpret_cast<HANDLE>(m_jobHandle), process) != FALSE;
    CloseHandle(process);
    return assigned;
}

bool NodeProcessController::terminateJobObject()
{
    if (!m_jobHandle) return false;
    return TerminateJobObject(reinterpret_cast<HANDLE>(m_jobHandle), 1) != FALSE;
}

bool NodeProcessController::fallbackTerminateProcessTree()
{
    if (m_process.state() == QProcess::NotRunning) return true;

    const qint64 processId = m_process.processId();
    if (processId <= 0 || processId > static_cast<qint64>(std::numeric_limits<DWORD>::max())) {
        return false;
    }

    // This fallback is still scoped to the exact sidecar PID. Never use
    // taskkill /IM node.exe: other PiDeck versions and unrelated Node apps may
    // be running at the same time.
    QString systemRoot = qEnvironmentVariable("SystemRoot");
    if (systemRoot.isEmpty()) systemRoot = QStringLiteral("C:\\Windows");
    const QString taskkill = QDir(systemRoot).filePath(QStringLiteral("System32/taskkill.exe"));
    QProcess killer;
    killer.start(taskkill, {
        QStringLiteral("/PID"), QString::number(processId),
        QStringLiteral("/T"), QStringLiteral("/F"),
    });
    if (!killer.waitForStarted(100)) return false;
    if (!killer.waitForFinished(500)) {
        killer.kill();
        killer.waitForFinished(100);
        return false;
    }

    // taskkill returns a non-zero code when the process exited in the small
    // race before it was invoked; that is already a successful cleanup result.
    return killer.exitCode() == 0 || m_process.state() == QProcess::NotRunning;
}

void NodeProcessController::closeJobObject()
{
    if (!m_jobHandle) return;
    CloseHandle(reinterpret_cast<HANDLE>(m_jobHandle));
    m_jobHandle = nullptr;
}
#endif

bool NodeProcessController::start()
{
    if (m_process.state() != QProcess::NotRunning) return true;

#ifdef Q_OS_WIN
    // Create the containment boundary before starting Node. The process handle
    // can only be assigned after QProcess has created the child, so assignment
    // follows waitForStarted(); all later pi/PTY descendants inherit the Job.
    const bool jobReady = createJobObject();
#endif

    QProcessEnvironment environment = QProcessEnvironment::systemEnvironment();
    environment.insert(QStringLiteral("PIDECK_NATIVE_HOST"), QStringLiteral("1"));
    environment.insert(QStringLiteral("PIDECK_HOST_PORT"), QString::number(m_host->port()));
    environment.insert(QStringLiteral("PIDECK_HOST_TOKEN"), m_host->token());
    environment.insert(QStringLiteral("PIDECK_USER_DATA"), m_paths.userDataDir);
    environment.insert(QStringLiteral("PIDECK_APP_PATH"), m_paths.appDir);
    environment.insert(QStringLiteral("PIDECK_RESOURCES_PATH"), m_paths.resourcesDir);
    environment.insert(QStringLiteral("PIDECK_DOWNLOADS_PATH"), m_paths.downloadsDir);
    environment.insert(QStringLiteral("PIDECK_VERSION"), m_paths.version);
    environment.insert(QStringLiteral("PIDECK_PACKAGED"), m_paths.packaged ? QStringLiteral("1") : QStringLiteral("0"));
    environment.insert(QStringLiteral("PIDECK_RENDERER_ROOT"), m_paths.rendererDir);
    environment.insert(QStringLiteral("PIDECK_NATIVE_NODE_ENTRY"), m_paths.nativeNodeEntry);
    environment.insert(QStringLiteral("PIDECK_HOME"), QDir::homePath());
    environment.insert(QStringLiteral("PIDECK_ARGV_JSON"),
                      QString::fromUtf8(QJsonDocument(QJsonArray::fromStringList(QCoreApplication::arguments())).toJson(QJsonDocument::Compact)));
    m_process.setProcessEnvironment(environment);
    m_process.setWorkingDirectory(m_paths.applicationDir);
    m_process.setProgram(m_paths.nodeExecutable);
    m_process.setArguments({m_paths.nativeNodeEntry});
    m_process.start();
    if (!m_process.waitForStarted(5000)) {
        stop();
        return false;
    }

#ifdef Q_OS_WIN
    // A Job Object cannot accept a process before it exists. The sidecar does
    // not start agents during this window, so every later pi/PTY child inherits
    // the Job after this assignment completes.
    if (jobReady && !assignProcessToJob()) {
        // Keep startup usable if Windows policy prevents Job assignment; stop()
        // will use the exact-PID process-tree fallback in that case.
        closeJobObject();
    }
#endif
    return true;
}

void NodeProcessController::stop()
{
    if (m_process.state() == QProcess::NotRunning) {
#ifdef Q_OS_WIN
        // Node may have exited while a child remains. KILL_ON_JOB_CLOSE still
        // cleans that child when the controller releases the Job handle.
        closeJobObject();
#endif
        return;
    }

    // Ask the sidecar to run its own cleanup first, then give it a short
    // graceful window. aboutToQuit runs on the GUI thread, so the bounded
    // fallback avoids blocking the close action for the old multi-second wait.
    if (m_host) m_host->sendEvent(QStringLiteral("application.quit"), QJsonObject{});
    constexpr int gracefulTimeoutMs = 250;
    m_process.terminate();
    if (m_process.waitForFinished(gracefulTimeoutMs)) {
#ifdef Q_OS_WIN
        // Closing the Job also handles descendants that outlived Node itself.
        closeJobObject();
#endif
        return;
    }

#ifdef Q_OS_WIN
    // Prefer the kernel-enforced process group. If Job assignment was not
    // available, terminate only this sidecar PID and its descendants.
    if (!terminateJobObject()) {
        fallbackTerminateProcessTree();
    }
#endif

    // Keep the direct kill as a final guard if QProcess still reports Node as
    // running after the group/tree termination request.
    if (m_process.state() != QProcess::NotRunning) m_process.kill();
    m_process.waitForFinished(100);
#ifdef Q_OS_WIN
    closeJobObject();
#endif
}

bool NodeProcessController::isRunning() const
{
    return m_process.state() != QProcess::NotRunning;
}

QProcess *NodeProcessController::process()
{
    return &m_process;
}
