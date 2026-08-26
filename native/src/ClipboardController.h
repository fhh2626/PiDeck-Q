#pragma once

#include <QJsonObject>
#include <QStringList>

#include <functional>

class ClipboardController final {
public:
    using ChangedHandler = std::function<void(const QJsonObject &snapshot)>;

    explicit ClipboardController(ChangedHandler onChanged = {});

    QJsonObject snapshot() const;
    QStringList filePaths() const;
    static QString decodeWindowsDropPath(const wchar_t *value, int length);

private:
    ChangedHandler m_onChanged;
};
