#include "DesktopProxy.h"

#include <QAbstractSocket>
#include <QHostAddress>
#include <QNetworkProxyFactory>
#include <QNetworkProxyQuery>
#include <QRegularExpression>
#include <QStringList>

namespace desktopproxy {
namespace {

/**
 * The single process-wide slot. Written by `apply` (boot, settings:update) and read by
 * every outbound request on the same main thread; see the header for why no lock.
 */
Config &state()
{
    static Config config;
    return config;
}

/** `normalizeProxyRules`: trim, default the scheme, require a host, drop a trailing `/`. */
QString normalizeProxyRules(const QString &value)
{
    const QString trimmed = value.trimmed();
    if (trimmed.isEmpty()) return QString();
    static const QRegularExpression schemePattern(QStringLiteral("^[a-z][a-z\\d+.-]*://"),
                                                  QRegularExpression::CaseInsensitiveOption);
    const QString normalized = schemePattern.match(trimmed).hasMatch()
        ? trimmed
        : QStringLiteral("http://") + trimmed;
    // Strict parsing rejects the inputs the WHATWG `URL` constructor rejects
    // (`http://`, embedded spaces in the authority), so a typo becomes "direct"
    // instead of a proxy host Qt would happily invent.
    const QUrl url(normalized, QUrl::StrictMode);
    if (!url.isValid() || url.host().isEmpty()) return QString();
    QString text = url.toString(QUrl::FullyEncoded);
    if (text.endsWith(QLatin1Char('/'))) text.chop(1);
    return text;
}

/** `normalizeBypassRules`: split on `,`/newline/`;`, trim, drop empties, join with `;`. */
QString normalizeBypassRules(const QString &value)
{
    static const QRegularExpression separator(QStringLiteral("[,\\n;]"));
    QStringList rules;
    for (const QString &item : value.split(separator)) {
        const QString rule = item.trimmed();
        if (!rule.isEmpty()) rules.append(rule);
    }
    return rules.join(QLatin1Char(';'));
}

} // namespace

bool touchesSettings(const QJsonObject &patch)
{
    return patch.contains(QStringLiteral("desktopProxyEnabled"))
        || patch.contains(QStringLiteral("desktopProxyUrl"))
        || patch.contains(QStringLiteral("desktopProxyBypass"));
}

Config buildConfig(const QJsonObject &settings)
{
    if (!settings.value(QStringLiteral("desktopProxyEnabled")).toBool(false)) return Config{};
    const QString proxyRules =
        normalizeProxyRules(settings.value(QStringLiteral("desktopProxyUrl")).toString());
    if (proxyRules.isEmpty()) return Config{};
    Config config;
    config.mode = Mode::FixedServers;
    config.proxyRules = proxyRules;
    config.proxyBypassRules =
        normalizeBypassRules(settings.value(QStringLiteral("desktopProxyBypass")).toString());
    return config;
}

void resetTo(const Config &factory)
{
    state() = factory;
}

Config apply(const QJsonObject &settings)
{
    state() = buildConfig(settings);
    return state();
}

Config current()
{
    return state();
}

bool shouldBypass(const QString &hostname, const Config &config)
{
    QString host = hostname.trimmed().toLower();
    if (host.startsWith(QLatin1Char('[')) && host.endsWith(QLatin1Char(']'))) {
        host = host.mid(1, host.size() - 2);
    }
    if (host.isEmpty()) return false;
    // Loopback invariant. `isIP`-guarded exactly like the oracle, so a hostname that
    // merely starts with "127." (e.g. "127.0.0.1.example.com") is not treated as IP.
    if (host == QLatin1String("localhost")) return true;
    if (host == QLatin1String("::1")) return true;
    QHostAddress address;
    if (address.setAddress(host)
        && address.protocol() == QAbstractSocket::IPv4Protocol
        && host.startsWith(QLatin1String("127."))) {
        return true;
    }
    if (config.mode != Mode::FixedServers || config.proxyBypassRules.isEmpty()) return false;
    static const QRegularExpression separator(QStringLiteral("[;,\\s]+"));
    const QStringList rules = config.proxyBypassRules.split(separator, Qt::SkipEmptyParts);
    for (const QString &raw : rules) {
        QString rule = raw.trimmed();
        if (rule.isEmpty()) continue;
        if (rule.startsWith(QLatin1String("*."))) rule = rule.mid(1);
        rule = rule.toLower();
        if (rule == QLatin1String("<local>")) {
            if (!host.contains(QLatin1Char('.'))) return true;
            continue;
        }
        if (host == rule || host.endsWith(QLatin1Char('.') + rule)) return true;
    }
    return false;
}

bool shouldBypass(const QString &hostname)
{
    return shouldBypass(hostname, state());
}

QNetworkProxy proxyForUrl(const QUrl &url, const Config &config)
{
    if (config.mode != Mode::FixedServers) return QNetworkProxy(QNetworkProxy::NoProxy);
    if (shouldBypass(url.host(), config)) return QNetworkProxy(QNetworkProxy::NoProxy);

    const QUrl proxyUrl(config.proxyRules, QUrl::StrictMode);
    if (!proxyUrl.isValid() || proxyUrl.host().isEmpty()) {
        return QNetworkProxy(QNetworkProxy::NoProxy);
    }
    const bool secureProxy = proxyUrl.scheme().compare(QStringLiteral("https"), Qt::CaseInsensitive) == 0;
    // Qt cannot tunnel the proxy hop itself over TLS, so an `https://` proxy URL is used
    // as a plain HTTP proxy (documented divergence; http:// is the supported form).
    QNetworkProxy proxy(QNetworkProxy::HttpProxy, proxyUrl.host(),
                        quint16(proxyUrl.port(secureProxy ? 443 : 80)));
    if (!proxyUrl.userName().isEmpty()) {
        proxy.setUser(proxyUrl.userName());
        proxy.setPassword(proxyUrl.password());
    }
    return proxy;
}

QNetworkProxy proxyForUrl(const QUrl &url)
{
    return proxyForUrl(url, state());
}

void installApplicationFactory()
{
    /** Per-request decision, evaluated by every QNetworkAccessManager in the process. */
    class Factory : public QNetworkProxyFactory {
    public:
        QList<QNetworkProxy> queryProxy(const QNetworkProxyQuery &query) override
        {
            // Only HTTP(S) URL requests can use an HTTP proxy; socket-shaped queries
            // (if any appear later) keep Qt's default single-proxy behaviour.
            if (query.queryType() != QNetworkProxyQuery::UrlRequest || !query.url().isValid()) {
                return {QNetworkProxy(QNetworkProxy::NoProxy)};
            }
            return {proxyForUrl(query.url())};
        }
    };
    // The factory must outlive the application; Qt does not take ownership.
    static Factory *factory = nullptr;
    if (factory) return;
    factory = new Factory();
    QNetworkProxyFactory::setApplicationProxyFactory(factory);
}


} // namespace desktopproxy
