#pragma once

#include <QJsonObject>
#include <QMetaObject>
#include <QStringList>

#include <functional>

class ClipboardController final {
public:
    using ChangedHandler = std::function<void(const QJsonObject &snapshot)>;

    explicit ClipboardController(ChangedHandler onChanged = {});
    ~ClipboardController();

    QJsonObject snapshot() const;
    QJsonObject metadataSnapshot() const;
    void snapshotAsync(ChangedHandler onReady) const;
    QStringList filePaths() const;
    static QString decodeWindowsDropPath(const wchar_t *value, int length);

private:
    ChangedHandler m_onChanged;
    QMetaObject::Connection m_dataChangedConnection;
    quint64 m_sequence = 0;
};
