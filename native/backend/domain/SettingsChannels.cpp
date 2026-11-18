#include "ChannelContext.h"

#include "EventHub.h"
#include "HostRpcClient.h"
#include "ModelPreferenceValidation.h"
#include "SettingsCatalog.h"
#include "WslController.h"
#include "logs/AppLogStore.h"
#include "net/DesktopProxy.h"
#include "net/PiProxyTest.h"
#include "web/WebServiceManager.h"

#include <QDir>
#include <QJsonArray>
#include <QJsonObject>
#include <QJsonValue>

namespace {

QString settingsPath(const ChannelServices &services)
{
    return QDir(services.userDataDir).filePath(QStringLiteral("settings.json"));
}

bool touchesWebService(const QJsonObject &patch)
{
    return patch.contains(QStringLiteral("webServiceEnabled"))
        || patch.contains(QStringLiteral("webServiceHost"))
        || patch.contains(QStringLiteral("webServicePort"))
        || patch.contains(QStringLiteral("webServiceAccessToken"));
}

/** The three settings the WSL environment (scanner + managers + catalog identity) follows. */
bool touchesWsl(const QJsonObject &patch)
{
    return patch.contains(QStringLiteral("wslEnabled"))
        || patch.contains(QStringLiteral("wslDistro"))
        || patch.contains(QStringLiteral("wslUser"));
}

/**
 * Apply the persisted web settings, mapping a structured lifecycle failure to the
 * oracle's localized copy.
 *
 * The oracle disables the feature again when the new settings cannot start a listener:
 * leaving `webServiceEnabled:true` in the file would make every later launch retry a
 * configuration the user has to see failing.
 */
void applyWebServiceSettings(ChannelServices &services, const QJsonObject &settings)
{
    if (!services.web) throw ChannelError(QStringLiteral("webService.startFailed"));
    try {
        services.web->applySettings(settings);
    } catch (const WebServiceManager::Error &error) {
        const QString detail = QString::fromUtf8(error.what());
        if (services.appLog) {
            services.appLog->write(QStringLiteral("warn"), QStringLiteral("web"),
                                   QStringLiteral("Failed to apply web service settings"),
                                   QJsonObject{{QStringLiteral("error"), detail}});
        }
        if (settings.value(QStringLiteral("webServiceEnabled")).toBool()) {
            updateSettingsCatalog(settingsPath(services),
                                  QJsonObject{{QStringLiteral("webServiceEnabled"), false}},
                                  services.agentDir);
        }
        const QString message = services.translate(
            error.code() == QLatin1String("WEB_SERVICE_INVALID_PORT")
                ? QStringLiteral("webService.invalidPort")
                : QStringLiteral("webService.startFailed"),
            QJsonObject{});
        throw ChannelError(message);
    }
}

} // namespace

