#include "FileDropController.h"
#include "NativeFilePathLimits.h"

#include <QDragEnterEvent>
#include <QDropEvent>
#include <QEvent>
#include <QJsonArray>
#include <QMimeData>
#include <QUrl>
#include <QWidget>
#include <QWindow>

namespace {
QPoint globalPosition(QObject *watched, const QPoint &localPosition)
{
    if (auto *widget = qobject_cast<QWidget *>(watched)) return widget->mapToGlobal(localPosition);
    if (auto *window = qobject_cast<QWindow *>(watched)) return window->mapToGlobal(localPosition);
    return localPosition;
}
}

FileDropController::FileDropController(DropHandler handler, QWindow *coordinateSurface, QObject *parent)
    : QObject(parent),
      m_handler(std::move(handler)),
      m_coordinateSurface(coordinateSurface)
{
}

bool FileDropController::eventFilter(QObject *watched, QEvent *event)
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
            if (m_handler) {
                const QPoint clientPosition = toWebViewClientPosition(
                    m_coordinateSurface, watched, drop->position().toPoint());
                m_handler(payload(drop->mimeData(), clientPosition));
            }
            drop->acceptProposedAction();
            return true;
        }
    }
    return false;
}

QPoint FileDropController::toWebViewClientPosition(QWindow *coordinateSurface,
                                                        QObject *watched,
                                                        const QPoint &localPosition)
{
    const QPoint global = globalPosition(watched, localPosition);
    return coordinateSurface ? coordinateSurface->mapFromGlobal(global) : global;
}

bool FileDropController::hasLocalFiles(const QMimeData *mimeData)
{
    if (!mimeData) return false;
    for (const QUrl &url : mimeData->urls()) {
        if (url.isLocalFile()) return true;
    }
    return false;
}

QJsonObject FileDropController::payload(const QMimeData *mimeData, const QPoint &clientPosition)
{
    const QStringList boundedPaths = mimeData
        ? NativeFilePathLimits::fromUrls(mimeData->urls())
        : QStringList{};
    QJsonArray paths;
    for (const QString &path : boundedPaths) paths.append(path);
    return QJsonObject{
        {QStringLiteral("paths"), paths},
        {QStringLiteral("clientX"), clientPosition.x()},
        {QStringLiteral("clientY"), clientPosition.y()},
    };
}
