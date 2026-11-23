#include "SessionCatalogStore.h"

#include "../ChannelRegistry.h"

#include <QMutexLocker>

/** Compare only the fields that authorize a filesystem deletion, not mutable UI metadata. */
bool SessionCatalogStore::sameDeletionTarget(const CatalogEntry &left, const CatalogEntry &right)
{
    return left.id == right.id && left.projectId == right.projectId
        && left.filePath == right.filePath && left.environment == right.environment
        && left.wslDistro == right.wslDistro && left.wslUser == right.wslUser;
}

bool SessionCatalogStore::pinDeletion(const CatalogEntry &expected)
{
    QMutexLocker<QRecursiveMutex> lock(&m_mutex);
    assertLoaded();
    CatalogEntry current;
    if (m_deletingEntries.contains(expected.id) || !get(expected.id, &current)
        || !sameDeletionTarget(expected, current)) return false;
    m_deletingEntries.insert(expected.id, current);
    ++m_deletionGeneration;
    return true;
}

void SessionCatalogStore::releaseDeletion(const QString &id)
{
    QMutexLocker<QRecursiveMutex> lock(&m_mutex);
    // Also invalidate scans begun during a refused/partially completed mutation.
    if (m_deletingEntries.remove(id)) ++m_deletionGeneration;
}

/** Called under the same transaction lock by every durable catalog mutation. */
void SessionCatalogStore::assertPinnedTargets(const QVector<CatalogEntry> &entries) const
{
    for (const CatalogEntry &pin : m_deletingEntries) {
        if (isTransient(pin.id)) continue;
        bool preserved = false;
        for (const CatalogEntry &entry : entries) {
            if (entry.id == pin.id) { preserved = sameDeletionTarget(pin, entry); break; }
        }
        if (!preserved) throw ChannelError(QStringLiteral("Session deletion is in progress"));
    }
}

bool SessionCatalogStore::removePinned(const CatalogEntry &expected)
{
    QMutexLocker<QRecursiveMutex> lock(&m_mutex);
    CatalogEntry current;
    const auto pin = m_deletingEntries.constFind(expected.id);
    if (pin == m_deletingEntries.constEnd() || !sameDeletionTarget(pin.value(), expected)
        || !get(expected.id, &current) || !sameDeletionTarget(current, expected))
        throw ChannelError(QStringLiteral("Session deletion identity changed"));
    // No other thread can mutate between unpinning and the existing durable remove.
    m_deletingEntries.remove(expected.id);
    try {
        return remove(expected.id);
    } catch (...) {
        m_deletingEntries.insert(expected.id, expected);
        throw;
    }
}
