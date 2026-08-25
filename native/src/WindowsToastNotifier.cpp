#include "WindowsToastNotifier.h"

#ifdef Q_OS_WIN
#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Data.Xml.Dom.h>
#include <winrt/Windows.UI.Notifications.h>
#endif

namespace {
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

void WindowsToastNotifier::show(const QString &id, const QString &title, const QString &body,
                                bool silent, const QString &activationUrl,
                                ClickHandler onClick, FailureHandler onFailed)
{
#ifdef Q_OS_WIN
    try {
        winrt::init_apartment(winrt::apartment_type::single_threaded);
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
        notification.Activated([handler = std::move(onClick)](auto const &, auto const &) {
            if (handler) handler();
        });
        notification.Failed([handler = std::move(onFailed)](auto const &, auto const &) {
            if (handler) handler(QStringLiteral("Windows toast failed"));
        });
        const auto notifier = winrt::Windows::UI::Notifications::ToastNotificationManager::CreateToastNotifier(
            L"com.ayuayue.pi-desktop");
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
    if (onFailed) onFailed(QStringLiteral("Windows toast is unavailable"));
#endif
}
