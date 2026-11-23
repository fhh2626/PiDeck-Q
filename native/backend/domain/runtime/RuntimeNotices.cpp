#include "RuntimeNotices.h"

#include <QJsonValue>

namespace runtime::notices {
namespace {

// Durations are part of the observable payload: the renderer uses `duration` as the
// toast lifetime for info/warning, so changing one here changes UX, not just timing.
constexpr int kAbortRequestedMs = 2500;
constexpr int kAbortSlowMs = 6000;
constexpr int kThinkingUnsupportedMs = 4000;

} // namespace

QJsonObject abortRequested(const QString &agentId)
{
    return QJsonObject{
        {QStringLiteral("agentId"), agentId},
        // Fallback copy for consumers without the renderer copy table (LAN/Web reuse the
        // same keys, so the message is only a last resort).
        {QStringLiteral("message"), QStringLiteral("已请求停止当前响应")},
        {QStringLiteral("i18nKey"), QStringLiteral("app.abortRequested")},
        {QStringLiteral("kind"), QStringLiteral("info")},
        {QStringLiteral("duration"), kAbortRequestedMs},
    };
}

QJsonObject abortSlow(const QString &agentId)
{
    return QJsonObject{
        {QStringLiteral("agentId"), agentId},
        {QStringLiteral("message"), QStringLiteral("停止响应较慢，可尝试重启会话")},
        {QStringLiteral("i18nKey"), QStringLiteral("app.abortSlow")},
        {QStringLiteral("kind"), QStringLiteral("warning")},
        {QStringLiteral("duration"), kAbortSlowMs},
    };
}

QJsonObject thinkingUnsupported(const QString &agentId, const QString &level,
                                const QString &fallback)
{
    return QJsonObject{
        {QStringLiteral("agentId"), agentId},
        {QStringLiteral("i18nKey"), QStringLiteral("app.thinkingUnsupported")},
        {QStringLiteral("i18nParams"),
         QJsonObject{{QStringLiteral("level"), level}, {QStringLiteral("fallback"), fallback}}},
        {QStringLiteral("kind"), QStringLiteral("info")},
        {QStringLiteral("duration"), kThinkingUnsupportedMs},
    };
}

} // namespace runtime::notices
