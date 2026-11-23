#include "ExternalLinks.h"

#include <QUrl>

#include <array>

namespace externallinks {
namespace {

/**
 * Non-web protocols that may leave the application.
 *
 * These are deep links produced by trusted in-app UI (settings, updates, help) and by
 * mail/telephony hand-offs. The list is closed on purpose: adding a scheme here is a
 * security decision, not a convenience.
 */
constexpr std::array<const char *, 5> kAllowedNonHttpSchemes{
    "mailto:",
    "tel:",
    "sms:",
    "vscode:",
    "vscode-insiders:",
};

} // namespace

QString urlScheme(const QString &url)
{
    // QUrl lower-cases the scheme and yields no scheme for a relative value, which is the
    // part of WHATWG `new URL(...)` this gateway depends on. Tolerant mode is used so a
    // URL containing spaces still reports its scheme instead of looking unparseable.
    const QUrl parsed(url);
    if (!parsed.isValid() || parsed.scheme().isEmpty()) return QString();
    return parsed.scheme().toLower() + QLatin1Char(':');
}

bool isHttpLike(const QString &url)
{
    const QString scheme = urlScheme(url);
    return scheme == QLatin1String("http:") || scheme == QLatin1String("https:");
}

bool isAllowedSystemProtocol(const QString &url)
{
    const QString scheme = urlScheme(url);
    if (scheme.isEmpty()) return false;
    if (scheme == QLatin1String("http:") || scheme == QLatin1String("https:")) return true;
    for (const char *allowed : kAllowedNonHttpSchemes) {
        if (scheme == QLatin1String(allowed)) return true;
    }
    return false;
}

} // namespace externallinks
