#include "ChannelContext.h"

#include "ExternalLinks.h"
#include "HostRpcClient.h"
#include "app/FocusQueue.h"
#include "logs/AppLogStore.h"

#include <QDateTime>
#include <QDir>
#include <QHostAddress>
#include <QJsonArray>
#include <QLocale>
#include <QNetworkInterface>
#include <QSet>
#include <QCollator>

#include <algorithm>

namespace {

QString platformName()
{
#ifdef Q_OS_WIN
    return QStringLiteral("win32");
#elif defined(Q_OS_MACOS)
    return QStringLiteral("darwin");
#else
    return QStringLiteral("linux");
#endif
}

QString logsDirectory(const ChannelServices &services)
{
    const QString directory = QDir(services.userDataDir).filePath(QStringLiteral("logs"));
    QDir().mkpath(directory);
    return directory;
}

bool isPrivateIpv4(const QString &address)
{
    const QStringList parts = address.split(QLatin1Char('.'));
    if (parts.size() != 4) return false;
    int octets[4] = {0, 0, 0, 0};
    for (int index = 0; index < 4; ++index) {
        bool ok = false;
        octets[index] = parts.at(index).toInt(&ok);
        if (!ok || octets[index] < 0 || octets[index] > 255) return false;
    }
    // Exactly the oracle's set (`WebNetwork.ts`): 10/8, 172.16/12, 192.168/16.
    // 169.254/16 is link-local, NOT reachable over a LAN — treating it as private put an
    // unreachable address first and the mobile QR code then pointed at a dead host.
    if (octets[0] == 10) return true;
    if (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31) return true;
    if (octets[0] == 192 && octets[1] == 168) return true;
    return false;
}

/** Host-backed channel: forward to the Qt host and answer with its result. */
void hostRequest(ChannelServices &services, const QString &method, const QJsonObject &params,
                 ChannelResponder responder, std::function<QJsonValue(const QJsonValue &)> map = {})
{
    if (!services.host) {
        responder.reject(QStringLiteral("Native host bridge is unavailable"));
        return;
    }
    auto request = services.host->request(method, params);
    request->then([responder, map](const QJsonValue &value) mutable {
        responder.resolve(map ? map(value) : value);
    });
    request->fail([responder](const QString &error) mutable { responder.reject(error); });
}

} // namespace

