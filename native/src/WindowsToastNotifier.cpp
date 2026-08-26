#include "WindowsToastNotifier.h"

#ifdef Q_OS_WIN
#include <mutex>
#include <string>

#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Data.Xml.Dom.h>
#include <winrt/Windows.UI.Notifications.h>
#endif

namespace {
#ifdef Q_OS_WIN
std::once_flag apartmentOnce;
bool apartmentInitialized = false;
#endif

QString escapeXml(const QString &value)
{
    QString result = value;
    return result.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;");
}
}

bool WindowsToastNotifier::isSupported()
{
#ifdef Q_OS_WIN
    return true;
#else
    return false;
#endif
}

bool WindowsToastNotifier::initialize()
{
#ifdef Q_OS_WIN
    std::call_once(apartmentOnce, [] {
        try {
            winrt::init_apartment(winrt::apartment_type::single_threaded);
            apartmentInitialized = true;
        } catch (...) {
            apartmentInitialized = false;
        }
    });
    return apartmentInitialized;
#else
    return false;
#endif
}

void WindowsToastNotifier::uninitialize()
{
#ifdef Q_OS_WIN
    if (apartmentInitialized) {
        winrt::uninit_apartment();
        apartmentInitialized = false;
    }
#endif
}

void WindowsToastNotifier::show(const QString &id, const QString &title, const QString &body,
                                bool silent, const QString &activationUrl,
                                ClickHandler onClick, DismissHandler onDismissed,
                                FailureHandler onFailed)
{
#ifdef Q_OS_WIN
    try {
        if (!initialize()) {
            if (onFailed) onFailed(QStringLiteral("Windows toast apartment initialization failed"));
            return;
        }
        const QString launch = activationUrl.isEmpty() ? QStringLiteral("pideck://") : activationUrl;
        const QString audio = silent ? QString{} : QStringLiteral(
            "<audio src=\"ms-winsoundevent:Notification.Default\"/>");
        const QString xml = QStringLiteral(
            "<toast activationType=\"protocol\" launch=\"%1\">"
            "<visual><binding template=\"ToastGeneric\"><text>%2</text><text>%3</text>"
            "</binding></visual>%4</toast>")
            .arg(escapeXml(launch), escapeXml(title), escapeXml(body), audio);

        winrt::Windows::Data::Xml::Dom::XmlDocument document;
        document.LoadXml(xml.toStdWString());
        winrt::Windows::UI::Notifications::ToastNotification notification(document);
        // Keep copies for the asynchronous WinRT event and the synchronous
        // exception path. Moving the failure callback into Failed() would leave
        // the catch block unable to report LoadXml/Create/Show failures.
        const auto clickHandler = onClick;
        const auto dismissHandler = onDismissed;
        const auto failureHandler = onFailed;
        notification.Activated([clickHandler](auto const &, auto const &) {
            if (clickHandler) clickHandler();
        });
        notification.Dismissed([dismissHandler](auto const &, auto const &) {
            if (dismissHandler) dismissHandler();
        });
        notification.Failed([failureHandler](auto const &, auto const &) {
            if (failureHandler) failureHandler(QStringLiteral("Windows toast failed"));
        });
        const QString appUserModelId = qEnvironmentVariable(
            "PIDECK_APP_USER_MODEL_ID", QStringLiteral("com.ayuayue.pi-desktop"));
        const std::wstring appUserModelIdWide = appUserModelId.toStdWString();
        const auto notifier = winrt::Windows::UI::Notifications::ToastNotificationManager::CreateToastNotifier(
            appUserModelIdWide.c_str());
        notifier.Show(notification);
        Q_UNUSED(id);
    } catch (const winrt::hresult_error &error) {
        if (onFailed) onFailed(QString::fromStdWString(error.message().c_str()));
    }
#else
    Q_UNUSED(id);
    Q_UNUSED(title);
    Q_UNUSED(body);
    Q_UNUSED(silent);
    Q_UNUSED(activationUrl);
    Q_UNUSED(onClick);
    Q_UNUSED(onDismissed);
    if (onFailed) onFailed(QStringLiteral("Windows toast is unavailable"));
#endif
}
