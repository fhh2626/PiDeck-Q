#pragma once

#include "SessionSummary.h"

#include <QHash>
#include <QMutex>
#include <QObject>
#include <QSet>
#include <QString>
#include <QStringList>

#include <memory>

class QTimer;

/**
 * Session summary cache: memory + disk (port of src/main/sessions/sessionSummaryCache.ts).
 *
 * Session JSONL files are append-only and can be a few megabytes each; a sidebar poll that
 * re-read and re-parsed every transcript was the dominant scan cost. The cache remembers
 * the parsed summary (or the fact that a file is not a session) keyed by path and
 * invalidated by `mtimeMs + size`, and restores the map from `userData` after a restart so
 * the first list after launch does not re-read every history either.
 *
 * Semantics that matter and are therefore explicit:
 *  - the disk schema is versioned (4). A different version, a corrupt file or a missing
 *    file is a silent cold start, never an error: the cache is derived data, and a scan
 *    must keep working when it cannot be loaded.
 *  - `prune` only removes entries of the *current* environment. Switching between local
 *    and WSL scans must not delete the other environment's disk cache, otherwise every
 *    toggle would rescan everything.
 *  - writes are debounced (800 ms) and atomic (temp + rename with retry); a failed write
 *    keeps the cache dirty for the next attempt instead of losing it for the session.
 *  - `reloadFromDisk` is what an environment switch uses: the in-memory map belonged to
 *    the previous environment, the disk may already hold the target environment's entries.
 *
 * Threading: session scans run on the backend's serial domain executor while settings and
 * startup tasks run on the main thread, so the map is mutex-guarded and the debounce timer
 * lives on the owning (main) thread. Disk writes are dispatched to the serial executor so
 * a large cache never blocks the event loop; `flush()` writes synchronously because it
 * runs during shutdown, after which no more executor work is guaranteed. Both paths share
 * one write lock plus the highest persisted mutation sequence (`WriteState`), so a
 * debounced write that is still queued when `flush()` runs can never rename an older
 * payload over the newer one.
 */
namespace summarycache {

/** Shared write-ordering state (defined in WriteOrdering.h). */
struct WriteState;

class Cache : public QObject {
public:
    enum class Mode { Local, Wsl };
    enum class Lookup { Miss, Negative, Hit };

    struct Value {
        Lookup lookup = Lookup::Miss;
        SessionSummary summary;
    };

    /** `filePath` is the full cache file path; an empty path keeps the cache memory-only. */
    explicit Cache(const QString &filePath, QObject *parent = nullptr);
    ~Cache() override;

    QString filePath() const { return m_filePath; }

    /** Load the disk cache once. Missing/corrupt content is a silent cold start. */
    void ensureLoaded();

    /** Look up one file version; a stale version is dropped (and the cache marked dirty). */
    Value get(const QString &path, qint64 mtimeMs, qint64 size);

    /** Store a summary, or `nullptr` for "this file is not a displayable session". */
    void set(const QString &path, qint64 mtimeMs, qint64 size, const SessionSummary *summary);

    /**
     * Drop entries of the current environment that were not part of this scan.
     * WSL UNC paths and existing summary flags retain their environment identity.
     * A legacy POSIX key belongs to WSL only on a Windows host.
     */
    void prune(const QStringList &keepPaths, Mode mode);

    /** Clear memory. `persist` also rewrites the (now empty) disk file. */
    void clear(bool persist);

    /** Discard the in-memory map and load the disk file again (environment switch). */
    void reloadFromDisk();

    /** Cancel the debounce and write now; used at shutdown. */
    void flush();

private:
    struct Entry {
        qint64 mtimeMs = 0;
        qint64 size = 0;
        bool hasSummary = false;
        SessionSummary summary;
    };

    void loadFromDiskLocked();
    /** Arm the debounce timer on the owning thread (safe from the domain thread). */
    void notifyDirty();
    void armTimer();
    void startBackgroundSave();
    QByteArray serializeLocked() const;

    const QString m_filePath;
    mutable QMutex m_mutex;
    /** Serializes disk writes between the debounce and `flush()`; see WriteState. */
    std::shared_ptr<WriteState> m_write;
    QHash<QString, Entry> m_store;
    bool m_loaded = false;
    bool m_dirty = false;
    /** Incremented on every mutation; a write only clears dirty when the sequence held. */
    quint64 m_mutationSeq = 0;
    QTimer *m_timer = nullptr;
};

} // namespace summarycache
