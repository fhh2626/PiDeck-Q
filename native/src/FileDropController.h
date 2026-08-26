#pragma once

#include <QJsonObject>
#include <QObject>
#include <QPoint>

#include <functional>

class QMimeData;
class QEvent;
class QWindow;

/** Converts Qt OS drop events into the authenticated native.fileDrop payload. */
class FileDropController final : public QObject {
public:
    using DropHandler = std::function<void(const QJsonObject &payload)>;

    explicit FileDropController(DropHandler handler, QWindow *coordinateSurface,
                                 QObject *parent = nullptr);
    bool eventFilter(QObject *watched, QEvent *event) override;

    static bool hasLocalFiles(const QMimeData *mimeData);
    static QPoint toWebViewClientPosition(QWindow *coordinateSurface, QObject *watched,
                                           const QPoint &localPosition);
    static QJsonObject payload(const QMimeData *mimeData, const QPoint &clientPosition);

private:
    DropHandler m_handler;
    QWindow *m_coordinateSurface = nullptr;
};
