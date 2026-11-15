#include "ExternalFileCapabilities.h"
#include "../../process/TextEncoding.h"

#include <QDateTime>
#include <QMutexLocker>
#include <QSet>
#include <QUuid>

#include <stdexcept>

namespace {

QString normalizePath(const QString &path)
{
    QString normalized = path;
    normalized.replace(QLatin1Char('\\'), QLatin1Char('/'));
    while (normalized.endsWith(QLatin1Char('/'))) normalized.chop(1);
#ifdef Q_OS_WIN
    return normalized.toLower();
#else
    return normalized;
#endif
}

bool validCapabilityId(const QString &capabilityId)
{
    return !capabilityId.isEmpty() && capabilityId.size() <= 128;
}

const QString kUnavailable = QStringLiteral("The external file capability is missing, expired, or does not include this path.");

} // namespace

ExternalFileCapabilities::ExternalFileCapabilities(Clock clock)
    : m_clock(std::move(clock))
{
    if (!m_clock) m_clock = [] { return QDateTime::currentMSecsSinceEpoch(); };
}

QString ExternalFileCapabilities::issueClipboard(const QStringList &paths, int sequence)
{
    QMutexLocker lock(&m_mutex);
    pruneExpired();
    if (!m_clipboardCapabilityId.isEmpty()) {
        const auto current = m_capabilities.constFind(m_clipboardCapabilityId);
        if (current != m_capabilities.constEnd() && current->hasSequence && current->sequence == sequence) {
            return m_clipboardCapabilityId;
        }
        deleteCapability(m_clipboardCapabilityId);
    }
    return createCapability(paths, Kind::Clipboard, true, sequence, false, 0);
}

QString ExternalFileCapabilities::issueDrop(const QStringList &paths)
{
    QMutexLocker lock(&m_mutex);
    return createCapability(paths, Kind::Drop, false, 0, true, kDropTtlMs);
}

QString ExternalFileCapabilities::issuePicker(const QStringList &paths)
{
    QMutexLocker lock(&m_mutex);
    return createCapability(paths, Kind::Picker, false, 0, true, kPickerTtlMs);
}

QStringList ExternalFileCapabilities::consumeCopy(const QString &capabilityId)
{
    QMutexLocker lock(&m_mutex);
    Entry *entry = entryFor(capabilityId);
    if (!entry) throw textenc::error(kUnavailable);
    const QStringList paths = entry->paths;
    if (entry->kind == Kind::Drop || entry->kind == Kind::Picker) deleteCapability(capabilityId);
    return paths;
}

QString ExternalFileCapabilities::consumeRead(const QString &capabilityId, const QString &requestedPath)
{
    QMutexLocker lock(&m_mutex);
    Entry *entry = entryFor(capabilityId);
    if (!entry) throw textenc::error(kUnavailable);
    const QString requestedKey = normalizePath(requestedPath);
    int index = -1;
    for (int candidate = 0; candidate < entry->paths.size(); ++candidate) {
        if (normalizePath(entry->paths.at(candidate)) == requestedKey) {
            index = candidate;
            break;
        }
    }
    if (index < 0) throw textenc::error(kUnavailable);
    const QString trustedPath = entry->paths.at(index);
    if (entry->kind == Kind::Drop || entry->kind == Kind::Picker) {
        entry->paths.removeAt(index);
        if (entry->paths.isEmpty()) deleteCapability(capabilityId);
    }
    return trustedPath;
}

void ExternalFileCapabilities::revoke(const QString &capabilityId)
{
    QMutexLocker lock(&m_mutex);
    if (validCapabilityId(capabilityId)) deleteCapability(capabilityId);
}

void ExternalFileCapabilities::clear()
{
    QMutexLocker lock(&m_mutex);
    m_capabilities.clear();
    m_order.clear();
    m_clipboardCapabilityId.clear();
}

QString ExternalFileCapabilities::createCapability(const QStringList &paths, Kind kind, bool hasSequence, int sequence,
                                                  bool hasExpiry, qint64 ttlMs)
{
    pruneExpired();
    QStringList uniquePaths;
    QSet<QString> seen;
    for (const QString &path : paths) {
        if (path.isEmpty()) continue;
        const QString key = normalizePath(path);
        if (seen.contains(key)) continue;
        seen.insert(key);
        uniquePaths.append(path);
        if (uniquePaths.size() >= kMaxPathsPerCapability) break;
    }
    if (uniquePaths.isEmpty()) return QString();
    while (m_capabilities.size() >= kMaxCapabilities && !m_order.isEmpty()) {
        deleteCapability(m_order.first());
    }
    const QString capabilityId = QUuid::createUuid().toString(QUuid::WithoutBraces);
    Entry entry;
    entry.paths = uniquePaths;
    entry.sequence = sequence;
    entry.hasSequence = hasSequence;
    entry.expiresAt = hasExpiry ? m_clock() + ttlMs : 0;
    entry.hasExpiry = hasExpiry;
    entry.kind = kind;
    m_capabilities.insert(capabilityId, entry);
    m_order.append(capabilityId);
    if (kind == Kind::Clipboard) m_clipboardCapabilityId = capabilityId;
    return capabilityId;
}

void ExternalFileCapabilities::deleteCapability(const QString &capabilityId)
{
    m_capabilities.remove(capabilityId);
    m_order.removeAll(capabilityId);
    if (m_clipboardCapabilityId == capabilityId) m_clipboardCapabilityId.clear();
}

ExternalFileCapabilities::Entry *ExternalFileCapabilities::entryFor(const QString &capabilityId)
{
    if (!validCapabilityId(capabilityId)) return nullptr;
    const auto entry = m_capabilities.find(capabilityId);
    if (entry == m_capabilities.end()) return nullptr;
    if (entry->hasExpiry && entry->expiresAt <= m_clock()) {
        deleteCapability(capabilityId);
        return nullptr;
    }
    return &entry.value();
}

void ExternalFileCapabilities::pruneExpired()
{
    const qint64 now = m_clock();
    QStringList expired;
    for (auto iterator = m_capabilities.constBegin(); iterator != m_capabilities.constEnd(); ++iterator) {
        if (iterator->hasExpiry && iterator->expiresAt <= now) expired.append(iterator.key());
    }
    for (const QString &capabilityId : expired) deleteCapability(capabilityId);
}