void registerSettingsChannels(ChannelRegistry &registry, ChannelServices &services)
{
    registry.add(QStringLiteral("settings:get"), [&services](const QJsonArray &) {
        const SettingsCatalogRead settings = readSettingsCatalog(settingsPath(services), services.agentDir);
        return channels::requireOk(settings.ok, settings.error, settings.settings);
    });

    registry.addAsync(QStringLiteral("settings:update"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
        const QJsonObject patch = channels::objectArg(args, 0);
        const SettingsCatalogRead settings =
            modelconfig::updateDesktopSettings(services, settingsPath(services), patch);
        if (!settings.ok) {
            responder.reject(settings.error);
            return;
        }

        // The native menu is a host capability and never has a renderer-side toggle.
        if (services.host) {
            auto request = services.host->request(QStringLiteral("application.hideMenu"), QJsonObject{});
            request->fail([](const QString &) {});
        }

        // Title-bar chrome is applied by the host; the renderer re-reads settings only
        // for zoom, which is a renderer-owned value (matching settingsIpc.ts).
        const bool titleBarChanged = patch.contains(QStringLiteral("useNativeTitleBar"))
            || patch.contains(QStringLiteral("closeToTray"));
        if (titleBarChanged && services.host) {
            auto request = services.host->request(
                QStringLiteral("window.applySettings"),
                QJsonObject{
                    {QStringLiteral("useNativeTitleBar"),
                     settings.settings.value(QStringLiteral("useNativeTitleBar")).toBool()},
                    {QStringLiteral("closeToTray"),
                     settings.settings.value(QStringLiteral("closeToTray")).toBool()},
                });
            request->fail([](const QString &) {});
        }
        if (patch.contains(QStringLiteral("zoomFactor")) && services.events) {
            services.events->broadcast(QStringLiteral("settings:apply-window"),
                                       QJsonArray{settings.settings});
        }
        // A different pi binary/runtime exposes a different model set. Re-probe off the
        // main thread and push `models:changed`; the renderer then re-reads the list.
        if (patch.contains(QStringLiteral("piRuntimePreference"))
            || patch.contains(QStringLiteral("piTypescriptPath"))
            || patch.contains(QStringLiteral("piRustPath"))
            || patch.contains(QStringLiteral("piBoltPath"))) {
            publishModelList(services);
        }
        // Desktop proxy changes take effect immediately: every outbound request reads the
        // applied config, so no manager needs to be rebuilt and no restart is required.
        // Only the mode is logged; the URL may embed credentials.
        if (desktopproxy::touchesSettings(patch)) {            const desktopproxy::Config config = desktopproxy::apply(settings.settings);
            if (services.appLog) {
                services.appLog->write(
                    QStringLiteral("info"), QStringLiteral("settings"),
                    QStringLiteral("Desktop proxy applied"),
                    QJsonObject{{QStringLiteral("mode"),
                                 config.mode == desktopproxy::Mode::FixedServers
                                     ? QStringLiteral("fixed_servers")
                                     : QStringLiteral("direct")}});
            }
        }
        // LAN web settings are applied *after* everything else succeeded: a failed bind
        // must not half-apply an unrelated preference.
        if (touchesWebService(patch)) {
            try {
                applyWebServiceSettings(services, settings.settings);
            } catch (const ChannelError &failure) {
                responder.reject(failure.message());
                return;
            }
        }
        // WSL settings change the active environment: the scanner, the skill/prompt/
        // extension managers, the pi config directory and the catalog's session identity
        // all follow (oracle systemIpc.ts `wslEnabled|wslDistro|wslUser` branch). The
        // switch is answered asynchronously because resolving the distro runs a real
        // `wsl.exe printenv HOME`; answering early would let the renderer list the old
        // distro's skills right after showing the new one as saved.
        if (touchesWsl(patch) && services.wsl) {
            const QJsonObject updated = settings.settings;
            const bool enabled = updated.value(QStringLiteral("wslEnabled")).toBool(false);
            const QString distro = updated.value(QStringLiteral("wslDistro")).toString();
            const QString user = updated.value(QStringLiteral("wslUser")).toString();
            services.wsl->request(enabled, distro, user, [responder, updated]() mutable {
                responder.resolve(QJsonValue(updated));
            });
            return;
        }
        responder.resolve(QJsonValue(settings.settings));
    });

    // Reads its own socket instead of going through fetch, so success proves the real
    // proxy protocol path (absolute-URI GET or CONNECT + TLS) rather than a library
    // assumption. The result shape is `PiProxyTestResult` verbatim.
    registry.addAsync(QStringLiteral("settings:test-pi-proxy"),
                      [&services](const QJsonArray &, ChannelResponder responder) {
                          const SettingsCatalogRead settings =
                              readSettingsCatalog(settingsPath(services), services.agentDir);
                          // Test seam: the oracle's target is pinned to api.openai.com, which
                          // no offline test may reach. Production never sets this variable.
                          QString testUrl = qEnvironmentVariable("PIDECK_PROXY_TEST_URL");
                          if (testUrl.isEmpty()) testUrl = pipproxytest::defaultTestUrl();
                          pipproxytest::test(
                              pipproxytest::readSettings(settings.settings), testUrl,
                              services.translate,
                              [&services, responder](const QJsonObject &result) mutable {
                                  if (services.appLog) {
                                      QJsonObject fields{
                                          {QStringLiteral("success"),
                                           result.value(QStringLiteral("success"))},
                                          {QStringLiteral("elapsedMs"),
                                           result.value(QStringLiteral("elapsedMs"))}};
                                      if (result.contains(QStringLiteral("statusCode"))) {
                                          fields.insert(QStringLiteral("statusCode"),
                                                        result.value(QStringLiteral("statusCode")));
                                      }
                                      if (result.contains(QStringLiteral("error"))) {
                                          fields.insert(QStringLiteral("error"),
                                                        result.value(QStringLiteral("error")));
                                      }
                                      services.appLog->write(QStringLiteral("info"),
                                                             QStringLiteral("settings"),
                                                             QStringLiteral("Pi proxy tested"), fields);
                                  }
                                  responder.resolve(result);
                              });
                      });

    // A restart keeps the persisted host/port/token: the settings page is the only owner
    // of those values, so "restart" can never silently move the service to a new port.
    registry.add(QStringLiteral("settings:restart-web-service"),
                 [&services](const QJsonArray &) -> QJsonValue {
                     if (!services.web) throw ChannelError(QStringLiteral("webService.startFailed"));
                     const QJsonObject settings =
                         readSettingsCatalog(settingsPath(services), services.agentDir).settings;
                     // A disabled service stays disabled: restart must not start something
                     // the user turned off.
                     if (!settings.value(QStringLiteral("webServiceEnabled")).toBool()) {
                         return QJsonValue(QJsonValue::Null);
                     }
                     try {
                         services.web->restart(settings);
                     } catch (const WebServiceManager::Error &error) {
                         throw ChannelError(QString::fromUtf8(error.what()));
                     }
                     return QJsonValue(QJsonValue::Null);
                 });
}
