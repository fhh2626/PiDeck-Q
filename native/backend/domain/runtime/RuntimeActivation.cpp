#include "RuntimeCoordinator.h"

#include "PiLaunch.h"

#include "../sessions/SessionCatalogStore.h"
#include "../sessions/SessionChannelSupport.h"

#include <QDateTime>
#include <QDir>
#include <QFileInfo>
#include <QJsonDocument>

#include <stdexcept>

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
        {QStringLiteral("delivery"), unknownDelivery ? QStringLiteral("unknown")
                                                     : QStringLiteral("rejected")},
        {QStringLiteral("error"), error},
        {QStringLiteral("i18nKey"), unknownDelivery ? QStringLiteral("diagnostic.promptDeliveryUnknown")
                                                    : QStringLiteral("diagnostic.promptRejected")},
        {QStringLiteral("debugDetails"), error},
        {QStringLiteral("sessionId"), sessionId},
        {QStringLiteral("requestId"), requestId},
    };
    return result;
}

} // namespace

void Coordinator::activate(const QString &sessionId, std::function<void(QJsonObject)> done)
{
    if (m_shutdown) {
        done(errorResult(CommandError::of(errorcode::kRuntimeUnavailable,
                                          QStringLiteral("Backend is shutting down"))));
        return;
    }
    if (deletionBlocks(sessionId)) {
        done(errorResult(CommandError::of(errorcode::kRuntimeChanged,
                                          QStringLiteral("Session deletion is in progress"))));
        return;
    }
    if (m_bindings.isReplacingSession(sessionId)) {
        // A replacement (restart/fork/clone) owns the session for its whole handshake:
        // creating a second pi here would answer with a success whose target a later bind
        // silently invalidates while both processes stay alive. Oracle `activate` refuses
        // with "Session runtime replacement reservation conflict".
        done(errorResult(CommandError::of(
            errorcode::kRuntimeChanged,
            QStringLiteral("Session runtime replacement reservation conflict: %1").arg(sessionId))));
        return;
    }
    if (m_bindings.isActivating(sessionId)) {
        // A pending activation owns the session; queue instead of spawning a second pi.
        m_activationWaiters[sessionId].append(std::move(done));
        return;
    }
    m_bindings.beginActivation(sessionId);
    runActivation(sessionId, [this, sessionId, done](QJsonObject result) {
        m_bindings.endActivation(sessionId);
        const QVector<std::function<void(QJsonObject)>> waiters = m_activationWaiters.take(sessionId);
        for (const auto &waiter : waiters) waiter(result);
        done(result);
    });
}

