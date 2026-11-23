#include "ChannelRegistry.h"

void ChannelResponder::resolve(const QJsonValue &value)
{
    if (!m_settled || *m_settled) return;
    *m_settled = true;
    if (m_resolve) m_resolve(value);
}

void ChannelResponder::reject(const QString &message)
{
    if (!m_settled || *m_settled) return;
    *m_settled = true;
    if (m_reject) m_reject(message);
}

void ChannelRegistry::add(const QString &channel, ChannelHandler handler)
{
    m_handlers.insert(channel, std::move(handler));
}

void ChannelRegistry::addAsync(const QString &channel, ChannelAsyncHandler handler)
{
    m_asyncHandlers.insert(channel, std::move(handler));
}

bool ChannelRegistry::contains(const QString &channel) const
{
    return m_handlers.contains(channel) || m_asyncHandlers.contains(channel);
}

QStringList ChannelRegistry::channels() const
{
    QStringList names = m_handlers.keys();
    names.append(m_asyncHandlers.keys());
    names.sort();
    return names;
}

void ChannelRegistry::invoke(const QString &channel, const QJsonArray &args, ChannelResponder responder) const
{
    const auto asyncHandler = m_asyncHandlers.constFind(channel);
    if (asyncHandler != m_asyncHandlers.constEnd()) {
        try {
            asyncHandler.value()(args, responder);
        } catch (const ChannelError &error) {
            responder.reject(error.message());
        } catch (const std::exception &error) {
            responder.reject(QString::fromUtf8(error.what()));
        }
        return;
    }
    const auto handler = m_handlers.constFind(channel);
    if (handler == m_handlers.constEnd()) {
        responder.reject(QStringLiteral("Unknown channel: %1").arg(channel));
        return;
    }
    try {
        responder.resolve(handler.value()(args));
    } catch (const ChannelError &error) {
        responder.reject(error.message());
    } catch (const std::exception &error) {
        responder.reject(QString::fromUtf8(error.what()));
    }
}
