#include "WebStreamRouter.h"

namespace webstream {
namespace {

/** Event types that may create a run: only a real turn start is worth keeping state for. */
bool opensRun(const QString &type)
{
    static const QSet<QString> types{QStringLiteral("agent_start"),
                                     QStringLiteral("message_start"),
                                     QStringLiteral("message_update"),
                                     QStringLiteral("message_end"),
                                     QStringLiteral("tool_execution_update"),
                                     QStringLiteral("tool_execution_start"),
                                     QStringLiteral("tool_execution_end")};
    return types.contains(type);
}

} // namespace

std::shared_ptr<Router::Run> Router::getOrCreateRun(const QString &sessionId)
{
    auto existing = m_runs.find(sessionId);
    if (existing != m_runs.end()) return existing.value();
    auto run = std::make_shared<Run>();
    m_runs.insert(sessionId, run);
    return run;
}

int Router::attach(const QString &sessionId, Writer writer, const QVector<ToolInput> &tools,
                   Admission admission)
{
    const std::shared_ptr<Run> run = getOrCreateRun(sessionId);
    // A POST may join a GET that pinned a *starting* runtime. That preparation is not
    // the new prompt's completion, so the fence is dropped; the prompt path re-pins it.
    if (admission == Admission::Dispatch) run->hasTarget = false;
    // A later GET must not revoke an earlier POST's pre-dispatch patience. A fresh run
    // (created by this GET) keeps `observe`, so "nothing to watch" finishes immediately;
    // once any POST has subscribed the run stays dispatch-mode for good.
    if (admission == Admission::Dispatch) run->admission = Admission::Dispatch;

    const int token = run->nextSubscriberId++;
    auto subscriber = std::make_shared<Subscriber>();
    subscriber->writer = std::move(writer);
    run->subscribers.insert(token, subscriber);

    // Reconnect during a quiet/long tool must not wait for the next event. Only active
    // tool *inputs* are replayed, and only to this socket.
    for (const QJsonObject &frame : run->adapter.replayActiveTools(tools)) {
        if (writeFrame(*subscriber, frame)) continue;
        closeSubscriber(*run, token);
        break;
    }
    return token;
}

void Router::detach(const QString &sessionId, int token)
{
    const auto run = m_runs.find(sessionId);
    if (run == m_runs.end()) return;
    closeSubscriber(*run.value(), token);
}

void Router::clear()
{
    // Sockets are owned by the service and closed there; drop the state only.
    m_runs.clear();
}

void Router::observe(const QVector<RuntimeInfo> &runtimes)
{
    QHash<QString, RuntimeInfo> bySession;
    for (const RuntimeInfo &runtime : runtimes) bySession.insert(runtime.sessionId, runtime);
    // `finish` erases from m_runs, so snapshot the keys before iterating.
    const QStringList sessionIds = m_runs.keys();
    for (const QString &sessionId : sessionIds) {
        const auto iterator = m_runs.find(sessionId);
        if (iterator == m_runs.end()) continue;
        const std::shared_ptr<Run> run = iterator.value();
        const auto runtime = bySession.constFind(sessionId);
        const Target *target = run->hasTarget ? &run->runtimeTarget : nullptr;
        const RuntimeInfo *info = runtime == bySession.constEnd() ? nullptr : &runtime.value();
        const Reconcile next = reconcile(target, info, run->admission);
        run->hasTarget = next.hasTarget;
        run->runtimeTarget = next.target;
        if (next.finish && !run->promptPending) {
            // The runtime ended (settled, killed or replaced) without a settled event we
            // could route: close the run so the browser always receives `[DONE]`.
            finish(sessionId);
        }
    }
}

void Router::finish(const QString &sessionId, const QString &errorText)
{
    const auto iterator = m_runs.find(sessionId);
    if (iterator == m_runs.end()) return;
    const std::shared_ptr<Run> run = iterator.value();
    m_runs.erase(iterator);
    const QVector<QJsonObject> frames = errorText.isEmpty()
        ? run->adapter.finish()
        : run->adapter.push(QJsonObject{{QStringLiteral("type"), QStringLiteral("agent_end")},
                                        {QStringLiteral("error"), errorText}});
    broadcast(*run, frames);
}

void Router::onPiEvent(const QString &agentId, const QJsonObject &event, int streamGeneration)
{
    if (!m_resolveSession) return;
    const QString sessionId = m_resolveSession(agentId);
    if (sessionId.isEmpty()) return;

    const QString type = event.value(QStringLiteral("type")).toString();
    const auto existing = m_runs.find(sessionId);
    std::shared_ptr<Run> run;
    if (existing == m_runs.end()) {
        // A non-run event must not create long-lived state just because the service is
        // listening to every agent.
        if (!opensRun(type)) return;
        run = getOrCreateRun(sessionId);
    } else {
        run = existing.value();
    }

    // `agent_start` carries the identity of a new run. A late settled/delta from the old
    // generation must neither finish nor pollute the new one, so the adapter is replaced
    // on a generation change; existing sockets stay attached (the phone keeps its view).
    if (!run->hasStreamGeneration) {
        run->hasStreamGeneration = true;
        run->streamGeneration = streamGeneration;
    } else if (run->streamGeneration != streamGeneration) {
        if (type != QLatin1String("agent_start")) return;
        auto replacement = std::make_shared<Run>();
        replacement->hasStreamGeneration = true;
        replacement->streamGeneration = streamGeneration;
        replacement->admission = run->admission;
        replacement->promptPending = run->promptPending;
        replacement->subscribers = run->subscribers;
        replacement->nextSubscriberId = run->nextSubscriberId;
        m_runs.insert(sessionId, replacement);
        run = replacement;
    }

    broadcast(*run, run->adapter.push(event));
    if (!run->adapter.isFinished()) return;
    const auto current = m_runs.find(sessionId);
    if (current != m_runs.end() && current.value() == run) m_runs.erase(current);
}

void Router::setPromptPending(const QString &sessionId, bool pending)
{
    const auto iterator = m_runs.find(sessionId);
    if (iterator == m_runs.end()) return;
    iterator.value()->promptPending = pending;
}

void Router::broadcast(Run &run, const QVector<QJsonObject> &frames)
{
    for (const QJsonObject &frame : frames) {
        const QList<int> tokens = run.subscribers.keys();
        for (const int token : tokens) {
            const auto iterator = run.subscribers.find(token);
            if (iterator == run.subscribers.end()) continue;
            const std::shared_ptr<Subscriber> subscriber = iterator.value();
            if (subscriber->closed) continue;
            if (!writeFrame(*subscriber, frame)) {
                closeSubscriber(run, token);
                continue;
            }
            if (frame.value(QStringLiteral("type")).toString() != QLatin1String("finish")) continue;
            // `finish` is the last frame of a UIMessageStream: without `[DONE]` the client
            // keeps the request open and never settles.
            if (!subscriber->writer.write(QString::fromLatin1(kSseDone))) {
                closeSubscriber(run, token);
                continue;
            }
            subscriber->closed = true;
            run.subscribers.remove(token);
            if (subscriber->writer.onFinish) subscriber->writer.onFinish();
        }
    }
}

bool Router::writeFrame(Subscriber &subscriber, const QJsonObject &frame)
{
    const QString type = frame.value(QStringLiteral("type")).toString();
    const QString id = frame.value(QStringLiteral("id")).toString();
    if (type == QLatin1String("text-start") && !id.isEmpty()) subscriber.openTextIds.insert(id);
    if (type == QLatin1String("reasoning-start") && !id.isEmpty()) {
        subscriber.openReasoningIds.insert(id);
    }
    // A reconnected socket may join mid-block. Its AI SDK parser has an empty part table,
    // so a bare delta would be rejected; a bare end would create an empty duplicate part.
    if (type == QLatin1String("text-delta") && !id.isEmpty()
        && !subscriber.openTextIds.contains(id)) {
        if (!subscriber.writer.write(serializeFrame(
                QJsonObject{{QStringLiteral("type"), QStringLiteral("text-start")},
                            {QStringLiteral("id"), id}}))) {
            return false;
        }
        subscriber.openTextIds.insert(id);
    }
    if (type == QLatin1String("reasoning-delta") && !id.isEmpty()
        && !subscriber.openReasoningIds.contains(id)) {
        if (!subscriber.writer.write(serializeFrame(
                QJsonObject{{QStringLiteral("type"), QStringLiteral("reasoning-start")},
                            {QStringLiteral("id"), id}}))) {
            return false;
        }
        subscriber.openReasoningIds.insert(id);
    }
    if (type == QLatin1String("text-end") && !id.isEmpty()
        && !subscriber.openTextIds.contains(id)) {
        return true;
    }
    if (type == QLatin1String("reasoning-end") && !id.isEmpty()
        && !subscriber.openReasoningIds.contains(id)) {
        return true;
    }
    if (!subscriber.writer.write(serializeFrame(frame))) return false;
    if (type == QLatin1String("text-end") && !id.isEmpty()) subscriber.openTextIds.remove(id);
    if (type == QLatin1String("reasoning-end") && !id.isEmpty()) {
        subscriber.openReasoningIds.remove(id);
    }
    return true;
}

void Router::closeSubscriber(Run &run, int token)
{
    const auto iterator = run.subscribers.find(token);
    if (iterator == run.subscribers.end()) return;
    const std::shared_ptr<Subscriber> subscriber = iterator.value();
    run.subscribers.erase(iterator);
    if (subscriber->closed) return;
    subscriber->closed = true;
    if (subscriber->writer.onClose) subscriber->writer.onClose();
}

} // namespace webstream
