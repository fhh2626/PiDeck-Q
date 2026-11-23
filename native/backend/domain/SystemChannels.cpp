#include "ChannelContext.h"

#include "runtime/RuntimeCoordinator.h"

#include <QDateTime>
#include <QFile>
#include <QJsonArray>

#ifdef Q_OS_WIN
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <psapi.h>
#endif

namespace {

/**
 * Resident memory of one process in bytes.
 *
 * Windows reports the same metric the oracle samples with PowerShell
 * (`PrivateMemorySize64` → `PROCESS_MEMORY_COUNTERS_EX::PrivateUsage`) so the monitor
 * matches Task Manager instead of double counting shared pages. POSIX uses RSS, which
 * is what `ps -o rss` reports.
 */
bool sampleMemoryBytes(qint64 pid, qint64 *bytes)
{
#ifdef Q_OS_WIN
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, static_cast<DWORD>(pid));
    if (!process) return false;
    PROCESS_MEMORY_COUNTERS_EX counters{};
    const BOOL ok = GetProcessMemoryInfo(process, reinterpret_cast<PROCESS_MEMORY_COUNTERS *>(&counters),
                                         sizeof(counters));
    CloseHandle(process);
    if (!ok) return false;
    *bytes = static_cast<qint64>(counters.PrivateUsage);
    return true;
#else
    const QString path = QStringLiteral("/proc/%1/statm").arg(pid);
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) return false;
    const QList<QByteArray> fields = file.readAll().simplified().split(' ');
    if (fields.size() < 2) return false;
    bool ok = false;
    const qint64 pages = fields.at(1).toLongLong(&ok);
    if (!ok) return false;
    *bytes = pages * 4096;
    return true;
#endif
}

} // namespace

/** `system:*` — process monitor and the stop action behind it. */
void registerSystemChannels(ChannelRegistry &registry, ChannelServices &services)
{
    registry.add(QStringLiteral("system:process-metrics"), [&services](const QJsonArray &) {
        QJsonArray agents;
        qint64 total = 0;
        if (services.runtimeCoordinator) {
            for (const QJsonValue &value : services.runtimeCoordinator->agentProcesses()) {
                QJsonObject agent = value.toObject();
                const qint64 pid = static_cast<qint64>(agent.value(QStringLiteral("pid")).toDouble());
                qint64 memory = 0;
                // A process that exited between enumeration and sampling is not an
                // error: the row stays visible without a memory value.
                if (pid > 0 && sampleMemoryBytes(pid, &memory)) {
                    agent.insert(QStringLiteral("memoryBytes"), static_cast<double>(memory));
                    total += memory;
                }
                agents.append(agent);
            }
        }
        return QJsonObject{
            {QStringLiteral("agents"), agents},
            {QStringLiteral("totalAgentBytes"), static_cast<double>(total)},
            {QStringLiteral("sampledAt"), static_cast<double>(QDateTime::currentMSecsSinceEpoch())},
        };
    });

    registry.addAsync(QStringLiteral("system:stop-agent"), [&services](const QJsonArray &args,
                                                                     ChannelResponder responder) {
        const QString agentId = channels::stringArg(args, 0);
        // Renderer data is untrusted: an empty id must never address the whole runtime.
        if (agentId.isEmpty()) {
            responder.reject(QStringLiteral("invalid agentId"));
            return;
        }
        if (!services.runtimeCoordinator) {
            responder.reject(QStringLiteral("Session runtime is not available"));
            return;
        }
        // The monitor stops through the full session-stop path so the renderer's runtime
        // badge is cleared by the same detach event as a normal stop.
        services.runtimeCoordinator->stopAgent(agentId, [responder](QJsonObject result) mutable {
            if (result.value(QStringLiteral("ok")).toBool(false)) {
                responder.resolve(QJsonValue(QJsonValue::Null));
                return;
            }
            const QJsonObject error = result.value(QStringLiteral("error")).toObject();
            const QString details = error.value(QStringLiteral("debugDetails")).toString();
            responder.reject(details.isEmpty() ? QStringLiteral("failed to stop agent") : details);
        });
    });
}
