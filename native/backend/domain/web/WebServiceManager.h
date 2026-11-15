#pragma once

#include "ChannelContext.h"
#include "TextEncoding.h"

#include <QJsonObject>
#include <QObject>
#include <QString>

#include <functional>
#include <stdexcept>
#include <string>

class ChannelRegistry;
class LanWebService;

/**
 * Lifecycle owner of the LAN web service (port of `WebServiceManager`).
 *
 * The user enables the service in Settings; this class is the only place that decides
 * whether it is listening, on which host/port and with which access token. Everything
 * else (`settings:update`, `settings:restart-web-service`, startup) goes through it.
 *
 * Failures are structured, never silent: a bad port fails with `WEB_SERVICE_INVALID_PORT`,
 * a bad token with `WEB_SERVICE_INVALID_TOKEN`, a bind failure with
 * `WEB_SERVICE_START_FAILED`, and `settings:update` turns any of them into the localized
 * `webService.*` copy while disabling the feature again (fail closed).
 */
class WebServiceManager : public QObject {

public:
    /**
     * Structured lifecycle failure.
     *
     * `code` mirrors the oracle's `WEB_SERVICE_*` codes; the message is for the log only
     * (the user sees the localized `webService.*` copy).
     *
     * Both fields are std::string built by *our* code, never by Qt: `std::string` has no
     * stable ABI on MSVC and this Qt package is prebuilt with a different
     * `_ITERATOR_DEBUG_LEVEL`, so `QString::toStdString`/`fromStdString` corrupt the value
     * (see TextEncoding.h). The reverse conversion therefore goes through UTF-8 bytes.
     */
    class Error : public std::runtime_error {
    public:
        Error(std::string code, const QString &message)
            : std::runtime_error(textenc::toUtf8(message)), m_code(std::move(code))
        {
        }
        QString code() const
        {
            return QString::fromUtf8(m_code.data(), qsizetype(m_code.size()));
        }

    private:
        std::string m_code;
    };

    using LogSink = std::function<void(const QString &level, const QString &message,
                                       const QJsonObject &detail)>;

    WebServiceManager(ChannelRegistry *registry, ChannelServices *services, QString userDataDir,
                      QString rendererRoot, QString devRendererUrl = QString(),
                      QObject *parent = nullptr);

    /**
     * Apply the persisted settings.
     *
     * Disabled -> stop; same host/port -> hot-swap the token only (already issued cookies
     * die immediately); anything else -> stop and rebind. Throws `Error` on invalid input
     * or a failed bind.
     */
    void applySettings(const QJsonObject &settings);

    /** Restart without touching persisted settings; a disabled service is a no-op. */
    void restart(const QJsonObject &settings);

    /**
     * Startup form of `applySettings`: never throws, logs a warning and disables the
     * feature in the settings file when the service cannot start.
     */
    void applySettingsAtStartup(const QJsonObject &settings);

    /** Release the listener; called from the backend shutdown path. */
    void shutdown();

    bool running() const;

    void setLogSink(LogSink sink);

private:
    void applyNow(const QJsonObject &settings);
    void restartNow(const QJsonObject &settings);
    /** Disable the feature after a failed apply, exactly like the oracle's catch block. */
    void disableAfterFailure(const QString &error);
    /** `settings.json` writer used only for the fail-closed disable. */
    void persistDisabled(const QString &reason);

    ChannelRegistry *m_registry = nullptr;
    ChannelServices *m_services = nullptr;
    QString m_userDataDir;
    LanWebService *m_service = nullptr;
    LogSink m_logSink;
};
