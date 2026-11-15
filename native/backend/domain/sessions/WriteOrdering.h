#pragma once

#include <QByteArray>
#include <QMutex>

#include <functional>
#include <memory>

namespace summarycache {

/**
 * Write serialization shared between the debounced background write and `flush()`.
 *
 * Both paths persist one cache file: the debounce posts the write to the serial domain
 * executor, while shutdown's `flush()` writes synchronously on the main thread. If the
 * debounced payload is still queued when `flush()` persists a newer snapshot, the older
 * payload's rename could land *after* it and silently roll the disk cache back one
 * version (benign — entries are re-validated by mtime+size — but it loses work and makes
 * the next launch rescan everything).
 *
 * Keeping the state in a `shared_ptr` lets the executor-side body participate without
 * touching the `Cache` object across threads: the body only needs this mutex and the
 * highest persisted sequence, and it stays valid even if the cache is destroyed first.
 */
struct WriteState {
    QMutex mutex;
    /** Highest mutation sequence that is known to be on disk. */
    quint64 persistedSequence = 0;
};

/**
 * Ordering gate for one cache file.
 *
 * The rule is "a payload may only be persisted while it is newer than the last persisted
 * one", which is what makes the debounce/flush interleaving safe. It is extracted from the
 * cache so that rule can be tested without an executor, a timer or a shutdown: the test
 * drives `write()` in exactly the order that used to lose data (older payload last).
 *
 * The writer callback performs the actual atomic file write and reports success; the gate
 * only decides whether to call it and records the sequence when it succeeded.
 */
class WriteOrdering {
public:
    /** Returns true when the payload is on disk. */
    using Writer = std::function<bool(const QByteArray &payload)>;

    WriteOrdering(std::shared_ptr<WriteState> state, Writer writer);

    /**
     * Persist `payload` unless a newer sequence already won.
     *
     * Returns true when the payload is on disk (written now, or superseded by a newer
     * snapshot) and false when the write failed — the cache then stays dirty.
     */
    bool write(const QByteArray &payload, quint64 sequence);

    /** Highest sequence known to be on disk (test/diagnostic seam). */
    quint64 persistedSequence();

private:
    std::shared_ptr<WriteState> m_state;
    Writer m_writer;
};

} // namespace summarycache
