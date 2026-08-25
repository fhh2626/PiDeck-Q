#pragma once

#include <QJsonObject>
#include <QObject>
#include <QPoint>

#include <functional>

class QMimeData;
class QEvent;

/** Converts Qt OS drop events into the authenticated native.fileDrop payload. */
class FileDropController final : public QObject {
public:
    using DropHandler = std::function<void(const QJsonObject &payload)>;

    explicit FileDropController(DropHandler handler, QObject *parent = nullptr);
    bool eventFilter(QObject *watched, QEvent *event) override;

    static bool hasLocalFiles(const QMimeData *mimeData);
    static QJsonObject payload(const QMimeData *mimeData, const QPoint &position);

private:
    DropHandler m_handler;
};
