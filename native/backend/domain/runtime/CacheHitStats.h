#pragma once

#include <QByteArray>
#include <QHash>
#include <QJsonObject>
#include <QString>

/**
 * Session cache-hit statistics (port of src/main/pi/cacheHitStats.ts).
 *
 * The renderer's session-status panel shows "latest cache hit" and "average cache hit"
 * rows. pi's `get_session_stats` RPC does not return a hit rate, so the oracle reads the
 * session JSONL and computes it from each assistant message's `usage`:
 *
 *   cacheRead / (input + cacheRead + cacheWrite) * 100
 *
 * Same denominator as the pi CLI footer. A file-level (size, mtimeMs) cache keeps the
 * per-event `get_state` polling from re-parsing an unchanged session file.
 */
namespace cachehit {

struct Stats {
    bool hasLatest = false;
    double latest = 0;
    bool hasAverage = false;
    double average = 0;
    int sampleCount = 0;
    int messageChars = 0;
};

/** Single-usage hit rate; `None` when the prompt side has no tokens at all. */
bool hitRateFromUsage(const QJsonObject &usage, double *out);

/** Parse the raw JSONL. Bad lines are skipped; only usage-bearing assistants count. */
Stats compute(const QByteArray &raw);

/** File-backed reader with the oracle's (size, mtimeMs) result cache. */
class Reader {
public:
    /** Stats for `sessionPath`; missing/unreadable files yield an empty result. */
    Stats read(const QString &sessionPath);

private:
    struct Entry {
        qint64 size = 0;
        double mtimeMs = 0;
        Stats stats;
    };
    QHash<QString, Entry> m_cache;
};

} // namespace cachehit
