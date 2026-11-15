#include "ProviderProbeInternal.h"

#include "ProviderProbe.h"

#include <QRegularExpression>
#include <QUrl>

namespace providerprobe {
namespace internal {

bool hasApiVersionPath(const QString &baseUrl)
{
    static const QRegularExpression pattern(QStringLiteral("/v\\d+(alpha|beta)?$|/api$"));
    return pattern.match(withTrailingSlashesRemoved(baseUrl)).hasMatch();
}

QString googleVersionedBase(const QString &baseUrl)
{
    const QString trimmed = withTrailingSlashesRemoved(baseUrl);
    static const QRegularExpression versioned(QStringLiteral("[/]v\\d+(alpha|beta)?$"));
    return versioned.match(trimmed).hasMatch() ? trimmed : trimmed + QStringLiteral("/v1beta");
}

QString googleModelPath(const QString &modelId)
{
    return modelId.startsWith(QStringLiteral("models/")) ? modelId : QStringLiteral("models/") + modelId;
}

} // namespace internal

QString ensureVersionPath(const QString &baseUrl)
{
    const QString trimmed = internal::withTrailingSlashesRemoved(baseUrl);
    return internal::hasApiVersionPath(trimmed) ? trimmed : trimmed + QStringLiteral("/v1");
}

bool needsSessionBaseUrlVersion(const QString &configuredBaseUrl, const QString &effectiveRequestUrl)
{
    if (configuredBaseUrl.trimmed().isEmpty()) return false;
    if (internal::hasApiVersionPath(configuredBaseUrl)) return false;
    if (effectiveRequestUrl.isEmpty()) return true;
    static const QRegularExpression versioned(
        QStringLiteral("^(.*?)(/v\\d+(?:alpha|beta)?|/api)(?=/|$)"),
        QRegularExpression::CaseInsensitiveOption);
    const QString path = QUrl(effectiveRequestUrl).path();
    return versioned.match(path).hasMatch();
}

QString suggestNormalizedBaseUrl(const QString &configuredBaseUrl, const QString &effectiveRequestUrl,
                                 const QString &apiType)
{
    if (!needsSessionBaseUrlVersion(configuredBaseUrl, effectiveRequestUrl)) return {};
    if (!effectiveRequestUrl.isEmpty()) {
        static const QRegularExpression versioned(
            QStringLiteral("^(.*?)(/v\\d+(?:alpha|beta)?|/api)(?=/|$)"),
            QRegularExpression::CaseInsensitiveOption);
        const QUrl url(effectiveRequestUrl);
        const QRegularExpressionMatch match = versioned.match(url.path());
        if (match.hasMatch()) {
            const QString candidate = url.scheme() + QStringLiteral("://") + url.authority()
                + match.captured(1) + match.captured(2);
            const QString current = internal::withTrailingSlashesRemoved(configuredBaseUrl);
            return candidate == current ? QString() : candidate;
        }
    }
    const QString trimmed = internal::withTrailingSlashesRemoved(configuredBaseUrl);
    const QString api = apiType.toLower();
    if (api == QStringLiteral("google-generative-ai") || api == QStringLiteral("google")) {
        return trimmed + QStringLiteral("/v1beta");
    }
    return ensureVersionPath(configuredBaseUrl);
}

} // namespace providerprobe
