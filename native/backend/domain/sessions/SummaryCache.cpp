#include "SummaryCache.h"

#include "SummaryReader.h"
#include "WriteOrdering.h"

#include "../fs/JsonFile.h"
#include "../process/BackgroundWork.h"

#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonValue>
#include <QMetaObject>
#include <QMutexLocker>
#include <QPointer>
#include <QThread>
#include <QTimer>

#include <memory>

namespace summarycache {
namespace {

/** Interpretation/field changes bump this; a stale file is dropped, not migrated. */
constexpr int kDiskSchemaVersion = 4;
constexpr int kSaveDebounceMs = 800;

/**
 * `key.startsWith("/") && !/^[A-Za-z]:/.test(key)` — a leading slash can never be a drive
 * prefix, but the form is kept so the rule reads the same as the oracle's.
 */
bool isWslPath(const QString &path)
{
    if (!path.startsWith(QLatin1Char('/'))) return false;
    const bool drivePrefixed = path.size() >= 2 && path.at(0).isLetter() && path.at(1) == QLatin1Char(':');
    return !drivePrefixed;
}

/** Node's `stat().mtimeMs` is a float; `jsonWholeMillis` decides what is loadable. */

} // namespace

namespace {

/**
 * Persist one snapshot unless a newer one already won.
 *
 * Returns true when the payload is on disk (written now or superseded by a newer one),
 * false when the write failed and the cache must stay dirty. The ordering rule itself
 * lives in `WriteOrdering` so it can be tested without a timer, executor or shutdown.
 */
bool writeOrdered(const std::shared_ptr<WriteState> &state, const QString &path,
                  const QByteArray &payload, quint64 sequence)
{
    return WriteOrdering(state, [&path](const QByteArray &bytes) {
        return jsonfile::writeBytesAtomic(path, bytes, nullptr);
    }).write(payload, sequence);
}

} // namespace

Cache::Cache(const QString &filePath, QObject *parent)
    : QObject(parent), m_filePath(filePath), m_write(std::make_shared<WriteState>())
{
}

Cache::~Cache() = default;

void Cache::ensureLoaded()
{
    {
        QMutexLocker lock(&m_mutex);
        if (m_loaded) return;
        loadFromDiskLocked();
        m_loaded = true;
    }
}

void Cache::loadFromDiskLocked()
{
    m_store.clear();
    if (m_filePath.isEmpty()) return;
    QString raw;
    // A missing or unreadable cache is a cold start: the scan must never depend on it.
    if (!jsonfile::readText(m_filePath, &raw)) return;
    const QJsonDocument document = QJsonDocument::fromJson(raw.toUtf8());
    if (!document.isObject()) return;
    const QJsonObject root = document.object();
    if (root.value(QStringLiteral("version")).toInt(-1) != kDiskSchemaVersion) return;
    const QJsonValue entriesValue = root.value(QStringLiteral("entries"));
    if (!entriesValue.isObject()) return;
    const QJsonObject entries = entriesValue.toObject();
    for (auto iterator = entries.constBegin(); iterator != entries.constEnd(); ++iterator) {
        if (!iterator.value().isObject()) continue;
        const QJsonObject record = iterator.value().toObject();
        const QJsonValue versionValue = record.value(QStringLiteral("version"));
        if (!versionValue.isObject()) continue;
        const QJsonObject version = versionValue.toObject();
        Entry entry;
        // A version that cannot be a real stat (non-finite, outside qint64) is dropped:
        // the oracle keeps it and simply never matches, so a rescan is the same answer.
        if (!summaryreader::jsonWholeMillis(version.value(QStringLiteral("mtimeMs")), &entry.mtimeMs)) continue;
        if (!summaryreader::jsonWholeMillis(version.value(QStringLiteral("size")), &entry.size)) continue;
        const QJsonValue value = record.value(QStringLiteral("value"));
        if (value.isObject()) {
            SessionSummary summary;
            if (!summaryreader::fromJson(value.toObject(), &summary)) continue;
            entry.hasSummary = true;
            entry.summary = summary;
        } else if (!value.isNull()) {
            continue;
        }
        m_store.insert(iterator.key(), entry);
    }
}

Cache::Value Cache::get(const QString &path, qint64 mtimeMs, qint64 size)
{
    bool dirty = false;
    Value result;
    {
        QMutexLocker lock(&m_mutex);
        auto iterator = m_store.find(path);
        if (iterator == m_store.end()) return result;
        if (iterator->mtimeMs != mtimeMs || iterator->size != size) {
            // The file changed: the cached summary is now a wrong answer, not just stale.
            m_store.erase(iterator);
            m_dirty = true;
            m_mutationSeq += 1;
            dirty = true;
        } else {
            result.lookup = iterator->hasSummary ? Lookup::Hit : Lookup::Negative;
            if (iterator->hasSummary) result.summary = iterator->summary;
            return result;
        }
    }
    if (dirty) notifyDirty();
    return result;
}

void Cache::set(const QString &path, qint64 mtimeMs, qint64 size, const SessionSummary *summary)
{
    {
        QMutexLocker lock(&m_mutex);
        auto iterator = m_store.find(path);
        if (iterator != m_store.end() && iterator->mtimeMs == mtimeMs && iterator->size == size
            && iterator->hasSummary == (summary != nullptr)) {
            // Same version and same "is a session" answer: nothing to persist. A negative
            // entry has no payload to compare, so equal negatives are equal.
            if (!summary) return;
        }
        Entry entry;
        entry.mtimeMs = mtimeMs;
        entry.size = size;
        if (summary) {
            entry.hasSummary = true;
            entry.summary = *summary;
        }
        m_store.insert(path, entry);
        m_dirty = true;
        m_mutationSeq += 1;
    }
    notifyDirty();
}

void Cache::prune(const QStringList &keepPaths, Mode mode)
{
    bool removed = false;
    {
        QMutexLocker lock(&m_mutex);
        const QSet<QString> keep(keepPaths.begin(), keepPaths.end());
        QStringList dropped;
        for (auto iterator = m_store.constBegin(); iterator != m_store.constEnd(); ++iterator) {
            const bool wslPath = isWslPath(iterator.key());
            if (mode == Mode::Local && wslPath) continue;
            if (mode == Mode::Wsl && !wslPath) continue;
            if (!keep.contains(iterator.key())) dropped.append(iterator.key());
        }
        for (const QString &key : dropped) m_store.remove(key);
        removed = !dropped.isEmpty();
        if (removed) {
            m_dirty = true;
            m_mutationSeq += 1;
        }
    }
    if (removed) notifyDirty();
}

void Cache::clear(bool persist)
{
    bool dirtied = false;
    {
        QMutexLocker lock(&m_mutex);
        if (m_store.isEmpty()) return;
        m_store.clear();
        if (persist) {
            m_dirty = true;
            m_mutationSeq += 1;
            dirtied = true;
        }
    }
    if (dirtied) notifyDirty();
}

void Cache::reloadFromDisk()
{
    {
        QMutexLocker lock(&m_mutex);
        // Do not clear through `clear(true)`: switching environments must not erase the
        // other environment's persisted entries.
        m_store.clear();
        loadFromDiskLocked();
        m_loaded = true;
    }
}

void Cache::flush()
{
    if (QThread::currentThread() != thread()) {
        // Only the owning thread may touch the timer; a blocking hop keeps flush() safe
        // from the domain thread too (shutdown calls it from the main thread).
        QMetaObject::invokeMethod(this, [this] { flush(); }, Qt::BlockingQueuedConnection);
        return;
    }
    if (m_timer) m_timer->stop();
    QByteArray payload;
    quint64 sequence = 0;
    {
        QMutexLocker lock(&m_mutex);
        if (!m_dirty || m_filePath.isEmpty()) return;
        payload = serializeLocked();
        sequence = m_mutationSeq;
    }
    // A debounced write may still be queued or in flight; waiting for it here keeps the
    // newer snapshot as the last write to land instead of letting the older rename win.
    if (!writeOrdered(m_write, m_filePath, payload, sequence)) return;
    QMutexLocker lock(&m_mutex);
    // A mutation that landed while writing stays dirty and its own timer writes again.
    if (m_mutationSeq == sequence) m_dirty = false;
}

QByteArray Cache::serializeLocked() const
{
    QJsonObject entries;
    for (auto iterator = m_store.constBegin(); iterator != m_store.constEnd(); ++iterator) {
        QJsonObject record{
            {QStringLiteral("version"),
             QJsonObject{{QStringLiteral("mtimeMs"), double(iterator->mtimeMs)},
                         {QStringLiteral("size"), double(iterator->size)}}},
        };
        record.insert(QStringLiteral("value"), iterator->hasSummary
                                                   ? QJsonValue(summaryreader::toJson(iterator->summary))
                                                   : QJsonValue(QJsonValue::Null));
        entries.insert(iterator.key(), record);
    }
    const QJsonObject root{
        {QStringLiteral("version"), kDiskSchemaVersion},
        {QStringLiteral("entries"), entries},
    };
    return QJsonDocument(root).toJson(QJsonDocument::Compact);
}

void Cache::notifyDirty()
{
    if (QThread::currentThread() == thread()) {
        armTimer();
        return;
    }
    QMetaObject::invokeMethod(this, [this] { armTimer(); }, Qt::QueuedConnection);
}

void Cache::armTimer()
{
    if (m_filePath.isEmpty()) return;
    if (!m_timer) {
        m_timer = new QTimer(this);
        m_timer->setSingleShot(true);
        connect(m_timer, &QTimer::timeout, this, &Cache::startBackgroundSave);
    }
    // Each mutation restarts the window, so a burst of scans writes once.
    m_timer->start(kSaveDebounceMs);
}

void Cache::startBackgroundSave()
{
    if (m_filePath.isEmpty()) return;
    QByteArray payload;
    quint64 sequence = 0;
    {
        QMutexLocker lock(&m_mutex);
        if (!m_dirty) return;
        payload = serializeLocked();
        sequence = m_mutationSeq;
    }
    // The write itself goes to the serial domain executor: the event loop must not stall on
    // a multi-megabyte cache, and the executor also serializes it against scans. The
    // shared write state keeps this payload from landing after a newer shutdown flush.
    const QString path = m_filePath;
    auto wrote = std::make_shared<bool>(false);
    const std::shared_ptr<WriteState> writeState = m_write;
    background::runBlocking(
        [path, payload, sequence, wrote, writeState]() -> QJsonValue {
            *wrote = writeOrdered(writeState, path, payload, sequence);
            return QJsonValue();
        },
        [guard = QPointer<Cache>(this), sequence, wrote](background::Outcome) {
            if (!guard || !*wrote) return;
            QMutexLocker lock(&guard->m_mutex);
            if (guard->m_mutationSeq == sequence) guard->m_dirty = false;
        });
}

} // namespace summarycache
