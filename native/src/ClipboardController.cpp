#include "ClipboardController.h"
#include "NativeFilePathLimits.h"

#include <QBuffer>
#include <QClipboard>
#include <QCoreApplication>
#include <QJsonArray>
#include <QGuiApplication>
#include <QImage>
#include <QMimeData>
#include <QThreadPool>
#include <QUrl>
#include <QSize>

#include <memory>
#include <vector>
#include <utility>

#ifdef Q_OS_WIN
#include <windows.h>
#include <shellapi.h>
#endif

namespace {
constexpr qsizetype kMaxClipboardImageBytes = 5 * 1024 * 1024;
constexpr qsizetype kMaxClipboardImageBase64Bytes = 7 * 1024 * 1024;
constexpr qint64 kMaxClipboardImagePixels = 32 * 1024 * 1024;
constexpr int kMaxClipboardImageEdge = 2000;
constexpr qsizetype kMaxClipboardTextChars = 1 * 1024 * 1024;

QString boundedText(const QString &value)
{
    return value.size() <= kMaxClipboardTextChars ? value : value.left(kMaxClipboardTextChars);
}

QString imageDataUrl(const QImage &image)
{
    if (image.isNull()) return {};
    QImage bounded = image;
    if (bounded.width() > kMaxClipboardImageEdge || bounded.height() > kMaxClipboardImageEdge) {
        bounded = bounded.scaled(QSize(kMaxClipboardImageEdge, kMaxClipboardImageEdge),
                                 Qt::KeepAspectRatio, Qt::SmoothTransformation);
    }
    if (bounded.isNull() || qint64(bounded.width()) * qint64(bounded.height()) > kMaxClipboardImagePixels) return {};

    // Complex photographs may still exceed the fixed transport budget at 2000px.
    // Keep the budget intact and retry smaller bounded images before giving up.
    for (const int edge : {2000, 1800, 1600, 1400, 1200}) {
        if (bounded.width() > edge || bounded.height() > edge) {
            bounded = bounded.scaled(QSize(edge, edge),
                                     Qt::KeepAspectRatio, Qt::SmoothTransformation);
        }
        QByteArray bytes;
        QBuffer buffer(&bytes);
        buffer.open(QIODevice::WriteOnly);
        if (!bounded.save(&buffer, "PNG") || bytes.size() > kMaxClipboardImageBytes) continue;
        const QByteArray base64 = bytes.toBase64();
        // The native control channel is framed at 32 MiB. Drop oversized clipboard
        // images instead of allowing one paste to tear down the sidecar connection.
        if (base64.size() > kMaxClipboardImageBase64Bytes) continue;
        return QStringLiteral("data:image/png;base64,") + QString::fromLatin1(base64);
    }
    return {};
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

QStringList clipboardFilePaths(const QMimeData *mimeData)
{
    QStringList paths = mimeFilePaths(mimeData);
#ifdef Q_OS_WIN
    if (paths.isEmpty()) paths = windowsFileDropPaths();
#endif
    return paths;
}
}

struct ClipboardController::SnapshotState {
    quint64 currentSequence = 0;
    bool active = true;
    bool encoding = false;
    bool cachedImageReady = false;
    quint64 cachedImageSequence = 0;
    QString cachedImageDataUrl;
    QVector<ChangedHandler> waiters;
};

QString ClipboardController::decodeWindowsDropPath(const wchar_t *value, int length)
{
    if (!value || length <= 0) return {};
    return QString::fromWCharArray(value, length);
}

ClipboardController::ClipboardController(ChangedHandler onChanged)
    : m_onChanged(std::move(onChanged)),
      m_snapshotState(std::make_shared<SnapshotState>())
{
    auto *clipboard = QGuiApplication::clipboard();
    if (clipboard) {
        m_dataChangedConnection = QObject::connect(clipboard, &QClipboard::dataChanged, [this] {
            ++m_sequence;
            m_snapshotState->currentSequence = m_sequence;
            m_snapshotState->cachedImageReady = false;
            m_snapshotState->cachedImageDataUrl.clear();
            // Change notifications stay lightweight: PNG compression is deferred
            // until a paste requests the current snapshot.
            if (m_onChanged) m_onChanged(metadataSnapshot());
        });
    }
}

ClipboardController::~ClipboardController()
{
    QObject::disconnect(m_dataChangedConnection);
    m_snapshotState->active = false;
    m_snapshotState->waiters.clear();
}

QStringList ClipboardController::filePaths() const
{
    const auto *clipboard = QGuiApplication::clipboard();
    return clipboardFilePaths(clipboard ? clipboard->mimeData() : nullptr);
}

QJsonObject ClipboardController::metadataSnapshot() const
{
    const auto *clipboard = QGuiApplication::clipboard();
    const auto *mimeData = clipboard ? clipboard->mimeData() : nullptr;
    const QStringList paths = clipboardFilePaths(mimeData);
    QJsonArray jsonPaths;
    for (const QString &path : paths) jsonPaths.append(path);
    return QJsonObject{
        {QStringLiteral("text"), boundedText(clipboard ? clipboard->text(QClipboard::Clipboard) : QString{})},
        {QStringLiteral("html"), boundedText(mimeData ? mimeData->html() : QString{})},
        {QStringLiteral("filePaths"), jsonPaths},
        {QStringLiteral("hasImage"), mimeData && mimeData->hasImage()},
        {QStringLiteral("sequence"), static_cast<qint64>(m_sequence)},
    };
}

QJsonObject ClipboardController::snapshot() const
{
    QJsonObject result = metadataSnapshot();
    const auto *clipboard = QGuiApplication::clipboard();
    const auto *mimeData = clipboard ? clipboard->mimeData() : nullptr;
    const QImage image = mimeData && mimeData->hasImage()
        ? qvariant_cast<QImage>(mimeData->imageData())
        : QImage{};
    result.insert(QStringLiteral("imageDataUrl"), imageDataUrl(image));
    return result;
}

void ClipboardController::snapshotAsync(ChangedHandler onReady) const
{
    requestSnapshot(m_snapshotState, std::move(onReady));
}

void ClipboardController::requestSnapshot(
    const std::shared_ptr<SnapshotState> &state,
    ChangedHandler onReady)
{
    if (!onReady || !state->active) return;
    const QJsonObject result = [&state] {
        const auto *clipboard = QGuiApplication::clipboard();
        const auto *mimeData = clipboard ? clipboard->mimeData() : nullptr;
        const QStringList paths = clipboardFilePaths(mimeData);
        QJsonArray jsonPaths;
        for (const QString &path : paths) jsonPaths.append(path);
        return QJsonObject{
            {QStringLiteral("text"), boundedText(clipboard ? clipboard->text(QClipboard::Clipboard) : QString{})},
            {QStringLiteral("html"), boundedText(mimeData ? mimeData->html() : QString{})},
            {QStringLiteral("filePaths"), jsonPaths},
            {QStringLiteral("hasImage"), mimeData && mimeData->hasImage()},
            {QStringLiteral("sequence"), static_cast<qint64>(state->currentSequence)},
        };
    }();
    const auto *clipboard = QGuiApplication::clipboard();
    const auto *mimeData = clipboard ? clipboard->mimeData() : nullptr;
    const QImage image = mimeData && mimeData->hasImage()
        ? qvariant_cast<QImage>(mimeData->imageData())
        : QImage{};
    if (image.isNull()) {
        QJsonObject completed = result;
        completed.insert(QStringLiteral("imageDataUrl"), QString{});
        onReady(completed);
        return;
    }

    const quint64 sequence = state->currentSequence;
    if (state->cachedImageReady && state->cachedImageSequence == sequence) {
        QJsonObject cached = result;
        cached.insert(QStringLiteral("imageDataUrl"), state->cachedImageDataUrl);
        onReady(cached);
        return;
    }
    state->waiters.append(std::move(onReady));
    if (state->encoding) return;
    state->encoding = true;

    QThreadPool::globalInstance()->start(
        [state, image, result, sequence]() mutable {
            const QString encoded = imageDataUrl(image);
            QMetaObject::invokeMethod(QCoreApplication::instance(),
                [state, result = std::move(result), encoded, sequence]() mutable {
                    if (!state->active) {
                        state->encoding = false;
                        state->waiters.clear();
                        return;
                    }
                    // Clipboard changed while encoding. Re-read once and fan the
                    // callers into the new sequence instead of caching stale bytes.
                    if (state->currentSequence != sequence) {
                        state->encoding = false;
                        auto waiters = std::move(state->waiters);
                        state->waiters.clear();
                        for (auto &waiter : waiters) ClipboardController::requestSnapshot(state, std::move(waiter));
                        return;
                    }
                    state->cachedImageReady = true;
                    state->cachedImageSequence = sequence;
                    state->cachedImageDataUrl = encoded;
                    state->encoding = false;
                    QJsonObject completed = result;
                    completed.insert(QStringLiteral("imageDataUrl"), encoded);
                    auto waiters = std::move(state->waiters);
                    state->waiters.clear();
                    for (auto &waiter : waiters) {
                        if (waiter) waiter(completed);
                    }
                },
                Qt::QueuedConnection);
        });
}
