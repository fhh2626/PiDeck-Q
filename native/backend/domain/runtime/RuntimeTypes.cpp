#include "RuntimeTypes.h"

#include <QJsonArray>
#include <QRegularExpression>

#include <algorithm>
#include <cmath>

namespace runtime {
namespace {

QString nestedString(const QJsonObject &object, const QString &key)
{
    return object.value(key).toString();
}

QJsonValue numberOrNull(const QJsonValue &value)
{
    return value.isDouble() ? value : QJsonValue(QJsonValue::Null);
}

/** `pickNumber` semantics: first finite number, else a numeric string. */
QJsonValue firstFinite(std::initializer_list<QJsonValue> candidates)
{
    for (const QJsonValue &candidate : candidates) {
        if (candidate.isDouble() && std::isfinite(candidate.toDouble())) return candidate;
        if (candidate.isString() && !candidate.toString().trimmed().isEmpty()) {
            bool ok = false;
            const double parsed = candidate.toString().toDouble(&ok);
            if (ok && std::isfinite(parsed)) return QJsonValue(parsed);
        }
    }
    return QJsonValue(QJsonValue::Undefined);
}

} // namespace

QJsonObject okResult(const QJsonValue &value)
{
    return QJsonObject{{QStringLiteral("ok"), true}, {QStringLiteral("value"), value}};
}

QJsonObject targetedOk(const Target &target, const QJsonValue &value)
{
    return okResult(QJsonObject{
        {QStringLiteral("target"),
         QJsonObject{
             {QStringLiteral("sessionId"), target.sessionId},
             {QStringLiteral("agentId"), target.agentId},
             {QStringLiteral("runtimeGeneration"), target.runtimeGeneration},
         }},
        {QStringLiteral("value"), value},
    });
}

QJsonObject errorResult(const CommandError &error)
{
    QJsonObject detail{{QStringLiteral("code"), error.code}};
    if (!error.debugDetails.isEmpty()) {
        detail.insert(QStringLiteral("debugDetails"), error.debugDetails);
    }
    if (!error.model.isEmpty()) {
        detail.insert(QStringLiteral("params"), QJsonObject{{QStringLiteral("model"), error.model}});
    }
    if (error.needsRestart) detail.insert(QStringLiteral("needsRestart"), true);
    return QJsonObject{{QStringLiteral("ok"), false}, {QStringLiteral("error"), detail}};
}

CommandError classifyFailure(const QString &message, const QString &explicitCode)
{
    CommandError error;
    error.debugDetails = message;

    const QString lower = message.toLower();
    if (explicitCode == QLatin1String("SESSION_MODEL_REQUIRED")
        || lower.contains(QStringLiteral("model selection required"))) {
        error.code = QString::fromLatin1(errorcode::kModelRequired);
        return error;
    }
    // "Model not found: provider/model" -> the renderer shows the restart guidance, so
    // the model id is extracted for the i18n `{model}` placeholder.
    const QRegularExpression modelPattern(QStringLiteral("model not found\\s*:?\\s*(.+)$"),
                                          QRegularExpression::CaseInsensitiveOption);
    const QRegularExpressionMatch modelMatch = modelPattern.match(message);

    if (explicitCode == QLatin1String("SESSION_ENTRY_NOT_FOUND")
        || explicitCode == QLatin1String("SESSION_ENTRY_AMBIGUOUS")
        || explicitCode == QLatin1String("MESSAGE_NOT_FOUND")) {
        error.code = QString::fromLatin1(errorcode::kMessageNotFound);
        return error;
    }
    if (explicitCode == QLatin1String("SESSION_MODEL_NOT_FOUND")) {
        error.code = QString::fromLatin1(errorcode::kModelNotFound);
        error.needsRestart = true;
        error.model = modelMatch.hasMatch() ? modelMatch.captured(1).trimmed() : message;
        return error;
    }
    if (explicitCode == QLatin1String("SESSION_NOT_FOUND")) {
        error.code = QString::fromLatin1(errorcode::kSessionNotFound);
        return error;
    }
    if (explicitCode == QLatin1String("SESSION_RUNTIME_BUSY")) {
        error.code = QString::fromLatin1(errorcode::kRuntimeBusy);
        return error;
    }
    if (explicitCode == QLatin1String("SESSION_RUNTIME_CHANGED")) {
        error.code = QString::fromLatin1(errorcode::kRuntimeChanged);
        return error;
    }
    if (explicitCode == QLatin1String("SESSION_RUNTIME_UNAVAILABLE")) {
        error.code = QString::fromLatin1(errorcode::kRuntimeUnavailable);
        return error;
    }
    if (explicitCode == QLatin1String("SESSION_COMMAND_FAILED")) {
        error.code = QString::fromLatin1(errorcode::kCommandFailed);
        return error;
    }

    // Message/entry failures are recognised before the generic "not found" branch,
    // otherwise a missing message is reported as "session no longer exists".
    const bool mentionsMessage = lower.contains(QStringLiteral("message not found"))
        || lower.contains(QStringLiteral("message was not found"))
        || lower.contains(QStringLiteral("session_entry_not_found"))
        || lower.contains(QStringLiteral("session_entry_ambiguous"))
        || (lower.contains(QStringLiteral("entry")) && lower.contains(QStringLiteral("not found")));
    if (mentionsMessage) {
        error.code = QString::fromLatin1(errorcode::kMessageNotFound);
    } else if (lower.contains(QStringLiteral("model not found"))) {
        error.code = QString::fromLatin1(errorcode::kModelNotFound);
        error.needsRestart = true;
        error.model = modelMatch.hasMatch() ? modelMatch.captured(1).trimmed() : message;
    } else if (lower.contains(QStringLiteral("session not found"))
               || (lower.contains(QStringLiteral("not found"))
                   && !lower.contains(QStringLiteral("message"))
                   && !lower.contains(QStringLiteral("entry")))) {
        error.code = QString::fromLatin1(errorcode::kSessionNotFound);
    } else if (lower.contains(QStringLiteral("busy")) || lower.contains(QStringLiteral("in progress"))
               || lower.contains(QStringLiteral("stream"))) {
        error.code = QString::fromLatin1(errorcode::kRuntimeBusy);
    } else if (lower.contains(QStringLiteral("binding")) || lower.contains(QStringLiteral("generation"))
               || lower.contains(QStringLiteral("changed"))) {
        error.code = QString::fromLatin1(errorcode::kRuntimeChanged);
    } else if (lower.contains(QStringLiteral("runtime")) && lower.contains(QStringLiteral("available"))) {
        error.code = QString::fromLatin1(errorcode::kRuntimeUnavailable);
    }
    return error;
}

QJsonObject tabJson(const Tab &tab)
{
    QJsonObject json{
        {QStringLiteral("id"), tab.id},
        {QStringLiteral("projectId"), tab.projectId},
        {QStringLiteral("cwd"), tab.cwd},
        {QStringLiteral("title"), tab.title},
        {QStringLiteral("status"), tab.status},
        {QStringLiteral("createdAt"), static_cast<double>(tab.createdAt)},
    };
    if (!tab.piSessionId.isEmpty()) json.insert(QStringLiteral("sessionId"), tab.piSessionId);
    if (!tab.deckSessionId.isEmpty()) json.insert(QStringLiteral("deckSessionId"), tab.deckSessionId);
    if (!tab.sessionPath.isEmpty()) json.insert(QStringLiteral("sessionPath"), tab.sessionPath);
    if (!tab.sessionEnvironment.isEmpty()) {
        json.insert(QStringLiteral("sessionEnvironment"), tab.sessionEnvironment);
    }
    if (!tab.sessionSource.isEmpty()) json.insert(QStringLiteral("sessionSource"), tab.sessionSource);
    if (tab.isInternalSubagent) json.insert(QStringLiteral("isInternalSubagent"), true);
    if (!tab.wslDistro.isEmpty()) json.insert(QStringLiteral("wslDistro"), tab.wslDistro);
    if (!tab.wslUser.isEmpty()) json.insert(QStringLiteral("wslUser"), tab.wslUser);
    if (!tab.importedSourceId.isEmpty()) {
        json.insert(QStringLiteral("importedSourceId"), tab.importedSourceId);
    }
    if (tab.noSession) json.insert(QStringLiteral("noSession"), true);
    if (tab.runtimeGeneration > 0) {
        json.insert(QStringLiteral("runtimeGeneration"), tab.runtimeGeneration);
    }
    if (tab.compactionCount > 0) {
        json.insert(QStringLiteral("compactionCount"), tab.compactionCount);
    }
    return json;
}

QJsonObject runtimeInfoJson(const Target &target, const Tab &tab)
{
    QJsonObject json{
        {QStringLiteral("sessionId"), target.sessionId},
        {QStringLiteral("agentId"), target.agentId},
        {QStringLiteral("runtimeGeneration"), target.runtimeGeneration},
        {QStringLiteral("projectId"), tab.projectId},
        {QStringLiteral("cwd"), tab.cwd},
        {QStringLiteral("status"), tab.status},
        {QStringLiteral("createdAt"), static_cast<double>(tab.createdAt)},
        {QStringLiteral("isStreaming"), tab.isStreaming},
        {QStringLiteral("isExecutingTool"), tab.isExecutingTool},
    };
    if (!tab.sessionPath.isEmpty()) json.insert(QStringLiteral("sessionPath"), tab.sessionPath);
    if (tab.compactionCount > 0) {
        json.insert(QStringLiteral("compactionCount"), tab.compactionCount);
    }
    if (tab.noSession) json.insert(QStringLiteral("noSession"), true);
    return json;
}

QJsonObject runtimeStateJson(const QJsonObject &state, const QJsonObject &stats, const Tab &tab,
                             bool manualCompactionInFlight,
                             const cachehit::Stats &cacheHits,
                             const agentmetrics::ReplyPerf &perf)
{
    const QJsonObject model = state.value(QStringLiteral("model")).toObject();
    const QJsonObject tokens = stats.value(QStringLiteral("tokens")).toObject();
    const QJsonObject cache = tokens.value(QStringLiteral("cache")).toObject();
    const QJsonObject usage = stats.value(QStringLiteral("usage")).toObject();
    const QJsonObject contextUsage = stats.value(QStringLiteral("contextUsage")).toObject();

    const QJsonValue inputTokens = pickNumber({
        tokens.value(QStringLiteral("input")),
        tokens.value(QStringLiteral("inputTokens")),
        tokens.value(QStringLiteral("prompt")),
        tokens.value(QStringLiteral("promptTokens")),
        stats.value(QStringLiteral("inputTokens")),
        usage.value(QStringLiteral("input")),
    });
    const QJsonValue outputTokens = pickNumber({
        tokens.value(QStringLiteral("output")),
        tokens.value(QStringLiteral("outputTokens")),
        tokens.value(QStringLiteral("completion")),
        tokens.value(QStringLiteral("completionTokens")),
        stats.value(QStringLiteral("outputTokens")),
        usage.value(QStringLiteral("output")),
    });
    const QJsonValue cacheRead = pickNumber({
        tokens.value(QStringLiteral("cacheRead")),
        cache.value(QStringLiteral("read")),
        stats.value(QStringLiteral("cacheRead")),
        usage.value(QStringLiteral("cacheRead")),
    });
    const QJsonValue cacheWrite = pickNumber({
        tokens.value(QStringLiteral("cacheWrite")),
        cache.value(QStringLiteral("write")),
        stats.value(QStringLiteral("cacheWrite")),
        usage.value(QStringLiteral("cacheWrite")),
    });

    QJsonObject json;
    const QString modelName = model.value(QStringLiteral("name")).toString();
    if (!modelName.isEmpty()) json.insert(QStringLiteral("modelName"), modelName);
    else if (model.value(QStringLiteral("id")).isString()) {
        json.insert(QStringLiteral("modelName"), model.value(QStringLiteral("id")).toString());
    }
    if (model.value(QStringLiteral("provider")).isString()) {
        json.insert(QStringLiteral("provider"), model.value(QStringLiteral("provider")));
    }
    if (model.value(QStringLiteral("id")).isString()) {
        json.insert(QStringLiteral("modelId"), model.value(QStringLiteral("id")));
    }
    if (state.value(QStringLiteral("thinkingLevel")).isString()) {
        json.insert(QStringLiteral("thinkingLevel"), state.value(QStringLiteral("thinkingLevel")));
    }
    json.insert(QStringLiteral("isStreaming"), tab.isStreaming);
    // pi only reports a compaction it has acknowledged, so a manual `compact` still on the
    // wire and an auto compaction in flight (oracle `compactingAgents` / `rpcCompactingAgents`)
    // are local state that has to be folded in here.
    json.insert(QStringLiteral("isCompacting"),
                state.value(QStringLiteral("isCompacting")).toBool(false) || manualCompactionInFlight);
    json.insert(QStringLiteral("isExecutingTool"), tab.isExecutingTool);
    if (!tab.executingToolName.isEmpty()) {
        json.insert(QStringLiteral("executingToolName"), tab.executingToolName);
    }
    json.insert(QStringLiteral("toolStateSequence"), tab.toolStateSequence);
    if (contextUsage.contains(QStringLiteral("tokens"))) {
        json.insert(QStringLiteral("contextTokens"), contextUsage.value(QStringLiteral("tokens")));
    }
    const QJsonValue contextWindow = contextUsage.contains(QStringLiteral("contextWindow"))
        ? contextUsage.value(QStringLiteral("contextWindow"))
        : model.value(QStringLiteral("contextWindow"));
    if (contextWindow.isDouble()) json.insert(QStringLiteral("contextWindow"), contextWindow);
    if (contextUsage.contains(QStringLiteral("percent"))) {
        json.insert(QStringLiteral("contextPercent"), contextUsage.value(QStringLiteral("percent")));
    }
    if (!inputTokens.isUndefined()) json.insert(QStringLiteral("inputTokens"), inputTokens);
    if (!outputTokens.isUndefined()) json.insert(QStringLiteral("outputTokens"), outputTokens);
    if (!cacheRead.isUndefined()) json.insert(QStringLiteral("cacheRead"), cacheRead);
    if (!cacheWrite.isUndefined()) json.insert(QStringLiteral("cacheWrite"), cacheWrite);
    if (!cacheRead.isUndefined() || !cacheWrite.isUndefined()) {
        json.insert(QStringLiteral("cacheTotal"), cacheRead.toDouble(0) + cacheWrite.toDouble(0));
    }
    // Cache-hit statistics: pi's RPC does not return a rate, so the oracle prefers a
    // directly reported one (newer pi builds) and otherwise reads the session JSONL.
    const QJsonValue directCacheHitPercent = pickNumber({
        tokens.value(QStringLiteral("cacheHitPercent")),
        tokens.value(QStringLiteral("cacheHitRate")).isDouble()
            ? QJsonValue(tokens.value(QStringLiteral("cacheHitRate")).toDouble() * 100.0)
            : QJsonValue(QJsonValue::Undefined),
        stats.value(QStringLiteral("cacheHitPercent")),
        stats.value(QStringLiteral("cacheHitRate")).isDouble()
            ? QJsonValue(stats.value(QStringLiteral("cacheHitRate")).toDouble() * 100.0)
            : QJsonValue(QJsonValue::Undefined),
    });
    const auto clampPercent = [](const QJsonValue &value) -> QJsonValue {
        if (!value.isDouble()) return QJsonValue(QJsonValue::Undefined);
        const double number = value.toDouble();
        if (!std::isfinite(number)) return QJsonValue(QJsonValue::Undefined);
        return QJsonValue(std::max(0.0, std::min(100.0, number)));
    };
    QJsonValue cacheHitPercent = clampPercent(directCacheHitPercent);
    if (cacheHitPercent.isUndefined() && cacheHits.hasLatest) {
        cacheHitPercent = clampPercent(QJsonValue(cacheHits.latest));
    }
    if (!cacheHitPercent.isUndefined()) {
        json.insert(QStringLiteral("cacheHitPercent"), cacheHitPercent);
    }
    if (cacheHits.hasAverage) {
        const QJsonValue average = clampPercent(QJsonValue(cacheHits.average));
        if (!average.isUndefined()) {
            json.insert(QStringLiteral("cacheHitAveragePercent"), average);
        }
    }
    // Always present in the oracle shape (`cacheHitSampleCount: 0` when no samples); the
    // renderer uses it as the fallback sample count for the snapshot-history average.
    json.insert(QStringLiteral("cacheHitSampleCount"), cacheHits.sampleCount);
    if (perf.valid) {
        if (perf.hasTtft) json.insert(QStringLiteral("ttftMs"), perf.ttftMs);
        json.insert(QStringLiteral("totalMs"), perf.totalMs);
        if (perf.hasTps) json.insert(QStringLiteral("tps"), perf.tps);
        json.insert(QStringLiteral("perfAt"), perf.at);
    }
    Q_UNUSED(numberOrNull);
    Q_UNUSED(nestedString);
    return json;
}

QJsonValue pickNumber(std::initializer_list<QJsonValue> candidates)
{
    return firstFinite(candidates);
}

QString stripAnsi(const QString &text)
{
    static const QRegularExpression pattern(QStringLiteral("\x1b\\[[0-9;]*[a-zA-Z]"));
    QString result = text;
    result.remove(pattern);
    return result;
}

} // namespace runtime
