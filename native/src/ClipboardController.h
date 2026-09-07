#pragma once

#include <QJsonObject>
#include <QMetaObject>
#include <QStringList>
#include <QVector>

#include <functional>
#include <memory>

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
    struct SnapshotState;
    static void requestSnapshot(const std::shared_ptr<SnapshotState> &state, ChangedHandler onReady);

    ChangedHandler m_onChanged;
    QMetaObject::Connection m_dataChangedConnection;
    quint64 m_sequence = 0;
    std::shared_ptr<SnapshotState> m_snapshotState;
};
