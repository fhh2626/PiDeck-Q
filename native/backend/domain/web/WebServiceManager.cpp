#include "WebServiceManager.h"

#include "ChannelRegistry.h"
#include "SettingsCatalog.h"
#include "WebService.h"
#include "logs/AppLogStore.h"

#include <QDir>

#include <QJsonValue>

#include <cmath>

namespace {

constexpr const char *kInvalidPort = "WEB_SERVICE_INVALID_PORT";
constexpr const char *kInvalidToken = "WEB_SERVICE_INVALID_TOKEN";
constexpr const char *kStartFailed = "WEB_SERVICE_START_FAILED";

QString settingsFile(const QString &userDataDir)
{
    return QDir(userDataDir).filePath(QStringLiteral("settings.json"));
}

/**
 * `normalizePort`: an integer in [1, 65535].
 *
 * Port 0 is rejected rather than "pick an ephemeral port": the access URL, the QR code
 * and the cookie name all embed the configured port, so a random port would hand out a
 * URL that no longer matches the settings the user sees.
 */
int normalizePort(const QJsonValue &value)
{
    double port = std::nan("");
    if (value.isDouble()) {
        port = value.toDouble();
    } else if (value.isString()) {
        bool ok = false;
        port = value.toString().trimmed().toDouble(&ok);
        if (!ok) throw WebServiceManager::Error(kInvalidPort, "Invalid web service port");
    } else {
        throw WebServiceManager::Error(kInvalidPort, "Invalid web service port");
    }
    if (!std::isfinite(port) || std::floor(port) != port || port < 1 || port > 65535) {
        throw WebServiceManager::Error(kInvalidPort, "Invalid web service port");
    }
    return int(port);
}

/** A validated listen target; both lifecycle paths share the same normalization. */
struct Endpoint {
    QString host;
    int port = 0;
    QString token;
};

Endpoint endpointFrom(const QJsonObject &settings)
{
    Endpoint endpoint;
    endpoint.host = settings.value(QStringLiteral("webServiceHost")).toString().trimmed();
    if (endpoint.host.isEmpty()) endpoint.host = QStringLiteral("0.0.0.0");
    endpoint.port = normalizePort(settings.value(QStringLiteral("webServicePort")));
    endpoint.token = settings.value(QStringLiteral("webServiceAccessToken")).toString();
    if (!isValidWebServiceAccessToken(endpoint.token)) {
        throw WebServiceManager::Error(kInvalidToken, "Invalid web service token");
    }
    return endpoint;
}

} // namespace

WebServiceManager::WebServiceManager(ChannelRegistry *registry, ChannelServices *services,
                                     QString userDataDir, QString rendererRoot,
                                     QString devRendererUrl, QObject *parent)
    : QObject(parent),
      m_registry(registry),
      m_services(services),
      m_userDataDir(std::move(userDataDir))
{
    LanWebService::Options options;
    // The LAN bundle lives in the renderer root the host injected: `web.html` plus its
    // hashed assets are shipped beside the desktop shell.
    options.rendererRoot = std::move(rendererRoot);
    // Dev proxy target (Vite). Empty in every packaged run; the service validates it.
    options.devRendererUrl = std::move(devRendererUrl);
    m_service = new LanWebService(registry, services, options, this);
    m_service->setLogSink([this](const QString &level, const QString &message,
                                 const QJsonObject &detail) {
        if (m_logSink) m_logSink(level, message, detail);
        if (!m_services || !m_services->appLog) return;
        m_services->appLog->write(level, QStringLiteral("web"), message, detail);
    });
}

void WebServiceManager::setLogSink(LogSink sink)
{
    m_logSink = std::move(sink);
}

bool WebServiceManager::running() const
{
    return m_service && m_service->running();
}

void WebServiceManager::applySettings(const QJsonObject &settings)
{
    applyNow(settings);
}

void WebServiceManager::applyNow(const QJsonObject &settings)
{
    if (!settings.value(QStringLiteral("webServiceEnabled")).toBool()) {
        shutdown();
        return;
    }
    const Endpoint endpoint = endpointFrom(settings);
    if (m_service->running() && m_service->boundHost() == endpoint.host
        && m_service->boundPort() == endpoint.port) {
        // Same endpoint: only the token changed. Rebinding would drop every open browser
        // connection for no reason, and the old cookies stop working immediately.
        m_service->setAccessToken(endpoint.token);
        return;
    }
    shutdown();
    if (!m_service->start(endpoint.host, endpoint.port, endpoint.token)) {
        throw Error(kStartFailed,
                    QStringLiteral("Web service failed to listen on %1:%2")
                        .arg(endpoint.host)
                        .arg(endpoint.port));
    }
}

void WebServiceManager::restart(const QJsonObject &settings)
{
    restartNow(settings);
}

void WebServiceManager::restartNow(const QJsonObject &settings)
{
    // A restart must not start a service the user disabled: the settings page owns that.
    if (!settings.value(QStringLiteral("webServiceEnabled")).toBool()) return;
    // ...but an enabled service is genuinely restarted, not "applied": the oracle's
    // `restartNow` always stops and starts, even on the same endpoint, so the operator gets
    // a fresh listener (new token, no inherited sockets) from the Restart button. Reusing
    // `applyNow` here would make Restart a no-op whenever only the token had changed.
    const Endpoint endpoint = endpointFrom(settings);
    shutdown();
    if (!m_service->start(endpoint.host, endpoint.port, endpoint.token)) {
        throw Error(kStartFailed,
                    QStringLiteral("Web service failed to listen on %1:%2")
                        .arg(endpoint.host)
                        .arg(endpoint.port));
    }
}

void WebServiceManager::applySettingsAtStartup(const QJsonObject &settings)
{
    try {
        applyNow(settings);
    } catch (const Error &error) {
        disableAfterFailure(QString::fromUtf8(error.what()));
    } catch (const std::exception &error) {
        disableAfterFailure(QString::fromUtf8(error.what()));
    }
}

void WebServiceManager::disableAfterFailure(const QString &error)
{
    if (m_services && m_services->appLog) {
        m_services->appLog->write(QStringLiteral("warn"), QStringLiteral("web"),
                                  QStringLiteral("Web service disabled after apply failure"),
                                  QJsonObject{{QStringLiteral("error"), error}});
    }
    if (m_logSink) {
        m_logSink(QStringLiteral("warn"), QStringLiteral("Web service disabled after apply failure"),
                  QJsonObject{{QStringLiteral("error"), error}});
    }
    shutdown();
    persistDisabled(error);
}

void WebServiceManager::persistDisabled(const QString &reason)
{
    Q_UNUSED(reason);
    const SettingsCatalogRead written = updateSettingsCatalog(
        settingsFile(m_userDataDir),
        QJsonObject{{QStringLiteral("webServiceEnabled"), false}},
        m_services ? m_services->agentDir : QString());
    if (!written.ok) {
        if (m_services && m_services->appLog) {
            m_services->appLog->write(QStringLiteral("warn"), QStringLiteral("web"),
                                      QStringLiteral("Failed to disable the web service"),
                                      QJsonObject{{QStringLiteral("error"), written.error}});
        }
    }
}

void WebServiceManager::shutdown()
{
    if (m_service) m_service->stop();
}