void registerAppChannels(ChannelRegistry &registry, ChannelServices &services)
{
    registry.add(QStringLiteral("app:info"), [&services](const QJsonArray &) {
        return QJsonObject{
            {QStringLiteral("version"), services.appVersion},
            {QStringLiteral("platform"), platformName()},
        };
    });

    registry.add(QStringLiteral("app:network-addresses"), [](const QJsonArray &) {
        QJsonArray addresses;
        QSet<QString> seen;
        const auto interfaces = QNetworkInterface::allInterfaces();
        for (const QNetworkInterface &network : interfaces) {
            // `QNetworkInterface::allInterfaces()` also returns adapters that are down
            // (unplugged Ethernet, disabled/APIPA links). Node's `os.networkInterfaces()`
            // only reports operational adapters, and an unreachable first entry is exactly
            // the bug the phone QR code suffered from: the settings page offers entry #0.
            const auto flags = network.flags();
            if (!flags.testFlag(QNetworkInterface::IsUp) || !flags.testFlag(QNetworkInterface::IsRunning)) {
                continue;
            }
            const auto entries = network.addressEntries();
            for (const QNetworkAddressEntry &entry : entries) {
                const QHostAddress address = entry.ip();
                if (address.protocol() != QAbstractSocket::IPv4Protocol) continue;
                if (address.isLoopback()) continue;
                const QString text = address.toString();
                if (text.isEmpty() || seen.contains(text)) continue;
                seen.insert(text);
                addresses.append(QJsonObject{
                    {QStringLiteral("address"), text},
                    {QStringLiteral("interfaceName"), network.humanReadableName().isEmpty()
                         ? network.name()
                         : network.humanReadableName()},
                    {QStringLiteral("cidr"), entry.prefixLength() > 0
                         ? QJsonValue(QStringLiteral("%1/%2").arg(text).arg(entry.prefixLength()))
                         : QJsonValue(QJsonValue::Null)},
                    {QStringLiteral("isPrivate"), isPrivateIpv4(text)},
                });
            }
        }
        // The oracle's order is contractual: the settings page offers the first entry as
        // the address a phone should open, and a phone can only reach a private LAN
        // address. Private networks first, then numeric-aware address order.
        QVector<QJsonObject> ordered;
        ordered.reserve(addresses.size());
        for (const QJsonValue &value : addresses) ordered.append(value.toObject());
        QCollator collator;
        collator.setNumericMode(true);
        std::stable_sort(ordered.begin(), ordered.end(),
                         [&collator](const QJsonObject &left, const QJsonObject &right) {
                             const bool leftPrivate = left.value(QStringLiteral("isPrivate")).toBool();
                             const bool rightPrivate = right.value(QStringLiteral("isPrivate")).toBool();
                             if (leftPrivate != rightPrivate) return leftPrivate;
                             return collator.compare(left.value(QStringLiteral("address")).toString(),
                                                     right.value(QStringLiteral("address")).toString())
                                 < 0;
                         });
        QJsonArray sorted;
        for (const QJsonObject &address : ordered) sorted.append(address);
        return sorted;
    });

    registry.add(QStringLiteral("app:preferred-system-languages"), [](const QJsonArray &) {
        return QJsonArray::fromStringList(QLocale::system().uiLanguages());
    });

    // Pending notification/secondary-launch jump target. Pulling must not consume it:
    // the page may pull again after a reload, and only its ACK proves the jump happened.
    registry.add(QStringLiteral("app:get-focus-target-pending"), [&services](const QJsonArray &) {
        return services.focus ? services.focus->peek() : QJsonValue(QJsonValue::Null);
    });
    registry.add(QStringLiteral("app:ack-focus-target"), [&services](const QJsonArray &args) {
        const QJsonValue raw = channels::argAt(args, 0);
        // The renderer is an untrusted boundary: a non-string, empty or oversized id is
        // a malformed request and must never reach the pending-target owner.
        if (!raw.isString()) return QJsonValue(QJsonValue::Null);
        const QString id = raw.toString();
        if (id.isEmpty() || id.size() > 128) return QJsonValue(QJsonValue::Null);
        if (services.focus) services.focus->acknowledge(id);
        return QJsonValue(QJsonValue::Null);
    });

    // Window state is owned by the Qt host. The backend must ask it instead of
    // caching a local boolean, otherwise a title-bar double click desynchronizes.
    registry.addAsync(QStringLiteral("app:window-minimize"), [&services](const QJsonArray &, ChannelResponder responder) {
        hostRequest(services, QStringLiteral("window.minimize"), {}, responder, [](const QJsonValue &) {
            return QJsonValue(QJsonValue::Null);
        });
    });
    registry.addAsync(QStringLiteral("app:window-toggle-maximize"), [&services](const QJsonArray &, ChannelResponder responder) {
        hostRequest(services, QStringLiteral("window.toggleMaximize"), {}, responder);
    });
    registry.addAsync(QStringLiteral("app:window-is-maximized"), [&services](const QJsonArray &, ChannelResponder responder) {
        hostRequest(services, QStringLiteral("window.isMaximized"), {}, responder);
    });
    registry.addAsync(QStringLiteral("app:window-toggle-always-on-top"), [&services](const QJsonArray &, ChannelResponder responder) {
        hostRequest(services, QStringLiteral("window.toggleAlwaysOnTop"), {}, responder);
    });
    registry.addAsync(QStringLiteral("app:window-close"), [&services](const QJsonArray &, ChannelResponder responder) {
        hostRequest(services, QStringLiteral("window.close"), {}, responder, [](const QJsonValue &) {
            return QJsonValue(QJsonValue::Null);
        });
    });
    registry.addAsync(QStringLiteral("app:begin-window-drag"), [&services](const QJsonArray &, ChannelResponder responder) {
        hostRequest(services, QStringLiteral("window.beginSystemMove"), {}, responder, [](const QJsonValue &) {
            return QJsonValue(QJsonValue::Null);
        });
    });
    registry.addAsync(QStringLiteral("app:begin-window-resize"), [&services](const QJsonArray &args, ChannelResponder responder) {
        hostRequest(services, QStringLiteral("window.beginSystemResize"),
                    QJsonObject{{QStringLiteral("edge"), channels::stringArg(args, 0)}}, responder,
                    [](const QJsonValue &) { return QJsonValue(QJsonValue::Null); });
    });
    registry.addAsync(QStringLiteral("app:toggle-devtools"), [&services](const QJsonArray &, ChannelResponder responder) {
        hostRequest(services, QStringLiteral("window.toggleDevTools"), {}, responder, [](const QJsonValue &) {
            return QJsonValue(QJsonValue::Null);
        });
    });
    registry.addAsync(QStringLiteral("app:open-external"), [&services](const QJsonArray &args, ChannelResponder responder) {
        const QJsonValue raw = channels::argAt(args, 0);
        if (!raw.isString()) {
            // The renderer is an untrusted boundary: a non-string is a malformed request,
            // not an empty URL, and must never reach the host.
            responder.reject(QStringLiteral("Invalid external URL"));
            return;
        }
        const QString url = raw.toString();
        if (!externallinks::isAllowedSystemProtocol(url)) {
            // Observable, not silent: the oracle logs a warning and resolves, so a model
            // emitting `file:`/`search-ms:` cannot launch a local handler and cannot break
            // the caller's flow either.
            if (services.appLog) {
                services.appLog->write(QStringLiteral("warn"), QStringLiteral("browser"),
                                       QStringLiteral("Rejected external link with non-allowlisted protocol"),
                                       QJsonObject{{QStringLiteral("url"), url}});
            }
            responder.resolve(QJsonValue(QJsonValue::Null));
            return;
        }
        if (!services.host) {
            responder.reject(QStringLiteral("Native host bridge is unavailable"));
            return;
        }
        const bool httpLike = externallinks::isHttpLike(url);
        auto request = services.host->request(QStringLiteral("shell.openExternal"),
                                              QJsonObject{{QStringLiteral("url"), url}});
        request->then([responder](const QJsonValue &) mutable {
            responder.resolve(QJsonValue(QJsonValue::Null));
        });
        request->fail([responder, url, httpLike, &services](const QString &message) mutable {
            if (httpLike) {
                // Web failures stay actionable (the update flow reports them).
                responder.reject(message);
                return;
            }
            // A missing mail/editor handler is a normal environment state.
            if (services.appLog) {
                services.appLog->write(QStringLiteral("warn"), QStringLiteral("browser"),
                                       QStringLiteral("Failed to open non-http external link"),
                                       QJsonObject{{QStringLiteral("url"), url},
                                                   {QStringLiteral("error"), message}});
            }
            responder.resolve(QJsonValue(QJsonValue::Null));
        });
    });
    registry.addAsync(QStringLiteral("app:restart"), [&services](const QJsonArray &, ChannelResponder responder) {
        hostRequest(services, QStringLiteral("application.restart"), {}, responder, [](const QJsonValue &) {
            return QJsonValue(QJsonValue::Null);
        });
    });
}
