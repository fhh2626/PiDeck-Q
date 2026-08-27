#include "ClipboardController.h"
#include "NativeFilePathLimits.h"

#include <QBuffer>
#include <QClipboard>
#include <QJsonArray>
#include <QGuiApplication>
#include <QImage>
#include <QMimeData>
#include <QUrl>

#include <vector>
#include <utility>

#ifdef Q_OS_WIN
#include <windows.h>
#include <shellapi.h>
#endif

namespace {
constexpr qsizetype kMaxClipboardImageBytes = 8 * 1024 * 1024;
constexpr qsizetype kMaxClipboardImageBase64Bytes = 12 * 1024 * 1024;
constexpr qint64 kMaxClipboardImagePixels = 32 * 1024 * 1024;
constexpr qsizetype kMaxClipboardTextChars = 1 * 1024 * 1024;

QString boundedText(const QString &value)
{
    return value.size() <= kMaxClipboardTextChars ? value : value.left(kMaxClipboardTextChars);
}

QString imageDataUrl(const QMimeData *mimeData)
{
    if (!mimeData || !mimeData->hasImage()) return {};
    const QImage image = qvariant_cast<QImage>(mimeData->imageData());
    if (image.isNull() || qint64(image.width()) * qint64(image.height()) > kMaxClipboardImagePixels) return {};
    QByteArray bytes;
    QBuffer buffer(&bytes);
    buffer.open(QIODevice::WriteOnly);
    if (!image.save(&buffer, "PNG") || bytes.size() > kMaxClipboardImageBytes) return {};
    const QByteArray base64 = bytes.toBase64();
    // The native control channel is framed at 32 MiB. Drop oversized clipboard
    // images instead of allowing one paste to tear down the sidecar connection.
    if (base64.size() > kMaxClipboardImageBase64Bytes) return {};
    return QStringLiteral("data:image/png;base64,") + QString::fromLatin1(base64);
}

QStringList mimeFilePaths(const QMimeData *mimeData)
{
    return mimeData ? NativeFilePathLimits::fromUrls(mimeData->urls()) : QStringList{};
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
    qsizetype totalBytes = 0;
    for (UINT index = 0; index < count && paths.size() < NativeFilePathLimits::kMaxFilePathCount; ++index) {
        const UINT length = DragQueryFileW(drop, index, nullptr, 0);
        if (length > static_cast<UINT>(NativeFilePathLimits::kMaxFilePathUtf8Bytes / sizeof(wchar_t))) break;
        std::vector<wchar_t> value(static_cast<size_t>(length) + 1, L'\0');
        DragQueryFileW(drop, index, value.data(), length + 1);
        const QString path = ClipboardController::decodeWindowsDropPath(value.data(), static_cast<int>(length));
        if (!path.isEmpty() && !NativeFilePathLimits::append(paths, path, totalBytes)) break;
    }
    CloseClipboard();
    return paths;
}
#endif
}

QString ClipboardController::decodeWindowsDropPath(const wchar_t *value, int length)
{
    if (!value || length <= 0) return {};
    return QString::fromWCharArray(value, length);
}

ClipboardController::ClipboardController(ChangedHandler onChanged)
    : m_onChanged(std::move(onChanged))
{
    auto *clipboard = QGuiApplication::clipboard();
    if (clipboard) {
        m_dataChangedConnection = QObject::connect(clipboard, &QClipboard::dataChanged, [this] {
            if (m_onChanged) m_onChanged(snapshot());
        });
    }
}

ClipboardController::~ClipboardController()
{
    QObject::disconnect(m_dataChangedConnection);
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
    const QString html = boundedText(mimeData ? mimeData->html() : QString{});
    const QString text = boundedText(clipboard ? clipboard->text(QClipboard::Clipboard) : QString{});
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
