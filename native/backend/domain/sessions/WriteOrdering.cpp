#include "WriteOrdering.h"

#include <QMutexLocker>

#include <utility>

namespace summarycache {

WriteOrdering::WriteOrdering(std::shared_ptr<WriteState> state, Writer writer)
    : m_state(std::move(state)), m_writer(std::move(writer))
{
}

bool WriteOrdering::write(const QByteArray &payload, quint64 sequence)
{
    QMutexLocker lock(&m_state->mutex);
    // An equal sequence is a repeat of what is already on disk (the debounce and the
    // shutdown flush can carry the same snapshot): rewriting it would only add a rename.
    if (sequence <= m_state->persistedSequence) return true;
    if (!m_writer || !m_writer(payload)) return false;
    m_state->persistedSequence = sequence;
    return true;
}

quint64 WriteOrdering::persistedSequence()
{
    QMutexLocker lock(&m_state->mutex);
    return m_state->persistedSequence;
}

} // namespace summarycache
