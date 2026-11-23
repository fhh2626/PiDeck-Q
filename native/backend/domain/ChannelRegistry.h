#pragma once

#include "../process/TextEncoding.h"

#include <QHash>
#include <QJsonArray>
#include <QJsonValue>
#include <QString>
#include <QStringList>

#include <functional>
#include <memory>
#include <stdexcept>

/**
 * Domain error raised by a channel handler.
 *
 * The RPC envelope reports failures as `{ok:false, error:{message}}` at HTTP 200,
 * so handlers signal failure by throwing instead of returning a sentinel value.
 * That keeps "no result" (a legitimate null) distinguishable from "failed".
 */
class ChannelError : public std::runtime_error {
public:
    explicit ChannelError(QString message)
        : std::runtime_error(textenc::toUtf8(message)), m_message(std::move(message))
    {
    }
    const QString &message() const { return m_message; }

private:
    QString m_message;
};

/**
 * Completion handle for one channel invocation.
 *
 * Most channels answer synchronously, but every host capability (dialogs, shell,
 * window state, clipboard) is an asynchronous round trip to the Qt host. The
 * responder lets those channels answer later without blocking the event loop.
 * Exactly one of resolve/reject takes effect.
 */
class ChannelResponder {
public:
    using Resolve = std::function<void(const QJsonValue &)>;
    using Reject = std::function<void(const QString &)>;

    ChannelResponder(Resolve resolve, Reject reject)
        : m_resolve(std::move(resolve)), m_reject(std::move(reject)), m_settled(std::make_shared<bool>(false))
    {
    }

    void resolve(const QJsonValue &value);
    void reject(const QString &message);
    bool settled() const { return *m_settled; }

private:
    Resolve m_resolve;
    Reject m_reject;
    // Shared so copies handed to asynchronous continuations still settle once.
    std::shared_ptr<bool> m_settled;
};

using ChannelHandler = std::function<QJsonValue(const QJsonArray &args)>;
using ChannelAsyncHandler = std::function<void(const QJsonArray &args, ChannelResponder responder)>;

/**
 * Channel name -> handler table.
 *
 * Registration is per domain module (projects, sessions, git, ...) so that no
 * single file owns the whole IPC surface. The registry contains no business logic:
 * it only dispatches and converts unknown channels into a structured error.
 */
class ChannelRegistry {
public:
    void add(const QString &channel, ChannelHandler handler);
    void addAsync(const QString &channel, ChannelAsyncHandler handler);
    bool contains(const QString &channel) const;
    /**
     * Dispatch one invocation. Synchronous handlers answer before returning;
     * asynchronous handlers answer later. Unknown channels reject immediately.
     */
    void invoke(const QString &channel, const QJsonArray &args, ChannelResponder responder) const;
    QStringList channels() const;
    int size() const { return int(m_handlers.size() + m_asyncHandlers.size()); }

private:
    QHash<QString, ChannelHandler> m_handlers;
    QHash<QString, ChannelAsyncHandler> m_asyncHandlers;
};