void Coordinator::runActivation(const QString &sessionId, std::function<void(QJsonObject)> done)
{
    CatalogEntry entry;
    if (!m_deps.services || !m_deps.services->catalog
        || !m_deps.services->catalog->get(sessionId, &entry)) {
        done(errorResult(CommandError::of(errorcode::kSessionNotFound,
                                          QStringLiteral("Session not found: %1").arg(sessionId))));
        return;
    }

    Target existing;
    if (m_bindings.targetForSession(sessionId, &existing)) {
        AgentSession *bound = agent(existing.agentId);
        const bool usable = bound && bound->running()
            && bound->tab().status != QLatin1String("closed")
            && bound->tab().status != QLatin1String("error");
        if (usable) {
            publishState(*bound);
            done(okResult(runtimeInfoJson(existing, bound->tab())));
            return;
        }
        // A terminal process cannot be reused; drop the binding before creating a new one.
        m_bindings.unbind(existing.agentId);
        forgetAgent(existing.agentId);
    }

    if (!entry.hasModel && modelSelectionError(sessionId) == QLatin1String("app.modelSelectionRequired")) {
        // Explicit activation must obey the same empty-default guard as prompt-driven
        // activation. Otherwise pi could choose another model before the next send.
        done(errorResult(CommandError::of(errorcode::kModelRequired,
                                          QStringLiteral("Model selection required"))));
        return;
    }

    createAgent(entry, [this, sessionId, entry, done](AgentSession *created, const QString &error) {
        if (!created) {
            // No process exists yet, but the transient record does.
            discardFailedActivation(entry, QString());
            done(errorResult(classifyFailure(error)));
            return;
        }
        const QString agentId = created->tab().id;
        created->request(QStringLiteral("get_state"), {}, kStateTimeoutMs,
                         [this, sessionId, agentId, entry, done](bool ok, const QJsonObject &response,
                                                           const QString &stateError) {
                             AgentSession *session = agent(agentId);
                             if (!session) {
                                 discardFailedActivation(entry, QString());
                                 done(errorResult(CommandError::of(
                                     errorcode::kRuntimeUnavailable,
                                     QStringLiteral("Session runtime stopped during activation"))));
                                 return;
                             }
                             if (!ok || !response.value(QStringLiteral("success")).toBool(false)) {
                                 const QString failure = !stateError.isEmpty()
                                     ? stateError
                                     : response.value(QStringLiteral("error")).toString(
                                           QStringLiteral("pi get_state failed"));
                                 session->markError(QStringLiteral("startup"));
                                 session->transcript().appendError(failure);
                                 discardFailedActivation(entry, agentId);
                                 done(errorResult(classifyFailure(failure)));
                                 return;
                             }
                             const QJsonObject data = response.value(QStringLiteral("data")).toObject();
                             session->observeModel(data.value(QStringLiteral("model")).toObject());
                             const QString projectPath = resolveProjectPath(entry.projectId);
                             if (data.value(QStringLiteral("sessionFile")).isString()
                                 && !data.value(QStringLiteral("sessionFile")).toString().isEmpty()) {
                                 session->tab().sessionPath = normalizeSessionPath(
                                     data.value(QStringLiteral("sessionFile")).toString(), projectPath);
                             }
                             // pi only reports the file it is writing once the first turn
                             // exists; an imported session already has one, so keep it.
                             if (session->tab().sessionPath.isEmpty() && !entry.filePath.isEmpty()) {
                                 session->tab().sessionPath =
                                     normalizeSessionPath(entry.filePath, projectPath);
                             }
                             if (deletionBlocksAgent(agentId)) {
                                 discardFailedActivation(entry, agentId);
                                 done(errorResult(CommandError::of(errorcode::kRuntimeChanged,
                                     QStringLiteral("Session deletion is in progress"))));
                                 return;
                             }
                             if (data.value(QStringLiteral("sessionId")).isString()) {
                                 session->tab().piSessionId =
                                     data.value(QStringLiteral("sessionId")).toString();
                             }
                             if (data.value(QStringLiteral("sessionName")).isString()
                                 && !data.value(QStringLiteral("sessionName")).toString().isEmpty()) {
                                 session->tab().title =
                                     data.value(QStringLiteral("sessionName")).toString();
                             }
                             loadProjection(*session, [this, sessionId, agentId, entry, done](bool) {
                                 // Startup keeps the existing empty-history fallback, but a
                                 // closed process must never be rebound as a ready runtime.
                                 AgentSession *loaded = agent(agentId);
                                 if (!loaded || !loaded->running()) {
                                     discardFailedActivation(entry, agentId);
                                     done(errorResult(CommandError::of(
                                         errorcode::kRuntimeUnavailable,
                                         QStringLiteral("Session runtime stopped during activation"))));
                                     return;
                                 }
                                 applyPreferences(*loaded, entry, [this, sessionId, agentId, entry, done]() {
                                     AgentSession *ready = agent(agentId);
                                     if (!ready) return;
                                     int generation = 0;
                                     try {
                                         persistRuntimeIdentity(sessionId, *ready);
                                         generation = bindSession(sessionId, agentId);
                                     } catch (const std::exception &failure) {
                                         discardFailedActivation(entry, agentId);
                                         done(errorResult(classifyFailure(
                                             QString::fromUtf8(failure.what()))));
                                         return;
                                     }
                                     ready->tab().runtimeGeneration = generation;
                                     ready->setStatus(QStringLiteral("idle"));
                                     publishState(*ready);
                                     // The initial transcript flush must follow the binding:
                                     // `agents:message` is enveloped with the runtime identity,
                                     // and the projection load above ran before it existed.
                                     agentruntime::flushMessages(*ready, hooksFor(*ready));
                                     const Target target{sessionId, agentId, generation};
                                     done(okResult(runtimeInfoJson(target, ready->tab())));
                                 });
                             }, true);
                         });
    });
}

