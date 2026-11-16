#pragma once

#include <QJsonObject>
#include <QNetworkProxy>
#include <QString>
#include <QUrl>

/**
 * Desktop proxy: the app's own outbound HTTP routing policy.
 *
 * Port of `src/main/settings/DesktopProxy.ts` (settings -> config) plus the request
 * policy in `src/native-node/platform/NodeProxy.ts` (which requests may use it).
 *
 * Two invariants decide every request:
 *  1. loopback is never proxied (`localhost`, `127/8`, `::1`). The renderer RPC, the SSE
 *     stream and every local stub live there; routing them through a user proxy would
 *     break the desktop itself. This is a product invariant, not a user setting.
 *  2. everything else follows the persisted settings: disabled or unparsable URL means
 *     direct, otherwise the normalized proxy URL plus the user bypass rules.
 *
 * `piProxy*` settings are a different feature: they only shape the pi child process
 * environment (`PiLocator::createProcessEnv`). Never mix the two.
 *
 * The applied config is process-global state, written and read on the Qt main thread
 * (settings:update handler and the network managers both run there), so no lock is
 * needed. `apply` is the only writer.
 */
namespace desktopproxy {

enum class Mode { Direct, FixedServers };

struct Config {
    Mode mode = Mode::Direct;
    /** Normalized proxy URL, e.g. `http://127.0.0.1:7890`; empty when direct. */
    QString proxyRules;
    /** `;`-joined user bypass rules; empty when the user configured none. */
    QString proxyBypassRules;
};

/** Settings keys this module owns (kept in one place for apply/read symmetry). */
bool touchesSettings(const QJsonObject &patch);

/** Port of `buildDesktopProxyConfig` (pure: no side effects). */
Config buildConfig(const QJsonObject &settings);

/** Move the process-wide config to `factory` (called by boot and tests only). */
void resetTo(const Config &factory = Config{});

/** Apply the persisted settings; returns the config that is now in effect. */
Config apply(const QJsonObject &settings);

/** The config currently in effect. */
Config current();

/**
 * `NodeProxy.shouldBypass`: loopback invariant first, then the user's bypass rules.
 *
 * The rules are matched exactly like the oracle: split on `;`, `,` or whitespace, drop a
 * leading `*.`, and then compare the whole hostname or a `.`-suffix. Both the root
 * hostname and its subdomains match a wildcard rule, without matching a longer label
 * such as `notexample.com`. PiProxyTester's bypass list has a separate port-aware matcher.
 */
bool shouldBypass(const QString &hostname, const Config &config);
bool shouldBypass(const QString &hostname);

/**
 * Proxy to attach to one outbound request.
 *
 * Returns `NoProxy` for direct mode and for bypassed hosts. This is the policy the
 * installed application proxy factory evaluates per request, so a long-lived connection
 * pool, a settings change and the loopback invariant all stay consistent.
 */
QNetworkProxy proxyForUrl(const QUrl &url);
QNetworkProxy proxyForUrl(const QUrl &url, const Config &config);

/**
 * Install the process-wide per-request proxy policy (idempotent).
 *
 * Every `QNetworkAccessManager` in this process (market catalogue, provider probes) asks
 * Qt for a proxy per request; the factory answers from the applied config, which is why
 * outbound HTTP follows the desktop proxy without each module wiring it. Raw sockets
 * (`PiProxyTest`) are not affected: the probe must reach the proxy itself.
 */
void installApplicationFactory();

} // namespace desktopproxy
