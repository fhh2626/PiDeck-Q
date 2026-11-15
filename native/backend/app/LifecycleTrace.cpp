#include "LifecycleTrace.h"

#include <QByteArray>
#include <QElapsedTimer>
#include <QMutex>
#include <QMutexLocker>
#include <QThread>

#include <cstdio>

namespace lifetrace {
namespace {

/**
 * Trace file owner.
 *
 * Heap-allocated on purpose: marks may arrive from the domain worker thread and from
 * late teardown steps, so the sink must outlive static destruction. Nothing else touches
 * it once the process exits.
 */
struct TraceSink {
    TraceSink()
    {
        const QByteArray path = qgetenv("PIDECK_LIFECYCLE_TRACE");
        if (path.isEmpty()) return;
        file = std::fopen(path.constData(), "ab");
        if (!file) return;
        clock.start();
        active = true;
    }

    bool active = false;
    FILE *file = nullptr;
    QElapsedTimer clock;
    QMutex mutex;
};

TraceSink &sink()
{
    // Function-local static: the guard check is the only cost when tracing is off.
    static TraceSink *instance = new TraceSink();
    return *instance;
}

} // namespace

bool enabled()
{
    return sink().active;
}

void mark(const char *phase)
{
    TraceSink &target = sink();
    if (!target.active || !phase) return;
    QMutexLocker lock(&target.mutex);
    // One flushed line per mark: a process that never reaches the next phase still
    // leaves its last phase on disk, which is the whole point of the trace.
    std::fprintf(target.file, "%lld %llu %s\n", static_cast<long long>(target.clock.elapsed()),
                 static_cast<unsigned long long>(
                     reinterpret_cast<quintptr>(QThread::currentThreadId())),
                 phase);
    std::fflush(target.file);
}

} // namespace lifetrace
