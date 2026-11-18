#include "RuntimeCoordinator.h"

#include "RuntimeNotices.h"

#include "../sessions/SessionCatalogStore.h"

#include <QDateTime>
#include <QJsonArray>
#include <QJsonDocument>
#include <QTimer>

namespace runtime {
namespace {

constexpr int kStateTimeoutMs = 30'000;
constexpr int kLongCommandTimeoutMs = 120'000;
/**
 * Oracle `abort()`: the fire-and-forget `abort` RPC gets 10 s.
 *
 * It is not the generic 30 s state budget: the result is swallowed either way, and a wedged
 * pi must not keep the request slot (and the stop's escalation fence) alive three times as
 * long as the oracle does.
 */
constexpr int kAbortRequestTimeoutMs = 10'000;
/** `AgentManager.ABORT_SETTLED_FALLBACK_MS`: when the abort's settled event is late. */
constexpr int kAbortSettledFallbackMs = 1'500;
/** `AgentManager.ABORT_ESCALATION_VERIFY_MS`: after the second abort, warn the user. */
constexpr int kAbortEscalationVerifyMs = 4'000;
constexpr int kAbortEscalationTimeoutMs = 5'000;

/** A removed model needs a new selection. An edited snapshot uses the agent restart flow. */
QString modelConfigurationFailure(const AgentSession *session, const QString &provider, const QString &modelId)
{
    if (!session) return QStringLiteral("Session runtime binding changed");
    if (session->wasModelRemoved(provider, modelId)) return QStringLiteral("Model selection required");
    if (session->hasStaleModelConfiguration(provider, modelId)) {
        return QStringLiteral("Model not found: %1/%2").arg(provider, modelId);
    }
    return {};
}

QJsonArray parseModels(bool ok, const QJsonObject &response, QString *error)
{
    if (!ok || !response.value(QStringLiteral("success")).toBool(false)) {
        *error = response.value(QStringLiteral("error")).toString(
            QStringLiteral("get_available_models failed"));
        return {};
    }
    const QJsonValue data = response.value(QStringLiteral("data"));
    if (!data.isObject()) return {};
    const QJsonArray models = data.toObject().value(QStringLiteral("models")).toArray();
    QJsonArray result;
    for (const QJsonValue &value : models) {
        if (!value.isObject()) continue;
        const QJsonObject model = value.toObject();
        const QString id = model.value(QStringLiteral("id")).toString();
        const QString provider = model.value(QStringLiteral("provider")).toString();
        if (id.isEmpty() || provider.isEmpty()) continue;
        QJsonObject entry{
            {QStringLiteral("id"), id},
            {QStringLiteral("provider"), provider},
        };
        for (const char *key : {"name", "contextWindow", "maxTokens", "reasoning", "images"}) {
            const QJsonValue field = model.value(QLatin1String(key));
            if (field.isUndefined() || field.isNull()) continue;
            entry.insert(QLatin1String(key), field);
        }
        result.append(entry);
    }
    return result;
}

} // namespace

void Coordinator::state(const QJsonObject &target, std::function<void(QJsonObject)> done)
{
    // The renderer types this channel as `SessionCommandResult<SessionTargetedValue<
    // AgentRuntimeState>>` (desktopApi.getRuntimeState), and the oracle resolves it through
    // `SessionRuntimeCoordinator.getRuntimeState` → `AgentManager.getRuntimeState`, i.e. the
    // same projection `agents:runtime-state` publishes. Returning pi's raw `get_state` data
    // here used to leak a different shape through a typed channel.
    runTarget(target, [this](AgentSession &session, const Target &binding, CommandDone finish) {
        Q_UNUSED(session);
        fetchRuntimeState(binding.agentId, [finish](const QJsonObject &state) {
            finish(true, state, QString());
        });
    }, std::move(done));
}

void Coordinator::commands(const QJsonObject &target, std::function<void(QJsonObject)> done)
{
    runTarget(target, [](AgentSession &session, const Target &, CommandDone finish) {
        session.request(QStringLiteral("get_commands"), {}, kStateTimeoutMs,
                        [finish](bool ok, const QJsonObject &response, const QString &error) {
                            if (!ok || !response.value(QStringLiteral("success")).toBool(false)) {
                                finish(false, QJsonValue(),
                                       error.isEmpty()
                                           ? response.value(QStringLiteral("error")).toString(
                                                 QStringLiteral("get_commands failed"))
                                           : error);
                                return;
                            }
                            const QJsonArray commands = response.value(QStringLiteral("data"))
                                                            .toObject()
                                                            .value(QStringLiteral("commands"))
                                                            .toArray();
                            finish(true, commands, QString());
                        });
    }, std::move(done));
}

void Coordinator::models(const QJsonObject &target, std::function<void(QJsonObject)> done)
{
    runTarget(target, [](AgentSession &session, const Target &, CommandDone finish) {
        session.request(QStringLiteral("get_available_models"), {}, kLongCommandTimeoutMs,
                        [finish](bool ok, const QJsonObject &response, const QString &error) {
                            QString failure;
                            const QJsonArray models = parseModels(ok, response, &failure);
                            if (!failure.isEmpty()) {
                                finish(false, QJsonValue(), failure);
                                return;
                            }
                            finish(true, models, QString());
                        });
    }, std::move(done));
}

void Coordinator::exportHtml(const QJsonObject &target, std::function<void(QJsonObject)> done)
{
    runTarget(target, [](AgentSession &session, const Target &, CommandDone finish) {
        session.request(QStringLiteral("export_html"), {}, kLongCommandTimeoutMs,
                        [finish](bool ok, const QJsonObject &response, const QString &error) {
                            if (!ok || !response.value(QStringLiteral("success")).toBool(false)) {
                                finish(false, QJsonValue(),
                                       error.isEmpty()
                                           ? response.value(QStringLiteral("error")).toString(
                                                 QStringLiteral("export_html failed"))
                                           : error);
                                return;
                            }
                            finish(true, response.value(QStringLiteral("data")), QString());
                        });
    }, std::move(done));
}

void Coordinator::flushMessages(const QJsonObject &target, std::function<void(QJsonObject)> done)
{
    runTarget(target, [this](AgentSession &session, const Target &, CommandDone finish) {
        agentruntime::flushMessages(session, hooksFor(session));
        finish(true, QJsonValue(QJsonValue::Null), QString());
    }, std::move(done));
}

void Coordinator::abort(const QJsonObject &target, std::function<void(QJsonObject)> done)
{
    runTarget(target, [this](AgentSession &session, const Target &binding, CommandDone finish) {
        const QString agentId = session.tab().id;
        session.setRecentlyAborted(true);
        session.sealStream();
        // Cancel pending interactive requests: pi blocks on them and the user aborted.
        const QStringList requestIds = session.pendingUi().keys();
        // Drop the session view first: the completion frames below must not be able to
        // re-register the request as pending.
        session.pendingUi().clear();
        for (const QString &requestId : requestIds) {
            // `value:null` WITHOUT `cancelled`, exactly like the oracle: pi turns
            // `cancelled:true` into `undefined` and `ask_question` then falls back to the
            // first option, so aborting would silently answer the user's question for them.
            session.notify(QJsonObject{
                {QStringLiteral("type"), QStringLiteral("extension_ui_response")},
                {QStringLiteral("id"), requestId},
                {QStringLiteral("value"), QJsonValue(QJsonValue::Null)},
            });
            m_pendingUi.remove(deliveryKey(binding.sessionId, requestId));
            // The extension keeps its cancellation semantics; the renderer needs its own
            // completion event or the ask card stays `responding` with disabled buttons.
            emitForAgent(agentId, QStringLiteral("agents:ui-request"),
                         QJsonObject{{QStringLiteral("agentId"), agentId},
                                     {QStringLiteral("requestId"), requestId},
                                     {QStringLiteral("completed"), true},
                                     {QStringLiteral("cancelled"), true}});
        }
        session.setAskAborted(true);
        // Abort closes the live channels like the oracle: a leftover thinking bubble is
        // published as done and pending text/message frames are dropped (the transcript
        // already owns what the user has seen).
        session.liveChannels().settle();
        // A stopped turn owns no tool call any more. Dropping the aggregate and publishing
        // the `false` edge here (oracle `abort` → `emitToolRuntimeTransition(false)`) keeps
        // the renderer's tool spinner from surviving the stop, and stops the settle
        // watchdog / manual-compaction gate from waiting for a call that can never end.
        if (!session.activeToolCalls().isEmpty() || session.tab().isExecutingTool) {
            session.activeToolCalls().clear();
            session.tab().isExecutingTool = false;
            session.tab().executingToolName.clear();
            session.tab().toolStateSequence += 1;
            emitForAgent(agentId, QStringLiteral("agents:runtime-state"),
                         QJsonObject{{QStringLiteral("agentId"), agentId},
                                     {QStringLiteral("state"),
                                      QJsonObject{{
                                          QStringLiteral("isExecutingTool"), false},
                                          {QStringLiteral("toolStateSequence"),
                                           session.tab().toolStateSequence}}}});
        }
        // Oracle `abort()`: the abort RPC is fire-and-forget (`request({type:"abort"}, 10_000)`
        // + `.catch(() => {})`) and the local teardown never waits for pi's answer. A tool that
        // blocks pi's event loop may never answer at all — the documented motivating case — and
        // the user's stop must not depend on it; `scheduleAbortEscalation` owns the delayed
        // `abort_bash` retry. A failed/timed-out RPC must not surface as a command error
        // either, because from the renderer's point of view the runtime already stopped.
        session.request(QStringLiteral("abort"), {}, kAbortRequestTimeoutMs,
                        [](bool, const QJsonObject &, const QString &) {});
        // Local teardown, exactly like the oracle: the streaming/tool state is cleared and
        // the tab goes `idle` immediately (also from `error`), before pi answers.
        session.tab().isStreaming = false;
        session.tab().isExecutingTool = false;
        session.tab().executingToolName.clear();
        session.tab().status = QStringLiteral("idle");
        emitState();
        // Immediate feedback, exactly like the oracle: the toast is emitted after the abort
        // frame is written and does not wait for pi's answer (a blocked tool may never
        // answer). `emitForAgent` still attributes it to the bound runtime generation.
        emitForAgent(agentId, QStringLiteral("agents:notice"), notices::abortRequested(agentId));
        // Abort may be ignored by a tool that blocks pi's event loop; the escalation owns
        // the `abort_bash` retry and the final "stop is slow" warning.
        scheduleAbortEscalation(agentId, session.clientEpoch(), session.runGeneration());
        finish(true, QJsonValue(QJsonValue::Null), QString());
    }, std::move(done));
}

void Coordinator::scheduleAbortEscalation(const QString &agentId, quint64 clientEpoch,
                                         int sealedGeneration)
{
    AgentSession *session = agent(agentId);
    QObject *context = session ? session->timerContext() : nullptr;
    if (!context) return;
    QTimer::singleShot(kAbortSettledFallbackMs, context,
                       [this, agentId, clientEpoch, sealedGeneration]() {
                           AgentSession *current = agent(agentId);
                           // A replaced transport or a disposed runtime owns the stop now;
                           // escalating here would act on a process the user no longer sees.
                           if (!current || current->clientEpoch() != clientEpoch) return;
                           // The settled event never arrived: unseal the gate so the next
                           // prompt can stream (oracle `scheduleAbortSettledFallback`).
                           const bool pendingOpen = current->pendingOpenAfterSettled();
                           if (current->waitingForAbortSettled()) current->noteAbortSettled();
                           // A new run already started before the abort settled: only the
                           // gate needed unsealing, aborting again would kill the new run.
                           if (pendingOpen) return;
                           escalateAbortIfStillRunning(agentId, clientEpoch, sealedGeneration);
                       });
}

void Coordinator::escalateAbortIfStillRunning(const QString &agentId, quint64 clientEpoch,
                                             int sealedGeneration)
{
    AgentSession *session = agent(agentId);
    if (!session || session->clientEpoch() != clientEpoch) return;
    if (session->runGeneration() != sealedGeneration) return;
    session->request(
        QStringLiteral("get_state"), {}, kAbortEscalationTimeoutMs,
        [this, agentId, clientEpoch, sealedGeneration](bool ok, const QJsonObject &response,
                                                      const QString &) {
            AgentSession *current = agent(agentId);
            if (!current || current->clientEpoch() != clientEpoch) return;
            if (current->runGeneration() != sealedGeneration) return;
            const bool streaming =
                ok && response.value(QStringLiteral("success")).toBool(false)
                && response.value(QStringLiteral("data"))
                       .toObject()
                       .value(QStringLiteral("isStreaming"))
                       .toBool(false);
            if (!streaming) return; // pi already stopped: nothing to escalate
            current->request(
                QStringLiteral("abort_bash"), {}, kAbortEscalationTimeoutMs,
                [this, agentId, clientEpoch, sealedGeneration](bool, const QJsonObject &, const QString &) {
                    AgentSession *after = agent(agentId);
                    if (!after || after->clientEpoch() != clientEpoch) return;
                    if (after->runGeneration() != sealedGeneration) return;
                    after->request(
                        QStringLiteral("abort"), {}, kAbortEscalationTimeoutMs,
                        [this, agentId](bool, const QJsonObject &, const QString &) {
                            AgentSession *verify = agent(agentId);
                            QObject *context = verify ? verify->timerContext() : nullptr;
                            if (!context) return;
                            // Oracle semantics: after the second abort the desktop waits
                            // the verify window and then warns unconditionally. A runtime
                            // that was stopped/bound elsewhere has no binding, and
                            // `emitForAgent` drops the toast for it (same as the oracle's
                            // bridge returning false for an unbound agent).
                            QTimer::singleShot(kAbortEscalationVerifyMs, context, [this, agentId]() {
                                if (!agent(agentId)) return;
                                emitForAgent(agentId, QStringLiteral("agents:notice"),
                                             notices::abortSlow(agentId));
                            });
                        });
                });
        });
}

void Coordinator::getForkMessages(const QJsonObject &target, std::function<void(QJsonObject)> done)
{
    runTarget(target, [](AgentSession &session, const Target &, CommandDone finish) {
        session.request(QStringLiteral("get_fork_messages"), {}, kStateTimeoutMs,
                        [finish](bool ok, const QJsonObject &response, const QString &error) {
                            if (!ok || !response.value(QStringLiteral("success")).toBool(false)) {
                                finish(false, QJsonValue(),
                                       error.isEmpty()
                                           ? response.value(QStringLiteral("error")).toString(
                                                 QStringLiteral("get_fork_messages failed"))
                                           : error);
                                return;
                            }
                            const QJsonArray messages = response.value(QStringLiteral("data"))
                                                            .toObject()
                                                            .value(QStringLiteral("messages"))
                                                            .toArray();
                            finish(true, messages, QString());
                        });
    }, std::move(done));
}

void Coordinator::setModel(const QJsonObject &target, const QString &provider, const QString &modelId,
                           std::function<void(QJsonObject)> done)
{
    runTarget(target, [this, provider, modelId](AgentSession &session, const Target &binding,
                                                CommandDone finish) {
        const QString configurationError = modelConfigurationFailure(&session, provider, modelId);
        if (!configurationError.isEmpty()) {
            // The id may still exist, but its current definition is absent from this
            // process's snapshot. Reuse the explicit per-agent restart confirmation.
            finish(false, QJsonValue(), configurationError);
            return;
        }
        // Read the user's stored level *before* the switch: pi may reset the level as a
        // side effect, and that transient value must never become the user preference.
        CatalogEntry before;
        const bool hasBefore = m_deps.services && m_deps.services->catalog
            && m_deps.services->catalog->get(binding.sessionId, &before);
        session.request(QStringLiteral("set_model"),
                        QJsonObject{{QStringLiteral("provider"), provider},
                                    {QStringLiteral("modelId"), modelId}},
                        kStateTimeoutMs,
                        [this, binding, provider, modelId, hasBefore, before, finish](
                            bool ok, const QJsonObject &response, const QString &error) {
                            if (!ok || !response.value(QStringLiteral("success")).toBool(false)) {
                                finish(false, QJsonValue(),
                                       error.isEmpty()
                                           ? response.value(QStringLiteral("error")).toString(
                                                 QStringLiteral("set_model failed"))
                                           : error);
                                return;
                            }
                            const QString configurationError = modelConfigurationFailure(agent(binding.agentId), provider, modelId);
                            if (!configurationError.isEmpty()) {
                                finish(false, QJsonValue(), configurationError);
                                return;
                            }
                            if (m_deps.services->catalog) {
                                m_deps.services->catalog->update(
                                    binding.sessionId,
                                    QJsonObject{{QStringLiteral("model"),
                                                 QJsonObject{{QStringLiteral("provider"), provider},
                                                             {QStringLiteral("modelId"), modelId}}},
                                                {QStringLiteral("updatedAt"),
                                                 static_cast<double>(QDateTime::currentMSecsSinceEpoch())}});
                            }
                            // `setRuntimeModel` alignment: an extended level the new model
                            // does not declare is clamped to high, and pi's own reset is
                            // undone when the model still declares the level.
                            const QJsonObject data = response.value(QStringLiteral("data")).toObject();
                            const QString runtimeLevel =
                                data.value(QStringLiteral("thinkingLevel")).toString();
                            const QString requested = hasBefore && before.hasThinkingLevel
                                ? before.thinkingLevel
                                : runtimeLevel;
                            alignThinkingAfterModelChange(binding.sessionId, binding.agentId,
                                                          requested, provider, modelId,
                                                          runtimeLevel, [this, binding, provider, modelId, finish]() {
                                                              emitState();
                                                              // The channel is typed
                                                              // `SessionCommandResult<SessionTargetedValue<
                                                              // AgentRuntimeState>>` on the renderer
                                                              // (`desktopApi.sessions.setRuntimeModel`, consumed at
                                                              // ComposerPickerHost's `applyRuntimeModelState`).
                                                              // Oracle `setRuntimeModel` therefore resolves with
                                                              // `adjustedState ?? getRuntimeState(agentId)`; pi's raw
                                                              // `set_model` data is a different shape (`{model}` only)
                                                              // and would leave the model name, provider and the
                                                              // cache-hit/perf rows stale until the next state event.
                                                              fetchRuntimeState(
                                                                  binding.agentId,
                                                                  [this, binding, provider, modelId, finish](const QJsonObject &state) {
                                                                      const QString failure = modelConfigurationFailure(agent(binding.agentId), provider, modelId);
                                                                      if (!failure.isEmpty()) {
                                                                          finish(false, QJsonValue(), failure);
                                                                          return;
                                                                      }
                                                                      finish(true, state, QString());
                                                                  });
                                                          });
                        });
    }, std::move(done));
}

void Coordinator::setThinking(const QJsonObject &target, const QString &level,
                              std::function<void(QJsonObject)> done)
{
    runTarget(target, [this, level](AgentSession &session, const Target &binding, CommandDone finish) {
        session.request(QStringLiteral("set_thinking_level"),
                        QJsonObject{{QStringLiteral("level"), level}}, kStateTimeoutMs,
                        [this, binding, level, finish](bool ok, const QJsonObject &response,
                                                       const QString &error) {
                            if (!ok || !response.value(QStringLiteral("success")).toBool(false)) {
                                finish(false, QJsonValue(),
                                       error.isEmpty()
                                           ? response.value(QStringLiteral("error")).toString(
                                                 QStringLiteral("set_thinking_level failed"))
                                           : error);
                                return;
                            }
                            const QJsonObject data = response.value(QStringLiteral("data")).toObject();
                            const QString effective =
                                data.value(QStringLiteral("thinkingLevel")).toString(level);
                            if (m_deps.services->catalog) {
                                m_deps.services->catalog->update(
                                    binding.sessionId,
                                    QJsonObject{{QStringLiteral("thinkingLevel"), effective},
                                                {QStringLiteral("updatedAt"),
                                                 static_cast<double>(QDateTime::currentMSecsSinceEpoch())}});
                            }
                            emitState();
                            // Same typed contract as set-model: oracle `setRuntimeThinking`
                            // returns `AgentManager.setThinking`, which is the projected
                            // `AgentRuntimeState`, and the renderer merges the whole object into
                            // the runtime state atom.
                            fetchRuntimeState(binding.agentId, [finish](const QJsonObject &state) {
                                finish(true, state, QString());
                            });
                        });
    }, std::move(done));
}

} // namespace runtime
