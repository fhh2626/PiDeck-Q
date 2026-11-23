#include "MemoryMonitor.h"

#include <QCoreApplication>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QJsonValue>
#include <QList>

#if defined(Q_OS_WIN)
#include <windows.h>

#include <psapi.h>
#elif defined(Q_OS_LINUX)
#include <unistd.h>
#else
#include <sys/resource.h>
#endif

namespace memorymonitor {
namespace {

constexpr qint64 kBytesPerKB = 1024;

QString numberCell(const QJsonObject &diagnostics, const char *key)
{
    // The renderer sends `undefined` by omitting the key and `null` for "not probed";
    // neither is a measurement, so both become an empty cell.
    const QJsonValue value = diagnostics.value(QLatin1String(key));
    if (!value.isDouble()) return QString();
    return QString::number(qint64(value.toDouble()));
}

QString cell(bool available, qint64 value)
{
    return available ? QString::number(value) : QString();
}

/** CSV quoting matches toProfileCsvRow: only commas and quotes need escaping. */
QString escapeCsv(const QString &value)
{
    if (!value.contains(QLatin1Char(',')) && !value.contains(QLatin1Char('"'))) return value;
    QString escaped = value;
    escaped.replace(QLatin1Char('"'), QLatin1String("\"\""));
    return QLatin1Char('"') + escaped + QLatin1Char('"');
}

} // namespace

const char *const kCsvHeader =
    "ts,type,pid,label,rssKB,privateKB,sharedKB,peakRssKB,heapUsedKB,jsHeapKB,totalJSHeapKB,domNodes,imgCount,"
    "imgPixels,canvasPixels,workerCount,workerJSHeapKB,streaming";

ProcessMemory readProcessMemory()
{
    ProcessMemory memory;
#if defined(Q_OS_WIN)
    PROCESS_MEMORY_COUNTERS_EX counters{};
    counters.cb = sizeof(counters);
    if (!K32GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS *>(&counters),
                                 sizeof(counters))) {
        return memory;
    }
    memory.available = true;
    memory.rssKB = qint64(counters.WorkingSetSize) / kBytesPerKB;
    memory.hasPrivate = true;
    memory.privateKB = qint64(counters.PrivateUsage) / kBytesPerKB;
    memory.hasPeakRss = true;
    memory.peakRssKB = qint64(counters.PeakWorkingSetSize) / kBytesPerKB;
#elif defined(Q_OS_LINUX)
    // /proc/self/statm field 2 is the resident set in pages; POSIX has no portable
    // private/peak counter, so those columns stay empty instead of being estimated.
    QFile statm(QStringLiteral("/proc/self/statm"));
    if (!statm.open(QIODevice::ReadOnly)) return memory;
    const QList<QByteArray> fields = statm.readAll().simplified().split(' ');
    if (fields.size() < 2) return memory;
    const qint64 pages = fields.at(1).toLongLong();
    const qint64 pageSize = qint64(sysconf(_SC_PAGESIZE));
    if (pages <= 0 || pageSize <= 0) return memory;
    memory.available = true;
    memory.rssKB = pages * pageSize / kBytesPerKB;
#else
    struct rusage usage {};
    if (getrusage(RUSAGE_SELF, &usage) != 0) return memory;
    // macOS/BSD report ru_maxrss in bytes; Linux would be KB but is handled above. Only
    // the peak column can be filled honestly here, so RSS stays empty rather than
    // reporting a peak as a current value.
    memory.hasPeakRss = true;
    memory.peakRssKB = qint64(usage.ru_maxrss) / kBytesPerKB;
#endif
    return memory;
}

QString csvRow(qint64 ts, const QString &type, qint64 pid, const QString &label, const ProcessMemory &memory,
               const QJsonObject &renderer, bool streaming)
{
    const QStringList cells{
        QString::number(ts),
        escapeCsv(type),
        QString::number(pid),
        escapeCsv(label),
        cell(memory.available, memory.rssKB),
        cell(memory.hasPrivate, memory.privateKB),
        QString(), // sharedKB: no portable source; never estimated
        cell(memory.hasPeakRss, memory.peakRssKB),
        QString(), // heapUsedKB: only a V8 runtime reports a JS heap
        numberCell(renderer, "jsHeapKB"),
        numberCell(renderer, "totalJSHeapKB"),
        numberCell(renderer, "domNodes"),
        numberCell(renderer, "imgCount"),
        numberCell(renderer, "imgPixels"),
        numberCell(renderer, "canvasPixels"),
        numberCell(renderer, "workerCount"),
        numberCell(renderer, "workerJSHeapKB"),
        streaming ? QStringLiteral("1") : QStringLiteral("0"),
    };
    return cells.join(QLatin1Char(','));
}

Monitor::Monitor(Deps deps, QObject *parent) : QObject(parent), m_deps(std::move(deps))
{
    // windows.h defines the `max` macro, so the Qt helper is used instead of std::max.
    m_timer.setInterval(qMax(1, m_deps.intervalMs));
    connect(&m_timer, &QTimer::timeout, this, [this] { sample(); });
}

QString Monitor::start()
{
    const QString directory = QDir(m_deps.userDataDir).filePath(QStringLiteral("memory-profile"));
    if (m_deps.userDataDir.isEmpty() || !QDir().mkpath(directory)) return QString();
    // The epoch-ms suffix keeps concurrent runs from appending into one file, matching the
    // oracle's naming so the analysis script finds either backend unchanged.
    m_filePath = QDir(directory).filePath(
        QStringLiteral("profile-%1.csv").arg(QDateTime::currentMSecsSinceEpoch()));
    QFile file(m_filePath);
    if (!file.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        m_filePath.clear();
        return QString();
    }
    file.write(QByteArray(kCsvHeader) + '\n');
    file.close();
    sample();
    m_timer.start();
    return m_filePath;
}

void Monitor::stop()
{
    m_timer.stop();
}

void Monitor::updateRendererDiagnostics(const QJsonObject &diagnostics)
{
    for (auto iterator = diagnostics.constBegin(); iterator != diagnostics.constEnd(); ++iterator) {
        m_latestRenderer.insert(iterator.key(), iterator.value());
    }
}

void Monitor::sample()
{
    if (m_filePath.isEmpty()) return;
    const bool streaming = m_deps.isStreaming ? m_deps.isStreaming() : false;
    const QString row = csvRow(QDateTime::currentMSecsSinceEpoch(), QStringLiteral("CppBackend"),
                               qint64(QCoreApplication::applicationPid()), QStringLiteral("pideck-backend"),
                               readProcessMemory(), m_latestRenderer, streaming);
    QFile file(m_filePath);
    if (!file.open(QIODevice::Append)) return; // profiling must never break the backend
    file.write(row.toUtf8() + '\n');
    file.close();
}

} // namespace memorymonitor
