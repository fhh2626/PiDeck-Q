#include "AgentEvents.h"

#include <QDateTime>
#include <QJsonArray>
#include <QJsonDocument>
#include <QTimer>

namespace agentruntime {
namespace {

qint64 nowMs()
{
    return QDateTime::currentMSecsSinceEpoch();
}

/** Batch ask envelope: the title carries `{__piDeckBatchAsk:1, review?, questions:[...]}`. */
QJsonObject parseBatchEnvelope(const QString &title)
{
    const QString raw = title.trimmed();
    if (!raw.startsWith(QLatin1Char('{'))) return {};
    const QJsonDocument document = QJsonDocument::fromJson(raw.toUtf8());
    if (!document.isObject()) return {};
    const QJsonObject parsed = document.object();
    if (parsed.value(QStringLiteral("__piDeckBatchAsk")).toInt() != 1) return {};
    const QJsonArray questions = parsed.value(QStringLiteral("questions")).toArray();
    QJsonArray normalized;
    static const QStringList types{QStringLiteral("select"), QStringLiteral("confirm"),
                                   QStringLiteral("input"), QStringLiteral("editor")};
    for (const QJsonValue &value : questions) {
        if (!value.isObject()) continue;
        const QJsonObject question = value.toObject();
        if (!question.value(QStringLiteral("id")).isString()) continue;
        if (!question.value(QStringLiteral("question")).isString()) continue;
        if (!types.contains(question.value(QStringLiteral("type")).toString())) continue;
        normalized.append(question);
    }
    if (normalized.isEmpty()) return {};
    return QJsonObject{
        {QStringLiteral("review"), parsed.value(QStringLiteral("review")).toBool(false)},
        {QStringLiteral("questions"), normalized},
    };
}

} // namespace
void handleUiRequest(AgentSession &session, const QJsonObject &event, const EventHooks &hooks)
{
    const QString method = event.value(QStringLiteral("method")).toString();
    const QString requestId = event.value(QStringLiteral("id")).toString();
    const QString agentId = session.tab().id;

    if (method == QLatin1String("notify")) {
        QJsonObject payload{
            {QStringLiteral("agentId"), agentId},
            {QStringLiteral("requestId"), requestId},
            {QStringLiteral("method"), method},
            {QStringLiteral("title"), QString()},
            {QStringLiteral("message"), runtime::stripAnsi(event.value(QStringLiteral("message")).toString())},
        };
        if (event.contains(QStringLiteral("notifyType"))) {
            payload.insert(QStringLiteral("notifyType"), event.value(QStringLiteral("notifyType")));
        }
        if (hooks.send) hooks.send(QStringLiteral("agents:ui-request"), payload);
        return;
    }
    if (method == QLatin1String("set_editor_text")) {
        if (hooks.send) {
            hooks.send(QStringLiteral("agents:ui-request"), QJsonObject{
                {QStringLiteral("agentId"), agentId},
                {QStringLiteral("requestId"), requestId},
                {QStringLiteral("method"), method},
                {QStringLiteral("title"), QString()},
                {QStringLiteral("text"), event.value(QStringLiteral("text")).toString()},
            });
        }
        return;
    }
    if (method == QLatin1String("setWidget")) {
        if (hooks.send) {
            QJsonObject payload{
                {QStringLiteral("agentId"), agentId},
                {QStringLiteral("requestId"), requestId},
                {QStringLiteral("method"), method},
                {QStringLiteral("title"), QString()},
                {QStringLiteral("widgetKey"), event.value(QStringLiteral("widgetKey")).toString(requestId)},
            };
            if (event.value(QStringLiteral("widgetLines")).isArray()) {
                payload.insert(QStringLiteral("widgetLines"), event.value(QStringLiteral("widgetLines")));
            }
            if (event.contains(QStringLiteral("widgetPlacement"))) {
                payload.insert(QStringLiteral("widgetPlacement"),
                               event.value(QStringLiteral("widgetPlacement")));
            }
            hooks.send(QStringLiteral("agents:ui-request"), payload);
        }
        return;
    }
    // Subagent status slots are not dialog UI and must not occupy the ask channel.
    if (method == QLatin1String("setStatus")) {
        const QString statusKey = event.value(QStringLiteral("statusKey")).toString();
        // The prefix is the shared contract with the bundled extension (and the Web
        // bridge); any other `setStatus` user stays out of the sidebar.
        const QString prefix = SubagentRuns::statusKeyPrefix();
        if (!statusKey.startsWith(prefix)) return;
        const QString runId = statusKey.mid(prefix.size());
        if (runId.isEmpty()) return;
        const QString statusText = event.value(QStringLiteral("statusText")).toString();
        const qint64 now = nowMs();
        bool changed = false;
        if (statusText.isEmpty()) {
            // The publisher disposed its slot: close the source, keep failure rows.
            changed = session.subagentRuns().clearStatusTask(runId, now);
        } else {
            // The extension may publish a project-relative owner id; resolve it against the
            // project root (oracle `getProject(projectId)?.path ?? tab.cwd`) so a relative
            // publisher lights its rows instead of being dropped as a foreign session.
            QString ownerBasePath = hooks.projectPath ? hooks.projectPath(session.tab().projectId) : QString();
            if (ownerBasePath.isEmpty()) ownerBasePath = session.tab().cwd;
            changed = session.subagentRuns().observeStatusSnapshot(
                runId, statusText, session.tab().sessionPath, ownerBasePath,
                session.tab().sessionEnvironment, now);
        }
        if (changed) emitSubagentStatus(session, hooks);
        return;
    }
    if (method == QLatin1String("setTitle")) return;
    if (method != QLatin1String("select") && method != QLatin1String("confirm")
        && method != QLatin1String("input") && method != QLatin1String("editor")) {
        return;
    }

    const QString rawTitle = event.value(QStringLiteral("title")).toString(
        event.value(QStringLiteral("question")).toString());
    const QJsonObject batchEnvelope = parseBatchEnvelope(rawTitle);
    QStringList options;
    for (const QJsonValue &value : event.value(QStringLiteral("options")).toArray()) {
        if (value.isString()) options.append(value.toString());
    }
    bool hasCustomOption = false;
    for (const QString &option : options) {
        // The bundled `ask_question` extension appends this marker for non-desktop
        // clients (`✎ 自行输入...`). The desktop renders its own inline field, so the
        // marker row must never become a selectable literal answer.
        if (option.startsWith(QStringLiteral("\u270e"))) hasCustomOption = true;
    }
    if (hasCustomOption) {
        QStringList filtered;
        for (const QString &option : options) {
            if (!option.startsWith(QStringLiteral("\u270e"))) filtered.append(option);
        }
        options = filtered;
    }
    // `select` without options degrades to `input`: silently cancelling would hide the
    // question entirely (ask_question options are optional).
    QString effectiveMethod = method;
    if (method == QLatin1String("select") && options.isEmpty()) effectiveMethod = QStringLiteral("input");

    AgentSession::PendingUi pending;
    pending.requestId = requestId;
    pending.method = batchEnvelope.isEmpty() ? effectiveMethod : QStringLiteral("batch_ask");
    pending.title = batchEnvelope.isEmpty() ? rawTitle : QString();
    pending.options = options;
    pending.placeholder = event.value(QStringLiteral("placeholder")).toString();
    pending.prefill = event.value(QStringLiteral("prefill")).toString();
    pending.allowOther = event.value(QStringLiteral("allowOther")).toBool(false) || hasCustomOption;
    if (!batchEnvelope.isEmpty()) {
        pending.batchQuestions = batchEnvelope.value(QStringLiteral("questions")).toArray();
        pending.batchReview = batchEnvelope.value(QStringLiteral("review")).toBool(false);
    }
    session.pendingUi().insert(requestId, pending);

    if (hooks.send) {
        QJsonObject payload{
            {QStringLiteral("agentId"), agentId},
            {QStringLiteral("requestId"), requestId},
            {QStringLiteral("method"), pending.method},
            {QStringLiteral("title"), pending.title},
        };
        if (!pending.options.isEmpty()) {
            QJsonArray array;
            for (const QString &option : pending.options) array.append(option);
            payload.insert(QStringLiteral("options"), array);
        }
        if (!pending.placeholder.isEmpty()) payload.insert(QStringLiteral("placeholder"), pending.placeholder);
        if (!pending.prefill.isEmpty()) payload.insert(QStringLiteral("prefill"), pending.prefill);
        if (pending.allowOther) payload.insert(QStringLiteral("allowOther"), true);
        if (!pending.batchQuestions.isEmpty()) {
            payload.insert(QStringLiteral("batchQuestions"), pending.batchQuestions);
            if (pending.batchReview) payload.insert(QStringLiteral("batchReview"), true);
        }
        hooks.send(QStringLiteral("agents:ui-request"), payload);
    }
    if (hooks.uiRequest) hooks.uiRequest(pending);

    // A timeout must close both ends: hiding the form would leave pi blocked on a
    // response that never arrives, and the renderer card would stay active forever.
    const QJsonValue timeout = event.value(QStringLiteral("timeout"));
    if (timeout.isDouble() && timeout.toDouble() > 0) {
        const QString id = requestId;
        const QString ownerAgentId = agentId;
        const EventHooks timerHooks = hooks;
        QTimer::singleShot(int(timeout.toDouble()), session.timerContext(), [&session, id, ownerAgentId, timerHooks]() {
            if (!session.pendingUi().contains(id)) return;
            session.pendingUi().remove(id);
            // `sendUIResponse(..., {cancelled:true})`: a raw frame plus the completion the
            // renderer needs to close the card (it only transitions on `completed`).
            session.notify(QJsonObject{{QStringLiteral("type"), QStringLiteral("extension_ui_response")},
                                       {QStringLiteral("id"), id},
                                       {QStringLiteral("cancelled"), true}});
            if (timerHooks.uiRequestClosed) timerHooks.uiRequestClosed(id);
            if (timerHooks.send) {
                timerHooks.send(QStringLiteral("agents:ui-request"),
                                QJsonObject{{QStringLiteral("agentId"), ownerAgentId},
                                            {QStringLiteral("requestId"), id},
                                            {QStringLiteral("completed"), true},
                                            {QStringLiteral("cancelled"), true}});
            }
        });
    }
}


} // namespace agentruntime
