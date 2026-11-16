#include "RuntimeCoordinator.h"

#include "DeliveryBudget.h"

#include "../ChannelRegistry.h"
#include "../logs/AppLogStore.h"
#include "../sessions/SessionCatalogStore.h"
#include "../sessions/SessionChannelSupport.h"
#include "../transport/EventHub.h"

namespace runtime {
namespace {

/** Same budget as the command channel: a poll must not outlive the RPC default. */
constexpr int kStateTimeoutMs = 30'000;

} // namespace

QJsonArray Coordinator::tabsJson() const
{
    QJsonArray tabs;
    // std::map keeps a stable key order so agents:state diffs stay meaningful.
    for (const auto &entry : m_agents) tabs.append(tabJson(entry.second->tab()));
    return tabs;
}

void Coordinator::emitState()
{
    if (!m_deps.services || !m_deps.services->events) return;
    const QJsonArray tabs = tabsJson();
    // The renderer's listener is `(tabs: AgentTab[])`, so the tab list must be the
    // single argument. `QJsonArray{tabsJson()}` would copy the array instead of
    // wrapping it (copy constructor wins over the initializer list), which spreads the
    // tabs into separate arguments and breaks every consumer.
    m_deps.services->events->broadcast(QStringLiteral("agents:state"),
                                       QJsonArray{QJsonValue(tabs)});
    // The desktop window never reads the raw array: its only runtime source is
    // `sessions:runtime-event` with `sourceChannel: "agents:state"` (oracle
    // `agentManager.onOutput` -> `runtimeBridge.emitSessionRuntimeEvent` per tab). Without
    // these envelopes a runtime activated after the one-shot listRuntimes() keeps
    // status='detached', the sidebar dot never lights and the agent inventory stays empty.
    for (const auto &entry : m_agents) {
        const QString agentId = entry.first;
        AgentSession *session = entry.second.get();
        if (!session) continue;
        QString sessionId;
        int generation = 0;
        if (!m_bindings.bindingForAgent(agentId, &sessionId, &generation)) continue;
        emitForAgent(agentId, QStringLiteral("agents:state"), tabJson(session->tab()));
        // A crashed `--no-session` runtime has no durable file to reopen. The oracle
        // delivers the closed state frame first (diagnostics stay visible for this tick)
        // and then unbinds + removes the transient record + emits detach; otherwise the
        // catalog/LAN surfaces keep exposing a dead anonymous session.
        if (!m_shutdown && session->tab().noSession
            && session->tab().status == QLatin1String("closed")) {
            emitDetach(Target{sessionId, agentId, generation});
            m_bindings.unbind(agentId);
            if (m_deps.services->catalog) m_deps.services->catalog->removeTransient(sessionId);
        }
    }
    // Observer after the broadcast: a LAN stream finishes when its runtime disappears
    // (killed process), and it must not see a half-updated tab table.
    for (const auto &observer : m_stateObservers) {
        if (observer) observer();
    }
}

void Coordinator::discardFailedActivation(const CatalogEntry &entry, const QString &agentId,
                                         bool dropTransientRecord)
{
    // Duty 1 — the process. The runtime came up but never bound, so nothing can ever reach
    // it again; it must be closed or every retry leaks one pi (oracle `waitUntilReady`
    // catch -> `agents.stop`). The teardown is deferred: this runs inside the runtime's own
    // RPC callback chain, and destroying the AgentSession would delete the client standing
    // on that stack (the oracle's `agents.stop` is asynchronous for the same reason).
    if (!agentId.isEmpty() && agent(agentId)) {
        auto teardown = [this, agentId]() {
            AgentSession *session = agent(agentId);
            if (!session) return;
            QString boundSession;
            int generation = 0;
            // A late cleanup must never unbind the new winner: if this agent somehow owns
            // a binding by now it is live, not garbage.
            if (m_bindings.bindingForAgent(agentId, &boundSession, &generation)) return;
            session->close();
            forgetAgent(agentId);
            // An `agents:state` subscriber may have seen the unbound tab while it was starting.
            emitState();
        };
        if (m_deps.post) m_deps.post(std::move(teardown));
        else teardown();
    }

    // Duty 2 — the catalog record. Only a `--no-session` record is transient: a file-backed
    // session keeps its catalog identity so the user can retry the very same row.
    if (!entry.noSession || !dropTransientRecord) return;
    if (m_deps.services && m_deps.services->catalog) {
        m_deps.services->catalog->removeTransient(entry.id);
    }
    // Oracle `failAnonymousActivation` pushes the refresh unconditionally: the renderer's
    // optimistic composer tab disappears only from this frame, because it swallows the
    // activation failure itself.
    if (m_deps.services) sessionchannels::notifyCatalogRefreshed(*m_deps.services, entry.projectId);
}

int Coordinator::addPiEventObserver(PiEventObserver observer)
{
    const int token = m_nextObserverId++;
    m_piObservers.insert(token, std::move(observer));
    return token;
}

int Coordinator::addStateObserver(std::function<void()> observer)
{
    const int token = m_nextObserverId++;
    m_stateObservers.insert(token, std::move(observer));
    return token;
}

void Coordinator::removeObserver(int token)
{
    m_piObservers.remove(token);
    m_stateObservers.remove(token);
}

void Coordinator::publishPiEvent(const QString &agentId, AgentSession &session,
                                 const QJsonObject &event)
{
    if (m_piObservers.isEmpty()) return;
    const QString type = event.value(QStringLiteral("type")).toString();
    // The online gate from `AgentManager.handlePiEvent`: after an abort, late deltas are
    // dropped, but the run boundaries (`agent_start` / `agent_settled`) always pass —
    // the stream needs them to replace or close the current run.
    const bool start = type == QLatin1String("agent_start");
    const bool settled = type == QLatin1String("agent_settled");
    if (!start && !settled && session.streamSealed()) return;
    // `agent_start` announces the next generation while the gate still holds the old
    // one; `openStream()` advances it immediately afterwards (inside handlePiEvent).
    const int generation = start ? session.runGeneration() + 1 : session.runGeneration();
    for (const auto &observer : m_piObservers) {
        if (observer) observer(agentId, event, generation);
    }
}

void Coordinator::emitForAgent(const QString &agentId, const QString &channel, const QJsonValue &payload)
{
    if (!m_deps.services || !m_deps.services->events) return;
    QString sessionId;
    int generation = 0;
    if (!m_bindings.bindingForAgent(agentId, &sessionId, &generation)) {
        // An ask that cannot be forwarded would leave pi blocked on a response that never
        // arrives (oracle `createBackend.onOutput` -> `cancelUnboundUiRequest`). The
        // cancellation is written to pi only; an unbound tab has no renderer card to close.
        if (channel == QLatin1String("agents:ui-request")) {
            cancelUnboundUiRequest(agentId, payload.toObject());
        }
        return;
    }
    QJsonObject event{
        {QStringLiteral("kind"), QStringLiteral("event")},
        {QStringLiteral("sessionId"), sessionId},
        {QStringLiteral("agentId"), agentId},
        {QStringLiteral("runtimeGeneration"), generation},
        {QStringLiteral("sourceChannel"), channel},
        {QStringLiteral("payload"), payload},
    };
    if (channel == QLatin1String("agents:message") && payload.isObject()) {
        // A transcript with many images can exceed the native frame limit. The oracle
        // measures the *sent* envelope (`{channel,args:[event]}`), so the wrapper here is
        // byte-identical to what EventHub broadcasts. Per-message offload stops as soon
        // as it fits again, so the newest images survive.
        const auto wrap = [&event](const QJsonObject &candidate) {
            QJsonObject envelope = event;
            envelope.insert(QStringLiteral("payload"), candidate);
            return QJsonObject{{QStringLiteral("channel"), QStringLiteral("sessions:runtime-event")},
                               {QStringLiteral("args"), QJsonArray{QJsonValue(envelope)}}};
        };
        const deliverybudget::Outcome budget = deliverybudget::enforcePayload(
            payload.toObject(), wrap, deliverybudget::configuredMaxBytes());
        if (!budget.ok) {
            // Even after stripping every image the envelope does not fit. The oracle does
            // not send the oversized event: it publishes a blocked status so the renderer
            // can tell the user why the timeline stopped updating.
            QJsonObject blocked = event;
            blocked.insert(QStringLiteral("sourceChannel"),
                           QStringLiteral("sessions:message-delivery-status"));
            blocked.insert(QStringLiteral("payload"),
                           QJsonObject{{QStringLiteral("status"), QStringLiteral("blocked")},
                                       {QStringLiteral("code"), budget.code}});
            m_deps.services->events->broadcast(QStringLiteral("sessions:runtime-event"),
                                               QJsonArray{blocked});
            return;
        }
        event.insert(QStringLiteral("payload"), budget.value);
    }
    if (channel == QLatin1String("agents:ui-request")) {
        const QJsonObject request = payload.toObject();
        AgentSession *session = agent(agentId);
        // A completion is not a new ask: re-registering it would resurrect the pending
        // request the caller just closed (abort / timeout / answered).
        if (session && !request.value(QStringLiteral("completed")).toBool(false)) {
            const auto pending =
                session->pendingUi().constFind(request.value(QStringLiteral("requestId")).toString());
            if (pending != session->pendingUi().constEnd()) {
                observeUiRequest(Target{sessionId, agentId, generation}, *pending);
            }
        }
    }
    m_deps.services->events->broadcast(QStringLiteral("sessions:runtime-event"), QJsonArray{event});
}

void Coordinator::cancelUnboundUiRequest(const QString &agentId, const QJsonObject &request)
{
    static const QStringList kDialogMethods{QStringLiteral("select"), QStringLiteral("confirm"),
                                            QStringLiteral("input"), QStringLiteral("editor"),
                                            QStringLiteral("batch_ask")};
    const QString requestId = request.value(QStringLiteral("requestId")).toString();
    if (requestId.isEmpty() || request.value(QStringLiteral("completed")).toBool(false)) return;
    if (!kDialogMethods.contains(request.value(QStringLiteral("method")).toString())) return;
    AgentSession *session = agent(agentId);
    if (!session) return;
    session->pendingUi().remove(requestId);
    QJsonObject frame{{"type", "extension_ui_response"}, {"id", requestId}, {"cancelled", true}};
    session->notify(frame);
    if (m_deps.services->appLog) {
        m_deps.services->appLog->write(QStringLiteral("warn"), QStringLiteral("session"),
                                       QStringLiteral("Cancelled unbound runtime UI request"),
                                       QJsonObject{{"agentId", agentId},
                                                   {"requestId", requestId},
                                                   {"method", request.value(QStringLiteral("method"))}});
    }
}

void Coordinator::emitNoticeForSession(const QString &sessionId, const QString &agentId,
                                       const QJsonObject &payload)
{
    if (!m_deps.services || !m_deps.services->events) return;
    QString boundSessionId;
    int generation = 0;
    // Bound runtime: the notice must carry the *current* generation so the renderer can
    // attribute it to the runtime the user is looking at. Unbound (activation): the
    // oracle sends generation 0 because the binding is created after applyPreferences.
    if (!m_bindings.bindingForAgent(agentId, &boundSessionId, &generation)
        || boundSessionId != sessionId) {
        generation = 0;
    }
    const QJsonObject event{
        {QStringLiteral("kind"), QStringLiteral("event")},
        {QStringLiteral("sessionId"), sessionId},
        {QStringLiteral("agentId"), agentId},
        {QStringLiteral("runtimeGeneration"), generation},
        {QStringLiteral("sourceChannel"), QStringLiteral("agents:notice")},
        {QStringLiteral("payload"), payload},
    };
    m_deps.services->events->broadcast(QStringLiteral("sessions:runtime-event"), QJsonArray{event});
}

void Coordinator::emitDetach(const Target &target)
{
    if (!m_deps.services || !m_deps.services->events) return;
    QJsonObject event{
        {QStringLiteral("kind"), QStringLiteral("detach")},
        {QStringLiteral("sessionId"), target.sessionId},
        {QStringLiteral("agentId"), target.agentId},
        {QStringLiteral("runtimeGeneration"), target.runtimeGeneration},
        {QStringLiteral("sourceChannel"), QStringLiteral("sessions:runtime-detach")},
        {QStringLiteral("payload"), QJsonValue(QJsonValue::Null)},
    };
    m_deps.services->events->broadcast(QStringLiteral("sessions:runtime-event"), QJsonArray{event});
}

void Coordinator::emitRuntimeState(const QString &agentId)
{
    AgentSession *session = agent(agentId);
    if (!session) return;
    session->request(QStringLiteral("get_state"), {}, kStateTimeoutMs,
                     [this, agentId](bool ok, const QJsonObject &response, const QString &) {
                         AgentSession *current = agent(agentId);
                         if (!current) return;
                         const QJsonObject state = ok ? response.value(QStringLiteral("data")).toObject()
                                                      : QJsonObject{};
                         current->request(QStringLiteral("get_session_stats"), {}, kStateTimeoutMs,
                                          [this, agentId, state](bool statsOk, const QJsonObject &statsResponse,
                                                                 const QString &) {
                                              AgentSession *latest = agent(agentId);
                                              if (!latest) return;
                                              const QJsonObject stats = statsOk
                                                  ? statsResponse.value(QStringLiteral("data")).toObject()
                                                  : QJsonObject{};
                                              emitForAgent(agentId, QStringLiteral("agents:runtime-state"),
                                                           QJsonObject{
                                                               {QStringLiteral("agentId"), agentId},
                                                               {QStringLiteral("state"),
                                                                buildRuntimeState(state, stats, *latest)},
                                                           });
                                          });
                     });
}

QJsonObject Coordinator::buildRuntimeState(const QJsonObject &state, const QJsonObject &stats,
                                           AgentSession &session)
{
    const QString sessionPath = session.tab().sessionPath;
    const cachehit::Stats cacheHits = sessionPath.isEmpty() ? cachehit::Stats{}
                                                            : m_cacheHits.read(sessionPath);
    // Oracle `getRuntimeState`: `isCompacting = state.isCompacting || rpcCompactingAgents ||
    // compactingAgents`. `manualCompaction()` is `compactingAgents` (the RPC in flight) and
    // `manualCompactionEvent()` is the flag fed by *every* `compaction_start` — the local
    // image of `rpcCompactingAgents`. Passing only the former made an auto compaction (and
    // the duplicate-request answer that reports it) claim `isCompacting:false` even though
    // pi was rewriting the context.
    return runtimeStateJson(state, stats, session.tab(),
                            session.manualCompaction() || session.manualCompactionEvent(), cacheHits,
                            session.perf().last());
}

EventHooks Coordinator::hooksFor(AgentSession &session)
{
    EventHooks hooks;
    const QString agentId = session.tab().id;
    hooks.send = [this, agentId](const QString &channel, const QJsonValue &payload) {
        if (channel == QLatin1String("agents:state")) {
            emitState();
            return;
        }
        emitForAgent(agentId, channel, payload);
    };
    hooks.emitState = [this]() { emitState(); };
    hooks.emitRuntimeState = [this, agentId]() { emitRuntimeState(agentId); };
    hooks.reloadMessages = [this, agentId](bool preserveHistory) {
        AgentSession *current = agent(agentId);
        if (!current) return;
        loadProjection(*current, [this, agentId](bool projected) {
            AgentSession *latest = agent(agentId);
            if (!projected || !latest || !latest->running()) return;
            agentruntime::flushMessages(*latest, hooksFor(*latest));
        });
        Q_UNUSED(preserveHistory);
    };
    hooks.uiRequest = [this, agentId](const AgentSession::PendingUi &request) {
        Q_UNUSED(agentId);
        Q_UNUSED(request);
        // Pending registration happens in emitForAgent (it needs the binding).
    };
    hooks.uiRequestClosed = [this, agentId](const QString &requestId) {
        QString sessionId;
        int generation = 0;
        if (!m_bindings.bindingForAgent(agentId, &sessionId, &generation)) return;
        Q_UNUSED(generation);
        // The session-level map already dropped it; the coordinator copy must go too, or
        // a late renderer answer would pass the "is pending" check and be forwarded to a
        // pi request that no longer exists.
        m_pendingUi.remove(deliveryKey(sessionId, requestId));
    };
    hooks.settled = [this, agentId](bool abortSettled) {
        // A settled event can be the first safe boundary when pi omitted message_end.
        tryLoadProjection(agentId);
        AgentSession *current = agent(agentId);
        if (!current) return;
        current->refreshFileVersion();
        if (!m_deps.notifySessionSettled) return;
        // AgentManager's completion gate: only a turn that settled outside error/closed,
        // whose last row is the assistant's answer, that the user did not abort, and that
        // is a user-visible session may raise the "completed its response" toast.
        const bool completed = current->tab().status == QLatin1String("idle");
        const bool lastAssistant = current->transcript().lastMessageRole() == QLatin1String("assistant");
        if (!completed || !lastAssistant || abortSettled || current->tab().isInternalSubagent) return;
        m_deps.notifySessionSettled(agentId, current->tab().title, m_bindings.sessionForAgent(agentId));
    };
    hooks.runStarted = [this, agentId]() {
        if (m_deps.noteRunStarted) m_deps.noteRunStarted(agentId);
    };
    hooks.armSettleWatchdog = [this, agentId](agentruntime::SettleWatchdog reason) {
        scheduleSettledWatchdog(agentId, reason);
    };
    // Only the coordinator knows the project catalog; the UI-request handler needs it to
    // resolve a project-relative `ownerSessionId` before the session-identity comparison.
    hooks.projectPath = [this](const QString &projectId) { return resolveProjectPath(projectId); };
    return hooks;
}

} // namespace runtime
