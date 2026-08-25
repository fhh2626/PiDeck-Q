#pragma once

#include <QString>

#include <functional>

class WindowsToastNotifier final {
public:
    using ClickHandler = std::function<void()>;
    using FailureHandler = std::function<void(const QString &)>;

    static bool isSupported();
    static void show(const QString &id, const QString &title, const QString &body,
                     bool silent, const QString &activationUrl,
                     ClickHandler onClick, FailureHandler onFailed);
};
