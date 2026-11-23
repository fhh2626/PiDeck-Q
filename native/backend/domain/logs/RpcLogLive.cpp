#include "RpcLogLive.h"

#include <QTimer>

namespace rpclog {

LiveBuffer::LiveBuffer(Deps deps, QObject *parent)
    : QObject(parent), m_deps(std::move(deps))
{
    if (m_deps.flushMs <= 0) m_deps.flushMs = kDefaultFlushMs;
    m_timer = new QTimer(this);
    m_timer->setSingleShot(true);
    QObject::connect(m_timer, &QTimer::timeout, this, [this] { flush(); });
}

void LiveBuffer::enqueue(const QJsonObject &entry)
{
    const QString agentId = entry.value(QStringLiteral("agentId")).toString();
    if (agentId.isEmpty()) return;
    int index = -1;
    for (int cursor = 0; cursor < m_pending.size(); ++cursor) {
        if (m_pending.at(cursor).agentId == agentId) {
            index = cursor;
            break;
        }
    }
    if (index < 0) {
        m_pending.append(Pending{agentId, QJsonArray()});
        index = m_pending.size() - 1;
    }
    QJsonArray &entries = m_pending[index].entries;
    // Newest entries win when a burst outruns the flush timer, exactly like the oracle's
    // bounded splice.
    while (entries.size() >= kMaxPending) entries.removeFirst();
    entries.append(entry);
    schedule();
}

void LiveBuffer::drop(const QString &agentId)
{
    for (int index = 0; index < m_pending.size(); ++index) {
        if (m_pending.at(index).agentId != agentId) continue;
        m_pending.remove(index);
        break;
    }
    if (m_pending.isEmpty() && m_timer) m_timer->stop();
}

void LiveBuffer::clear()
{
    if (m_timer) m_timer->stop();
    m_pending.clear();
}

int LiveBuffer::pendingFor(const QString &agentId) const
{
    for (const Pending &pending : m_pending) {
        if (pending.agentId == agentId) return pending.entries.size();
    }
    return 0;
}

int LiveBuffer::pendingTotal() const
{
    int total = 0;
    for (const Pending &pending : m_pending) total += pending.entries.size();
    return total;
}

void LiveBuffer::schedule()
{
    if (!m_timer || m_timer->isActive() || m_pending.isEmpty()) return;
    m_timer->start(m_deps.flushMs);
}

void LiveBuffer::flush()
{
    if (m_flushing) return;
    m_flushing = true;
    // Snapshot the agent list: a batch sink may enqueue new frames (and new agents) while
    // this flush is running, and those must not be emitted in the same tick.
    const QVector<Pending> snapshot = m_pending;
    m_pending.clear();
    for (const Pending &pending : snapshot) {
        QJsonArray batch;
        QJsonArray rest;
        int index = 0;
        for (const QJsonValue &value : pending.entries) {
            if (index++ < kMaxBatch) batch.append(value);
            else rest.append(value);
        }
        // Park the remainder before delivering: the oracle's `pending.set(agentId, rest)`
        // runs before `emit`, so frames produced by the sink queue up after it.
        if (!rest.isEmpty()) m_pending.append(Pending{pending.agentId, rest});
        if (batch.isEmpty() || !m_deps.deliver) continue;
        m_deps.deliver(QJsonObject{{QStringLiteral("agentId"), pending.agentId},
                                   {QStringLiteral("entries"), batch}});
    }
    m_flushing = false;
    // A >100 burst keeps draining on the next tick even when no new frame arrives.
    schedule();
}

} // namespace rpclog
