#include "RuntimeCoordinator.h"

#include "PiLaunch.h"

#include "../sessions/SessionCatalogStore.h"

#include <QDateTime>

namespace runtime {
namespace {

constexpr int kStateTimeoutMs = 30'000;
constexpr int kPromptTimeoutMs = 120'000;

qint64 nowMs()
{
    return QDateTime::currentMSecsSinceEpoch();
}

QJsonObject rejectedResult(const QString &sessionId, const QString &requestId, const QString &error,
                           bool unknownDelivery = false)
{
    QJsonObject result{
        {QStringLiteral("accepted"), false},
        {QStringLiteral("error"), error},
        {QStringLiteral("i18nKey"), unknownDelivery ? QStringLiteral("diagnostic.promptDeliveryUnknown")
                                                    : QStringLiteral("diagnostic.promptRejected")},
        {QStringLiteral("debugDetails"), error},
        {QStringLiteral("sessionId"), sessionId},
        {QStringLiteral("requestId"), requestId},
    };
    // The oracle only marks a delivery state when it cannot prove pi ignored the prompt;
    // an explicit pi rejection carries no `delivery` field at all (SendPromptResult).
    if (unknownDelivery) result.insert(QStringLiteral("delivery"), QStringLiteral("unknown"));
    return result;
}

} // namespace

void Coordinator::send(const QJsonObject &input, std::function<void(QJsonObject)> done)
{
    const QString sessionId = input.value(QStringLiteral("sessionId")).toString().trimmed();
    const QString requestId = input.value(QStringLiteral("requestId")).toString().trimmed();
    const QString message = input.value(QStringLiteral("message")).toString();
    const QJsonArray images = input.value(QStringLiteral("images")).toArray();
    const bool silent = input.value(QStringLiteral("silent")).toBool(false);
    const QString agentMessage = input.value(QStringLiteral("agentMessage")).toString();
    if (sessionId.isEmpty()) {
        done(rejectedResult(sessionId, requestId, QStringLiteral("Session ID is required")));
        return;
    }
    if (requestId.isEmpty()) {
        done(rejectedResult(sessionId, requestId, QStringLiteral("Request ID is required")));
        return;
    }
    const bool hasSilentCommand = silent && !agentMessage.trimmed().isEmpty();
    if (message.trimmed().isEmpty() && images.isEmpty() && !hasSilentCommand) {
        done(rejectedResult(sessionId, requestId, QStringLiteral("Message is required")));
        return;
    }

    pruneDelivery();
    const QString key = deliveryKey(sessionId, requestId);
    auto existing = m_delivery.find(key);
    if (existing != m_delivery.end()) {
        // Idempotent send: the same requestId never dispatches twice.
        if (existing->settled) {
            done(existing->result);
        } else {
            existing->waiters.append(std::move(done));
        }
        return;
    }
    DeliveryEntry entry;
    entry.createdAt = nowMs();
    m_delivery.insert(key, entry);

    activate(sessionId, [this, input, key, done, images, silent, agentMessage](QJsonObject activation) {
        const QString sessionId = input.value(QStringLiteral("sessionId")).toString();
        const QString requestId = input.value(QStringLiteral("requestId")).toString();
        if (!activation.value(QStringLiteral("ok")).toBool(false)) {
            const QString error = activation.value(QStringLiteral("error")).toObject()
                                      .value(QStringLiteral("debugDetails")).toString();
            const QJsonObject result = rejectedResult(sessionId, requestId,
                                                      error.isEmpty()
                                                          ? QStringLiteral("Session runtime is not available")
                                                          : error);
            settleDelivery(key, result);
            done(result);
            return;
        }
        Target target;
        const QJsonObject info = activation.value(QStringLiteral("value")).toObject();
        target.sessionId = sessionId;
        target.agentId = info.value(QStringLiteral("agentId")).toString();
        target.runtimeGeneration = info.value(QStringLiteral("runtimeGeneration")).toInt();
        AgentSession *session = agent(target.agentId);
        if (!session) {
            const QJsonObject result = rejectedResult(sessionId, requestId,
                                                      QStringLiteral("Session runtime is not available"));
            settleDelivery(key, result);
            done(result);
            return;
        }

        quint64 lease = 0;
        try {
            lease = m_bindings.acquireLease(target);
        } catch (const std::exception &failure) {
            const QJsonObject result = rejectedResult(sessionId, requestId,
                                                      QString::fromUtf8(failure.what()));
            settleDelivery(key, result);
            done(result);
            return;
        }

        const QString statusBeforePrompt = session->tab().status;
        const bool streaming = statusBeforePrompt == QLatin1String("running");
        QString behavior = input.value(QStringLiteral("streamingBehavior")).toString();
        if (streaming && behavior.isEmpty()) behavior = QStringLiteral("steer");
        const QString promptText = agentMessage.isEmpty() ? input.value(QStringLiteral("message")).toString()
                                                          : agentMessage;
        if (!silent) {
            QJsonObject meta;
            if (!behavior.isEmpty()) meta.insert(QStringLiteral("streamingBehavior"), behavior);
            if (!requestId.isEmpty()) meta.insert(QStringLiteral("optimisticRequestId"), requestId);
            session->transcript().appendMessage(
                QStringLiteral("user"),
                input.value(QStringLiteral("message")).toString().trimmed().isEmpty()
                    ? session->translate()(QStringLiteral("session.imagePlaceholder"), QJsonObject{})
                    : input.value(QStringLiteral("message")).toString(),
                meta);
            session->tab().status = QStringLiteral("running");
            emitState();
            agentruntime::flushMessages(*session, hooksFor(*session));
        }

        QJsonObject payload{{QStringLiteral("message"), promptText}};
        if (input.value(QStringLiteral("description")).isString()) {
            payload.insert(QStringLiteral("description"), input.value(QStringLiteral("description")));
        }
        if (!images.isEmpty()) payload.insert(QStringLiteral("images"), images);
        if (!behavior.isEmpty()) payload.insert(QStringLiteral("streamingBehavior"), behavior);

        const QString agentId = target.agentId;
        // TTFT origin: the oracle records the sendPrompt time so queueing/pi startup is
        // part of the first-token latency instead of being hidden by event arrival.
        session->perf().promptRequested(nowMs());
        session->request(QStringLiteral("prompt"), payload, kPromptTimeoutMs,
                         [this, key, lease, target, agentId, sessionId, requestId, silent, statusBeforePrompt,
                          done](bool ok, const QJsonObject &response, const QString &error) {
                             // The lease only covers dispatch: once pi answered (accepted or
                             // rejected) the runtime must be replaceable again.
                             m_bindings.releaseLease(lease);
                             AgentSession *current = agent(agentId);
                             const bool accepted = ok
                                 && response.value(QStringLiteral("success")).toBool(false);
                             if (!current) {
                                 const QJsonObject result = rejectedResult(
                                     sessionId, requestId,
                                     QStringLiteral("Session runtime stopped during prompt dispatch"),
                                     true);
                                 settleDelivery(key, result);
                                 done(result);
                                 return;
                             }
                             if (!accepted) {
                                 const QString failure = !error.isEmpty()
                                     ? error
                                     : response.value(QStringLiteral("error")).toString(
                                           QStringLiteral("Prompt was rejected"));
                                 // `ok` means pi answered the prompt RPC: a rejected prompt is
                                 // provably not applied, so the renderer may retry. A transport
                                 // failure/timeout cannot prove anything — pi may already have
                                 // received the prompt — and must stay `unknown` so a retry can
                                 // never duplicate the user's message.
                                 const bool transportFailure = !ok;
                                 if (transportFailure) {
                                     current->setStatus(statusBeforePrompt == QLatin1String("running")
                                                            ? QStringLiteral("running")
                                                            : QStringLiteral("error"));
                                 } else {
                                     current->setStatus(statusBeforePrompt == QLatin1String("running")
                                                            ? QStringLiteral("running")
                                                            : QStringLiteral("idle"));
                                 }
                                 if (!silent) {
                                     current->transcript().appendLocalized(
                                         QStringLiteral("error"),
                                         transportFailure
                                             ? QStringLiteral("diagnostic.promptDeliveryUnknown")
                                             : QStringLiteral("diagnostic.promptRejected"),
                                         transportFailure
                                             ? QStringLiteral("The message delivery result is unknown. Check the current session before retrying to avoid sending it twice; restart the Agent if necessary.")
                                             : QStringLiteral("Message could not be sent."),
                                         QJsonObject{{QStringLiteral("debugDetails"), failure}});
                                     agentruntime::flushMessages(*current, hooksFor(*current));
                                 }
                                 QJsonObject result =
                                     rejectedResult(sessionId, requestId, failure, transportFailure);
                                 settleDelivery(key, result);
                                 done(result);
                                 return;
                             }
                             if (!current->tab().sessionPath.isEmpty()) {
                                 if (m_deps.services->catalog) {
                                     m_deps.services->catalog->attachRuntime(
                                         sessionId, current->tab().sessionPath,
                                         current->tab().piSessionId);
                                 }
                             }
                             QJsonObject result{
                                 {QStringLiteral("accepted"), true},
                                 {QStringLiteral("sessionId"), sessionId},
                                 {QStringLiteral("requestId"), requestId},
                                 {QStringLiteral("agentId"), agentId},
                                 {QStringLiteral("runtimeGeneration"),
                                  target.runtimeGeneration},
                             };
                             if (!current->tab().sessionPath.isEmpty()) {
                                 result.insert(QStringLiteral("sessionPath"),
                                               current->tab().sessionPath);
                             }
                             settleDelivery(key, result);
                             done(result);
                         });
    });
}

void Coordinator::stop(const QJsonObject &targetJson, std::function<void(QJsonObject)> done)
{
    Target target;
    CommandError error;
    if (!requireTarget(targetJson, &target, &error)) {
        done(errorResult(error));
        return;
    }
    AgentSession *session = agent(target.agentId);
    if (!session) {
        done(errorResult(CommandError::of(errorcode::kRuntimeUnavailable,
                                          QStringLiteral("Session runtime is not available"))));
        return;
    }
    CatalogEntry entry;
    const bool anonymous = m_deps.services->catalog
        && m_deps.services->catalog->get(target.sessionId, &entry) && entry.noSession;
    session->close();
    m_bindings.unbind(target.agentId);
    forgetAgent(target.agentId);
    clearPendingUi(target.sessionId);
    if (anonymous && m_deps.services->catalog) {
        m_deps.services->catalog->removeTransient(target.sessionId);
    }
    emitState();
    emitDetach(target);
    done(okResult(QJsonObject{
        {QStringLiteral("sessionId"), target.sessionId},
        {QStringLiteral("agentId"), target.agentId},
        {QStringLiteral("runtimeGeneration"), target.runtimeGeneration},
    }));
}

void Coordinator::restart(const QJsonObject &targetJson, std::function<void(QJsonObject)> done)
{
    Target target;
    CommandError error;
    if (!requireTarget(targetJson, &target, &error)) {
        done(errorResult(error));
        return;
    }
    CatalogEntry entry;
    if (!m_deps.services->catalog->get(target.sessionId, &entry)) {
        done(errorResult(CommandError::of(errorcode::kSessionNotFound,
                                          QStringLiteral("Session not found: %1").arg(target.sessionId))));
        return;
    }
    Bindings::Reservation reservation;
    try {
        reservation = m_bindings.beginReplacement(target.sessionId, target.agentId);
    } catch (const std::exception &failure) {
        done(errorResult(classifyFailure(QString::fromUtf8(failure.what()))));
        return;
    }
    if (!reservation.valid) {
        done(errorResult(CommandError::of(errorcode::kRuntimeChanged,
                                          QStringLiteral("Session runtime binding changed"))));
        return;
    }
    emitDetach(target);
    AgentSession *old = agent(target.agentId);
    if (old) {
        old->close();
        forgetAgent(target.agentId);
    }
    // The old process is gone: its pending asks can never be answered (oracle
    // `unbindAgentUnchecked` -> `clearPendingUiRequests`). The reservation stays held for
    // the whole handshake: it is the only thing that stops a concurrent activation from
    // spawning a second pi for this session (oracle `restartSession` keeps
    // `reserveBoundRuntime` until the new runtime is bound).
    clearPendingUi(target.sessionId);
    // Reuse the same session file: a restart replaces the process, not the session.
    CatalogEntry resume = entry;
    resume.id = target.sessionId;
    // Every failure exit runs through this: release the reservation first (a stuck
    // reservation would refuse every later activation) and reap the unbound process
    // without touching the durable catalog row, then settle the RPC exactly once.
    auto failed = [this, target, entry](const QString &agentId, const QString &message,
                                        std::function<void(QJsonObject)> finish) {
        m_bindings.finishReplacement(target.sessionId, target.agentId);
        discardFailedActivation(entry, agentId, /*dropTransientRecord=*/false);
        emitState();
        finish(errorResult(classifyFailure(message)));
    };
    createAgent(resume, [this, target, entry, failed, done](AgentSession *created, const QString &failure) {
        if (!created) {
            failed(QString(), failure, done);
            return;
        }
        const QString agentId = created->tab().id;
        created->request(QStringLiteral("get_state"), {}, kStateTimeoutMs,
                         [this, target, entry, agentId, failed, done](bool ok, const QJsonObject &response,
                                                              const QString &stateError) {
                             AgentSession *session = agent(agentId);
                             if (!session) {
                                 failed(agentId,
                                        QStringLiteral("Session runtime stopped during restart"), done);
                                 return;
                             }
                             if (!ok || !response.value(QStringLiteral("success")).toBool(false)) {
                                 const QString failure = !stateError.isEmpty()
                                     ? stateError
                                     : response.value(QStringLiteral("error")).toString(
                                           QStringLiteral("pi get_state failed"));
                                 session->markError(QStringLiteral("startup"));
                                 failed(agentId, failure, done);
                                 return;
                             }
                             const QJsonObject data = response.value(QStringLiteral("data")).toObject();
                             if (data.value(QStringLiteral("sessionFile")).isString()) {
                                 session->tab().sessionPath =
                                     data.value(QStringLiteral("sessionFile")).toString();
                             }
                             loadProjection(*session, [this, target, entry, agentId, failed, done](bool) {
                                 // Restart preserves startup's optional-history fallback.
                                 AgentSession *loaded = agent(agentId);
                                 if (!loaded || !loaded->running()) {
                                     failed(agentId,
                                            QStringLiteral("Session runtime stopped during restart"),
                                            done);
                                     return;
                                 }
                                 // Oracle `restartSession` -> `applyPreferences` before the new
                                 // binding is published: pi comes back with its startup defaults,
                                 // so the catalog model/thinking must be re-applied or the user
                                 // silently keeps running the historical model.
                                 applyPreferences(*loaded, entry, [this, target, entry, agentId, failed, done]() {
                                 AgentSession *ready = agent(agentId);
                                 if (!ready) {
                                     failed(agentId,
                                            QStringLiteral("Session runtime stopped during restart"),
                                            done);
                                     return;
                                 }
                                 int generation = 0;
                                 try {
                                     // Atomic commit: validates that this restart still owns the
                                     // reserved session and binds the new process in one step, so
                                     // the returned target can never be a stale success.
                                     generation = completeReplacement(target.sessionId, target.agentId,
                                                                      target.sessionId, agentId);
                                 } catch (const std::exception &failure) {
                                     failed(agentId, QString::fromUtf8(failure.what()), done);
                                     return;
                                 }
                                 ready->tab().runtimeGeneration = generation;
                                 ready->setStatus(QStringLiteral("idle"));
                                 // A --no-session runtime has no persisted identity to attach.
                                 if (!ready->tab().sessionPath.isEmpty() && !entry.noSession
                                     && m_deps.services->catalog) {
                                     m_deps.services->catalog->attachRuntime(
                                         target.sessionId, ready->tab().sessionPath,
                                         ready->tab().piSessionId);
                                 }
                                 publishState(*ready);
                                 // Re-flush after binding: the projection loaded above ran while
                                 // the runtime identity was still being replaced.
                                 agentruntime::flushMessages(*ready, hooksFor(*ready));
                                 const Target next{target.sessionId, agentId, generation};
                                 QJsonObject record;
                                 bool found = false;
                                 if (m_deps.services->catalog) {
                                     record = m_deps.services->catalog->getRecord(target.sessionId, &found);
                                 }
                                 done(okResult(QJsonObject{
                                     {QStringLiteral("previousTarget"),
                                      QJsonObject{
                                          {QStringLiteral("sessionId"), target.sessionId},
                                          {QStringLiteral("agentId"), target.agentId},
                                          {QStringLiteral("runtimeGeneration"),
                                           target.runtimeGeneration},
                                      }},
                                     {QStringLiteral("runtime"), runtimeInfoJson(next, ready->tab())},
                                     {QStringLiteral("session"), found ? record : QJsonObject{}},
                                 }));
                                 });
                             });
                         });
    });
}

void Coordinator::uiResponse(const QJsonObject &input, std::function<void(QJsonObject)> done)
{
    const QString sessionId = input.value(QStringLiteral("sessionId")).toString();
    const QString requestId = input.value(QStringLiteral("requestId")).toString();
    const QString agentId = input.value(QStringLiteral("agentId")).toString();
    const int generation = input.value(QStringLiteral("runtimeGeneration")).toInt();
    QString boundSession;
    int boundGeneration = 0;
    if (!m_bindings.bindingForAgent(agentId, &boundSession, &boundGeneration)
        || boundSession != sessionId || boundGeneration != generation
        || m_bindings.agentForSession(sessionId) != agentId) {
        done(errorResult(CommandError::of(
            errorcode::kRuntimeChanged,
            QStringLiteral("Session runtime binding changed before UI response"))));
        return;
    }
    const QString key = deliveryKey(sessionId, requestId);
    const auto pending = m_pendingUi.constFind(key);
    if (pending == m_pendingUi.constEnd()) {
        done(errorResult(CommandError::of(errorcode::kMessageNotFound,
                                          QStringLiteral("Session UI request is not pending"))));
        return;
    }
    AgentSession *session = agent(agentId);
    if (!session) {
        done(errorResult(CommandError::of(errorcode::kRuntimeUnavailable,
                                          QStringLiteral("Session runtime is not available"))));
        return;
    }
    const QJsonObject response = input.value(QStringLiteral("response")).toObject();
    QJsonObject payload{{QStringLiteral("id"), requestId}};
    if (response.contains(QStringLiteral("value"))) {
        payload.insert(QStringLiteral("value"), response.value(QStringLiteral("value")));
    }
    if (response.value(QStringLiteral("confirmed")).isBool()) {
        payload.insert(QStringLiteral("confirmed"), response.value(QStringLiteral("confirmed")));
    }
    if (response.value(QStringLiteral("cancelled")).toBool(false)) {
        payload.insert(QStringLiteral("cancelled"), true);
    }
    m_pendingUi.remove(key);
    session->pendingUi().remove(requestId);
    // Oracle `sendUIResponse` writes the frame raw: `id` is the *ask* id pi correlates
    // with its own pending UI, so tracking it as an RPC would never settle.
    QJsonObject frame = payload;
    frame.insert(QStringLiteral("type"), QStringLiteral("extension_ui_response"));
    session->notify(frame);
    // The renderer only closes the ask card on `completed` (session-atoms keeps both
    // `pending` and `responding` requests active). Without this event the overlay stays
    // busy with every button disabled even though pi already got the answer.
    QJsonObject completion{
        {QStringLiteral("agentId"), agentId},
        {QStringLiteral("requestId"), requestId},
        {QStringLiteral("completed"), true},
    };
    for (const char *field : {"value", "confirmed", "cancelled"}) {
        const QLatin1String name(field);
        if (payload.contains(name)) completion.insert(name, payload.value(name));
    }
    if (session->pendingUi().isEmpty()) session->setAskAborted(false);
    emitForAgent(agentId, QStringLiteral("agents:ui-request"), completion);
    done(okResult(QJsonValue(QJsonValue::Null)));
}

} // namespace runtime