void Coordinator::createAgent(const CatalogEntry &entry,
                              std::function<void(AgentSession *, const QString &)> done)
{
    const QString projectPath = resolveProjectPath(entry.projectId);
    if (projectPath.isEmpty()) {
        done(nullptr, QStringLiteral("Project not found: %1").arg(entry.projectId));
        return;
    }
    const QJsonObject settings = m_deps.settings ? m_deps.settings() : QJsonObject{};
    const QString agentId = QUuid::createUuid().toString(QUuid::WithoutBraces);

    pilaunch::Request request;
    request.settings = settings;
    request.resourcesDir = m_deps.resourcesDir;
    request.projectPath = projectPath;
    request.sessionPath = entry.filePath;
    request.noSession = entry.noSession;
    request.securitySessionId = entry.id;
    request.securitySnapshotPath = m_deps.securitySnapshotPath;
    request.uiLocale = m_deps.uiLocale ? m_deps.uiLocale() : QString();
    request.wslExe = m_deps.services ? m_deps.services->wslExe : QString();
    auto spawnWith = [this, entry, agentId, projectPath, done](const pilaunch::Launch &launch) {
        // Version probes can yield. Recheck the captured launch identity at the
        // last point before pi can open its file, not only the current catalog row.
        const QString identityError = launchIdentityError(entry, projectPath);
        if (!identityError.isEmpty()) {
            done(nullptr, identityError);
            return;
        }
        const CatalogEntry actual = deletionidentity::forLaunch(entry, launch);
        // A cached unrelated WSL alias may have been retargeted while deletion is
        // moving files. Existing bound runtimes remain usable; new writers wait
        // until the short mutation lease ends, including delayed version probes.
        if (deletionBlocksLaunch(entry) || deletionBlocksLaunch(actual)) {
            done(nullptr, QStringLiteral("Session deletion is in progress"));
            return;
        }
        if (!deletionidentity::compatibleLaunch(entry, actual)) {
            done(nullptr, QStringLiteral("Session runtime environment does not match the catalog"));
            return;
        }
        if (m_shutdown || deletionBlocksEntry(actual)) {
            done(nullptr, QStringLiteral("Session deletion is in progress"));
            return;
        }
        AgentSession::Options options;
        options.agentId = agentId;
        options.projectId = entry.projectId;
        options.cwd = projectPath;
        options.title = entry.title;
        options.deckSessionId = entry.id;
        options.sessionPath = entry.filePath;
        options.sessionEnvironment = actual.environment;
        options.sessionSource = entry.source;
        options.isInternalSubagent = entry.isInternalSubagent;
        options.wslDistro = actual.wslDistro;
        options.wslUser = actual.wslUser;
        options.importedSourceId = entry.importedSourceId;
        options.noSession = entry.noSession;
        options.launch = launch;
        options.translate = m_deps.services ? m_deps.services->translate : maincopy::Translator{};
        auto session = std::make_unique<AgentSession>(options);
        session->setChildRegistry(m_deps.services ? m_deps.services->children : nullptr);
        AgentSession *raw = session.get();
        // Every channel except the tab list is wrapped in the runtime-event envelope.
        agentruntime::Emit sink;
        sink.send = [this, agentId](const QString &channel, const QJsonValue &payload) {
            if (channel == QLatin1String("agents:state")) {
                emitState();
                return;
            }
            emitForAgent(agentId, channel, payload);
        };
        raw->setEmit(std::move(sink));
        // pi events and stderr are routed back through the coordinator so the
        // projector, pending-UI map and envelope all see the same session identity.
        raw->setEventSink([this, agentId](const QJsonObject &event) {
            AgentSession *current = agent(agentId);
            if (!current) return;
            // The Rust/Pi-Bolt lifecycle serializer is identified from `agent_start` before
            // the projector runs: it decides the settle-watchdog delay (250 ms vs 5 s).
            noteRuntimeKind(agentId, event);
            // Raw observers (LAN web stream) see the event *before* the desktop projector:
            // `agent_start` hands out the next run generation and the projector's
            // `openStream()` advances the counter right after, exactly like the oracle's
            // `emitLocalEvent` → `openAgentStream` order.
            publishPiEvent(agentId, *current, event);
            agentruntime::handlePiEvent(*current, event, hooksFor(*current));
            // A deferred projection can now read after message_end/agent_end, without
            // guessing which old image-only row owns an active empty skeleton.
            tryLoadProjection(agentId);
        });
        raw->setStderrSink([this, agentId](const QString &text) {
            emitForAgent(agentId, QStringLiteral("agents:log"), QJsonObject{
                {QStringLiteral("level"), QStringLiteral("stderr")},
                {QStringLiteral("text"), text},
            });
        });
        // RPC frames: the application sink applies the per-agent recording gate, writes
        // the daily JSONL and queues the ~80 ms `agents:rpc-log` batch.
        raw->setRpcLogSink([this, agentId](const QString &direction, const QJsonObject &data) {
            if (m_deps.recordRpcLog) m_deps.recordRpcLog(agentId, direction, data);
        });
        raw->setExitHandler([this, agentId](int code, const QString &reason) {
            AgentSession *current = agent(agentId);
            // Oracle `handleProcessExit`: a manual compact owns the exit. The compact
            // command itself reattaches the same agentId, so unbinding here would
            // invalidate the renderer's target mid-flight and force a pointless new
            // generation. The tab still reports `closed` until the reconnect succeeds.
            if (current && current->manualCompaction()) {
                current->tab().status = QStringLiteral("closed");
                emitState();
                // If compact already ACKed, its projection may be waiting for a
                // message boundary which this process can no longer deliver.
                tryLoadProjection(agentId);
                // A failed ACKed projection waits for this exit status; pending RPCs
                // are failed before the exit handler and cannot distinguish a clean exit.
                auto exit = m_compactProjectionExits.find(agentId);
                if (exit != m_compactProjectionExits.end()) {
                    auto complete = std::move(exit.value());
                    m_compactProjectionExits.erase(exit);
                    const bool recover = !m_shutdown && m_deps.post && code == 0 && current
                        && !current->tab().sessionPath.isEmpty() && !current->autoRestartAttempted();
                    complete(recover);
                    if (recover) return;
                }
                current = agent(agentId);
                if (current && current->manualCompaction()) return;
            }
            // A clean exit of a session that owns a file is normally pi restarting itself
            // (auto-compaction, model refresh). Oracle `handleProcessExit` reconnects the
            // same agentId once instead of dropping the runtime; the flag keeps a genuinely
            // broken pi from restarting in a loop. Shutdown owns its own teardown.
            if (!m_shutdown && current && code == 0 && !current->tab().sessionPath.isEmpty()
                && !current->autoRestartAttempted()) {
                current->setAutoRestartAttempted(true);
                const QString sessionId = m_bindings.sessionForAgent(agentId);
                const Target target{sessionId, agentId, m_bindings.generationForSession(sessionId)};
                current->tab().status = QStringLiteral("starting");
                emitState();
                // Deferred: the transport fails its pending RPCs *before* this handler runs,
                // so the reconnect must not begin on the exit signal's stack.
                auto restart = [this, agentId, target]() {
                    reattachProcess(agentId, target,
                                    [this, agentId, target](bool reattached, const QString &error, quint64 attemptEpoch) {
                                        AgentSession *latest = agent(agentId);
                                        QString boundSession;
                                        int generation = 0;
                                        if (!latest || attemptEpoch == 0 || latest->clientEpoch() != attemptEpoch
                                            || !m_bindings.bindingForAgent(agentId, &boundSession, &generation)
                                            || boundSession != target.sessionId || generation != target.runtimeGeneration) return;
                                        if (!reattached) {
                                            // Same teardown as any other dead process: the
                                            // renderer must not keep a target for it.
                                            latest->tab().status = QStringLiteral("closed");
                                            latest->transcript().appendLocalized(
                                                QStringLiteral("error"),
                                                QStringLiteral("diagnostic.processReconnectFailed"),
                                                QStringLiteral("Agent 进程意外退出，自动重连失败"),
                                                QJsonObject{});
                                            agentruntime::flushMessages(*latest, hooksFor(*latest));
                                            // Oracle `handleProcessExit` clears the per-agent state
                                            // before the final state frame; the detach below is
                                            // the C++ binding teardown, not a substitute.
                                            clearAgentRuntimeState(*latest);
                                            const QString sessionId =
                                                m_bindings.sessionForAgent(agentId);
                                            emitDetach(Target{sessionId, agentId,
                                                              m_bindings.generationForSession(sessionId)});
                                            m_bindings.unbind(agentId);
                                            tryLoadProjection(agentId);
                                            if (m_deps.disposeRpcLog) m_deps.disposeRpcLog(agentId);
                                            emitState();
                                            return;
                                        }
                                        latest->tab().status = QStringLiteral("idle");
                                        latest->transcript().appendLocalized(
                                            QStringLiteral("system"),
                                            QStringLiteral("diagnostic.compactReconnected"),
                                            QStringLiteral("会话压缩完成，Agent 已自动重连"),
                                            QJsonObject{});
                                        agentruntime::flushMessages(*latest, hooksFor(*latest));
                                        emitState();
                                    });
                };
                if (m_deps.post) m_deps.post(std::move(restart));
                else restart();
                return;
            }
            if (current) {
                current->tab().status = QStringLiteral("closed");
                // Oracle `handleProcessExit`: a terminal exit clears the per-agent state
                // (subagent rows get an empty snapshot, pending asks die, streaming flags
                // drop) *before* the last `agents:state` frame, so the renderer never keeps
                // a spinner, a yellow child dot or a dialog for a process that is gone.
                clearAgentRuntimeState(*current);
                // `emitState` delivers the closed envelope first; for a `--no-session`
                // runtime it already unbinds, removes the transient record and emits the
                // detach (oracle `emitSessionRuntimeEvent`). Re-check the binding before
                // the generic detach so that path cannot emit a second, empty-target
                // detach frame.
                emitState();
                QString sessionId;
                int generation = 0;
                if (m_bindings.bindingForAgent(agentId, &sessionId, &generation)) {
                    emitDetach(Target{sessionId, agentId, generation});
                }
            }
            m_bindings.unbind(agentId);
            tryLoadProjection(agentId);
            // A closed (or crashed) process produces no further frames; drop the
            // per-agent recording gate and any queued batch. The session object itself
            // must NOT be destroyed here: this runs on the client's own signal stack.
            if (m_deps.disposeRpcLog) m_deps.disposeRpcLog(agentId);
            Q_UNUSED(reason);
        });
        QString spawnError;
        if (!raw->spawn(&spawnError)) {
            done(nullptr, spawnError);
            return;
        }
        m_agents.emplace(agentId, std::move(session));
        done(raw, QString());
    };

    // Pi's RPC mode otherwise ignores project resources when no upstream decision is
    // stored. Approve this run automatically, gated by version for older Pi and Rust.
    const pilaunch::Launch probe = pilaunch::build(request);
    pilaunch::probeVersion(probe, m_versionProbes, [request, spawnWith](const QString &version) mutable {
        request.approveProjectResources = pilaunch::supportsProjectApprovalFlag(version);
        spawnWith(pilaunch::build(request));
    });
}
void Coordinator::applyPreferences(AgentSession &session, const CatalogEntry &entry,
                                   std::function<void()> done)
{
    const QString agentId = session.tab().id;
    // Model first (the thinking clamp is defined against it), then the thinking level,
    // which the oracle applies independently of whether a model is stored at all.
    if (!entry.hasModel || entry.modelProvider.isEmpty() || entry.modelId.isEmpty()) {
        applyThinkingPreference(session, entry, std::move(done));
        return;
    }
    session.request(QStringLiteral("set_model"),
                    QJsonObject{{QStringLiteral("provider"), entry.modelProvider},
                                {QStringLiteral("modelId"), entry.modelId}},
                    kStateTimeoutMs, [this, agentId, entry, done](bool ok, const QJsonObject &response,
                                                                 const QString &error) {
                        AgentSession *current = agent(agentId);
                        if (!current) return;
                        if (!ok || !response.value(QStringLiteral("success")).toBool(false)) {
                            // Preferences are advisory: a model that pi no longer has must
                            // not make the session unusable.
                            Q_UNUSED(error);
                            done();
                            return;
                        }
                        applyThinkingPreference(*current, entry, done);
                    });
}

void Coordinator::publishState(AgentSession &session)
{
    emitState();
    emitRuntimeState(session.tab().id);
    agentruntime::flushMessages(session, hooksFor(session));
}

} // namespace runtime
