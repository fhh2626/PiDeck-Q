#include "WindowsToastNotifier.h"

#ifdef Q_OS_WIN
#include <mutex>

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <propkey.h>
#include <propvarutil.h>
#include <shlobj.h>
#include <shobjidl.h>

#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Data.Xml.Dom.h>
#include <winrt/Windows.UI.Notifications.h>

#include <QDir>
#include <QFileInfo>
#endif

namespace {
#ifdef Q_OS_WIN
std::mutex apartmentMutex;
bool apartmentInitialized = false;
bool applicationRegistered = false;

QString appUserModelId()
{
    return qEnvironmentVariable("PIDECK_APP_USER_MODEL_ID", QStringLiteral("com.ayuayue.pi-desktop"));
}
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
    std::lock_guard lock(apartmentMutex);
    return apartmentInitialized && applicationRegistered;
#else
    return false;
#endif
}

bool WindowsToastNotifier::initialize()
{
#ifdef Q_OS_WIN
    std::lock_guard lock(apartmentMutex);
    if (apartmentInitialized) return true;
    try {
        winrt::init_apartment(winrt::apartment_type::single_threaded);
        apartmentInitialized = true;
    } catch (...) {
        apartmentInitialized = false;
    }
    return apartmentInitialized;
#else
    return false;
#endif
}

bool WindowsToastNotifier::registerApplication(const QString &executablePath,
                                                const QString &shortcutPath)
{
#ifdef Q_OS_WIN
    if (!initialize() || executablePath.trimmed().isEmpty()) return false;
    const QString appId = appUserModelId();
    if (appId.isEmpty() || appId.size() > 128) return false;

    QString resolvedShortcut = shortcutPath;
    if (resolvedShortcut.isEmpty()) {
        PWSTR programsPath = nullptr;
        if (FAILED(SHGetKnownFolderPath(FOLDERID_Programs, KF_FLAG_CREATE, nullptr, &programsPath))) {
            return false;
        }
        const QString shortcutName = qEnvironmentVariable("PIDECK_TOAST_SHORTCUT_NAME").trimmed();
        resolvedShortcut = QDir(QString::fromWCharArray(programsPath))
            .filePath(shortcutName.isEmpty() ? QStringLiteral("PiDeck-Q.lnk") : shortcutName);
        CoTaskMemFree(programsPath);
    }
    if (!QDir().mkpath(QFileInfo(resolvedShortcut).absolutePath())) return false;

    IShellLinkW *shellLink = nullptr;
    HRESULT result = CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER,
                                      IID_IShellLinkW, reinterpret_cast<void **>(&shellLink));
    if (SUCCEEDED(result)) {
        const QString executable = QDir::toNativeSeparators(
            QFileInfo(executablePath).absoluteFilePath());
        result = shellLink->SetPath(reinterpret_cast<LPCWSTR>(executable.utf16()));
    }

    IPropertyStore *propertyStore = nullptr;
    if (SUCCEEDED(result)) result = shellLink->QueryInterface(
        IID_IPropertyStore, reinterpret_cast<void **>(&propertyStore));
    PROPVARIANT appIdValue;
    PropVariantInit(&appIdValue);
    if (SUCCEEDED(result)) {
        result = InitPropVariantFromString(
            reinterpret_cast<LPCWSTR>(appId.utf16()), &appIdValue);
        if (SUCCEEDED(result)) result = propertyStore->SetValue(PKEY_AppUserModel_ID, appIdValue);
        if (SUCCEEDED(result)) result = propertyStore->Commit();
    }
    PropVariantClear(&appIdValue);
    if (propertyStore) propertyStore->Release();

    IPersistFile *persistFile = nullptr;
    if (SUCCEEDED(result)) result = shellLink->QueryInterface(
        IID_IPersistFile, reinterpret_cast<void **>(&persistFile));
    if (SUCCEEDED(result)) {
        const QString shortcut = QDir::toNativeSeparators(resolvedShortcut);
        result = persistFile->Save(reinterpret_cast<LPCWSTR>(shortcut.utf16()), TRUE);
    }
    if (persistFile) persistFile->Release();
    if (shellLink) shellLink->Release();
    if (FAILED(result)) return false;

    const bool registered = SUCCEEDED(SetCurrentProcessExplicitAppUserModelID(
        reinterpret_cast<LPCWSTR>(appId.utf16())));
    {
        std::lock_guard lock(apartmentMutex);
        applicationRegistered = registered;
    }
    return registered;
#else
    Q_UNUSED(executablePath);
    Q_UNUSED(shortcutPath);
    return false;
#endif
}

void WindowsToastNotifier::uninitialize()
{
#ifdef Q_OS_WIN
    std::lock_guard lock(apartmentMutex);
    if (apartmentInitialized) {
        winrt::uninit_apartment();
        apartmentInitialized = false;
        applicationRegistered = false;
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
        document.LoadXml(winrt::hstring(
            reinterpret_cast<const wchar_t *>(xml.utf16()),
            static_cast<uint32_t>(xml.size())));
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
        const QString appId = appUserModelId();
        const auto notifier = winrt::Windows::UI::Notifications::ToastNotificationManager::CreateToastNotifier(
            winrt::hstring(reinterpret_cast<const wchar_t *>(appId.utf16()),
                           static_cast<uint32_t>(appId.size())));
        notifier.Show(notification);
        Q_UNUSED(id);
    } catch (const winrt::hresult_error &error) {
        const winrt::hstring message = error.message();
        if (onFailed) onFailed(QString::fromWCharArray(
            message.c_str(), static_cast<qsizetype>(message.size())));
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
