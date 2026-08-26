#pragma once

#include <QString>

#include <functional>

class WindowsToastNotifier final {
public:
    using ClickHandler = std::function<void()>;
    using DismissHandler = std::function<void()>;
    using FailureHandler = std::function<void(const QString &)>;

    static bool isSupported();
    static bool initialize();
    static void uninitialize();
    static void show(const QString &id, const QString &title, const QString &body,
                     bool silent, const QString &activationUrl,
                     ClickHandler onClick, DismissHandler onDismissed,
                     FailureHandler onFailed);
};
