#include "FileDropController.h"

#include <QDragEnterEvent>
#include <QDropEvent>
#include <QEvent>
#include <QJsonArray>
#include <QMimeData>
#include <QUrl>

FileDropController::FileDropController(DropHandler handler, QObject *parent)
    : QObject(parent),
      m_handler(std::move(handler))
{
}

bool FileDropController::eventFilter(QObject *, QEvent *event)
{
    if (event->type() == QEvent::DragEnter) {
        auto *drag = static_cast<QDragEnterEvent *>(event);
        if (hasLocalFiles(drag->mimeData())) {
            drag->acceptProposedAction();
            return true;
        }
    }
    if (event->type() == QEvent::Drop) {
        auto *drop = static_cast<QDropEvent *>(event);
        if (hasLocalFiles(drop->mimeData())) {
            if (m_handler) m_handler(payload(drop->mimeData(), drop->position().toPoint()));
            drop->acceptProposedAction();
            return true;
        }
    }
    return false;
}

bool FileDropController::hasLocalFiles(const QMimeData *mimeData)
{
    if (!mimeData) return false;
    for (const QUrl &url : mimeData->urls()) {
        if (url.isLocalFile()) return true;
    }
    return false;
}

QJsonObject FileDropController::payload(const QMimeData *mimeData, const QPoint &position)
{
    QJsonArray paths;
    if (mimeData) {
        for (const QUrl &url : mimeData->urls()) {
            if (url.isLocalFile()) paths.append(url.toLocalFile());
        }
    }
    return QJsonObject{
        {QStringLiteral("paths"), paths},
        {QStringLiteral("x"), position.x()},
        {QStringLiteral("y"), position.y()},
    };
}
