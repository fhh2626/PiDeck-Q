#pragma once

#include <QJsonObject>
#include <QObject>
#include <QString>
#include <QTimer>

#include <functional>

/**
 * `PIDECK_MEMORY_PROFILE=1` sampler.
 *
 * Port of src/native-node/diagnostics/NativeMemoryMonitor.ts: the renderer posts its own
 * JS-heap/DOM counters to `POST /__pideck/diagnostics/memory`, this class merges them with
 * the backend process's own RSS and appends one row per tick to
 * `<userData>/memory-profile/profile-<epochMs>.csv`.
 *
 * The CSV contract (header, column order, quoting, KB units) is shared with
 * scripts/lib/memoryProfileCsv.ts so `scripts/analyze-memory.mjs` can analyse a C++
 * backend run without changes. Sampling must never influence the thing being measured:
 * a failed mkdir/open disables the monitor instead of failing backend startup, and a
 * failed append is dropped (the oracle swallows the same error).
 */
namespace memorymonitor {

/** Byte-identical to `MEMORY_PROFILE_HEADER` in scripts/lib/memoryProfileCsv.ts. */
extern const char *const kCsvHeader;

/** Physical memory of the current process; `available` is false when unmeasurable. */
struct ProcessMemory {
    bool available = false;
    qint64 rssKB = 0;
    bool hasPrivate = false;
    qint64 privateKB = 0;
    bool hasPeakRss = false;
    qint64 peakRssKB = 0;
};

ProcessMemory readProcessMemory();

/**
 * Serialize one sample.
 *
 * `renderer` carries the renderer-posted counters (`jsHeapKB`, `totalJSHeapKB`, `domNodes`,
 * `imgCount`, `imgPixels`, `canvasPixels`, `workerCount`, `workerJSHeapKB`); a missing or
 * non-numeric field is an empty cell, exactly like `null` in the oracle. NULL columns are
 * written as an empty cell so "not applicable" stays distinguishable from a measured 0.
 */
QString csvRow(qint64 ts, const QString &type, qint64 pid, const QString &label, const ProcessMemory &memory,
               const QJsonObject &renderer, bool streaming);

class Monitor : public QObject {

public:
    struct Deps {
        QString userDataDir;
        int intervalMs = 5'000;
        /** True while any bound agent is streaming; injected so the monitor owns no state. */
        std::function<bool()> isStreaming;
    };

    explicit Monitor(Deps deps, QObject *parent = nullptr);

    /**
     * Create `<userData>/memory-profile/profile-<ms>.csv`, write the header, take the first
     * sample and start the timer. Returns the file path, or an empty string when the
     * directory/file cannot be created (profiling is then simply off).
     */
    QString start();
    void stop();

    /** Merge a renderer-posted diagnostics object; later posts win per field. */
    void updateRendererDiagnostics(const QJsonObject &diagnostics);

private:
    void sample();

    Deps m_deps;
    QString m_filePath;
    QTimer m_timer;
    QJsonObject m_latestRenderer;
};

} // namespace memorymonitor
