#include "ClipboardController.h"

#include <QBuffer>
#include <QClipboard>
#include <QJsonArray>
#include <QGuiApplication>
#include <QImage>
#include <QMimeData>
#include <QUrl>

#include <string>
#include <utility>

#ifdef Q_OS_WIN
#include <windows.h>
#include <shellapi.h>
#endif

namespace {
QString imageDataUrl(const QMimeData *mimeData)
{
    if (!mimeData || !mimeData->hasImage()) return {};
    const QImage image = qvariant_cast<QImage>(mimeData->imageData());
    if (image.isNull()) return {};
    QByteArray bytes;
    QBuffer buffer(&bytes);
    buffer.open(QIODevice::WriteOnly);
    image.save(&buffer, "PNG");
    return QStringLiteral("data:image/png;base64,") + QString::fromLatin1(bytes.toBase64());
}

QStringList mimeFilePaths(const QMimeData *mimeData)
{
    QStringList paths;
    if (!mimeData) return paths;
    for (const QUrl &url : mimeData->urls()) {
        if (url.isLocalFile()) paths.append(url.toLocalFile());
    }
    return paths;
}

#ifdef Q_OS_WIN
QStringList windowsFileDropPaths()
{
    QStringList paths;
    if (!OpenClipboard(nullptr)) return paths;
    const auto drop = static_cast<HDROP>(GetClipboardData(CF_HDROP));
    if (!drop) {
        CloseClipboard();
        return paths;
    }
    const UINT count = DragQueryFileW(drop, 0xFFFFFFFF, nullptr, 0);
    for (UINT index = 0; index < count; ++index) {
        const UINT length = DragQueryFileW(drop, index, nullptr, 0);
        std::wstring value(length + 1, L'\0');
        DragQueryFileW(drop, index, value.data(), length + 1);
        paths.append(QString::fromStdWString(value));
    }
    CloseClipboard();
    return paths;
}
#endif
}

ClipboardController::ClipboardController(ChangedHandler onChanged)
    : m_onChanged(std::move(onChanged))
{
    auto *clipboard = QGuiApplication::clipboard();
    if (clipboard) {
        QObject::connect(clipboard, &QClipboard::dataChanged, [this] {
            if (m_onChanged) m_onChanged(snapshot());
        });
    }
}

QStringList ClipboardController::filePaths() const
{
    const auto *clipboard = QGuiApplication::clipboard();
    QStringList paths = mimeFilePaths(clipboard ? clipboard->mimeData() : nullptr);
#ifdef Q_OS_WIN
    if (paths.isEmpty()) paths = windowsFileDropPaths();
#endif
    return paths;
}

QJsonObject ClipboardController::snapshot() const
{
    const auto *clipboard = QGuiApplication::clipboard();
    const auto *mimeData = clipboard ? clipboard->mimeData() : nullptr;
    const QString html = mimeData ? mimeData->html() : QString{};
    const QString text = clipboard ? clipboard->text(QClipboard::Clipboard) : QString{};
    const QString image = imageDataUrl(mimeData);
    const QStringList paths = filePaths();

    QJsonArray jsonPaths;
    for (const QString &path : paths) jsonPaths.append(path);
    return QJsonObject{
        {QStringLiteral("text"), text},
        {QStringLiteral("html"), html},
        {QStringLiteral("imageDataUrl"), image},
        {QStringLiteral("filePaths"), jsonPaths},
    };
}
