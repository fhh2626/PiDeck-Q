#pragma once

#include "MainCopy.h"

#include <QJsonObject>
#include <QString>

#include <functional>

/**
 * `settings:test-pi-proxy` probe (port of `src/main/pi/PiProxyTester.ts`).
 *
 * The oracle does not go through fetch: it opens a TCP socket to the proxy and speaks
 * HTTP itself, so the probe proves exactly the path the user's proxy client exposes:
 *  - `http://` target: absolute-URI request sent to the proxy (no tunnel);
 *  - `https://` target: `CONNECT host:port` tunnel, then TLS to the target, then an
 *    origin-form GET;
 *  - an `https://` proxy URL means TLS on the proxy hop as well.
 *
 * Everything is bounded: 8 s per phase (connect / TLS / response) and a 64 KiB response
 * head. The probe never follows redirects, never sends the API key, and reports only
 * the HTTP status code, so no credential can reach a log line.
 *
 * A `socks5://` (or any non-http) proxy URL is not a supported protocol in the oracle
 * either: it answers `mainProxy.proxyProtocolUnsupported` instead of pretending to work.
 */
namespace pipproxytest {

struct Settings {
    bool enabled = false;
    QString url;
    QString bypass;
};

/** `piProxyEnabled` / `piProxyUrl` / `piProxyBypass` from a settings object. */
Settings readSettings(const QJsonObject &settings);

/** `https://api.openai.com/v1/models`, the oracle's default target. */
QString defaultTestUrl();

using Done = std::function<void(const QJsonObject &)>;

/** Run one probe; the result object matches `PiProxyTestResult` exactly. */
void test(const Settings &settings, const QString &testUrl,
          const maincopy::Translator &translate, Done done);

/**
 * `matchesNoProxy` (pure): port-aware bypass matcher used by the probe.
 *
 * This is deliberately *not* the desktop-proxy matcher: it splits on `,` only, honours
 * `host:port`, `*`, `*.suffix` and `.suffix`, and matches bare suffixes. Both matchers
 * exist in the oracle and behave differently, so both are ported separately.
 */
bool matchesNoProxy(const QString &hostname, int port, const QString &bypass);

} // namespace pipproxytest
