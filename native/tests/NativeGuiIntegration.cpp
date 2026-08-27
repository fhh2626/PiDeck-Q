#include "ClipboardController.h"
#include "FileDropController.h"
#include "HostRpcServer.h"
#include "MainWindow.h"
#include "NativeFilePathLimits.h"
#include "NativeTheme.h"
#include "WindowsToastNotifier.h"

#include <QtWebView/QtWebView>

#include <QApplication>
#include <QClipboard>
#include <QElapsedTimer>
#include <QColor>
#include <QCoreApplication>
#include <QImage>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QMimeData>
#include <QPalette>
#include <QSize>
#include <QStyleHints>
#include <QTcpSocket>
#include <QThread>
#include <QUrl>

#include <functional>
#include <iostream>

namespace {
QByteArray hostFrame(const QJsonObject &payload)
{
    const QByteArray body = QJsonDocument(payload).toJson(QJsonDocument::Compact);
    QByteArray packet(4, Qt::Uninitialized);
    const quint32 length = static_cast<quint32>(body.size());
    packet[0] = char(length & 0xff);
    packet[1] = char((length >> 8) & 0xff);
    packet[2] = char((length >> 16) & 0xff);
    packet[3] = char((length >> 24) & 0xff);
    packet.append(body);
    return packet;
}

bool waitForHostFrame(QTcpSocket &socket, QByteArray &buffer,
                      const std::function<bool(const QJsonObject &)> &predicate,
                      int timeoutMs = 3'000)
{
    QElapsedTimer timer;
    timer.start();
    while (timer.elapsed() < timeoutMs) {
        QCoreApplication::processEvents(QEventLoop::AllEvents, 20);
        buffer.append(socket.readAll());
        while (buffer.size() >= 4) {
            const auto *header = reinterpret_cast<const unsigned char *>(buffer.constData());
            const quint32 length = quint32(header[0])
                | (quint32(header[1]) << 8)
                | (quint32(header[2]) << 16)
                | (quint32(header[3]) << 24);
            if (buffer.size() < 4 + qsizetype(length)) break;
            const QByteArray body = buffer.mid(4, qsizetype(length));
            buffer.remove(0, 4 + qsizetype(length));
            const QJsonDocument document = QJsonDocument::fromJson(body);
            if (document.isObject() && predicate(document.object())) return true;
        }
        QThread::msleep(2);
    }
    return false;
}

bool require(bool condition, const char *message)
{
    if (condition) return true;
    std::cerr << message << std::endl;
    return false;
}

void processGuiEvents()
{
    QCoreApplication::processEvents(QEventLoop::AllEvents, 50);
    QThread::msleep(10);
    QCoreApplication::processEvents(QEventLoop::AllEvents, 50);
}
}

int main(int argc, char **argv)
{
    QtWebView::initialize();
    QApplication application(argc, argv);

    const Qt::ColorScheme systemScheme = QGuiApplication::styleHints()->colorScheme();
    applyNativeThemeSource(QStringLiteral("dark"));
    if (!require(QApplication::palette().color(QPalette::Window) == QColor("#121212"),
                 "dark native theme was not applied")) return 1;
    if (!require(QGuiApplication::styleHints()->colorScheme() == Qt::ColorScheme::Dark,
                 "dark native color-scheme hint was not applied")) return 1;
    applyNativeThemeSource(QStringLiteral("light"));
    if (!require(QApplication::palette().color(QPalette::Window) == QColor("#f8f8f5"),
                 "light native theme was not applied")) return 1;
    if (!require(QGuiApplication::styleHints()->colorScheme() == Qt::ColorScheme::Light,
                 "light native color-scheme hint was not applied")) return 1;
    const bool firstToastInitialization = WindowsToastNotifier::initialize();
    if (!require(WindowsToastNotifier::isSupported() == firstToastInitialization,
                 "toast capability did not reflect initialization state")) return 1;
    WindowsToastNotifier::uninitialize();
    const bool secondToastInitialization = WindowsToastNotifier::initialize();
    if (!require(secondToastInitialization == firstToastInitialization,
                 "toast apartment could not be initialized again after cleanup")) return 1;
    WindowsToastNotifier::uninitialize();

    applyNativeThemeSource(QStringLiteral("system"));
    if (!require(QGuiApplication::styleHints()->colorScheme() == systemScheme,
                 "system native color-scheme hint did not unset the override")) return 1;
    const bool systemIsDark = QGuiApplication::styleHints()->colorScheme() == Qt::ColorScheme::Dark;
    const QColor systemWindow = QApplication::palette().color(QPalette::Window);
    if (!require(systemWindow == (systemIsDark ? QColor("#121212") : QColor("#f8f8f5")),
                 "system native theme did not follow the Qt color scheme")) return 1;

    const QJsonObject fixedBounds{
        {QStringLiteral("startupWindowMode"), QStringLiteral("normal-compact")},
        {QStringLiteral("useNativeTitleBar"), true},
        {QStringLiteral("closeToTray"), true},
        {QStringLiteral("lastWindowBounds"), QJsonObject{
            {QStringLiteral("width"), 1800},
            {QStringLiteral("height"), 1200},
        }},
    };
    MainWindow fixed(nullptr, fixedBounds);
    if (!require(fixed.size() == QSize(1100, 720),
                 "fixed startup preset was overridden by last bounds")) return 1;

    const QJsonObject lastBounds{
        {QStringLiteral("startupWindowMode"), QStringLiteral("last")},
        {QStringLiteral("useNativeTitleBar"), true},
        {QStringLiteral("lastWindowBounds"), QJsonObject{
            {QStringLiteral("width"), 1200},
            {QStringLiteral("height"), 760},
        }},
    };
    MainWindow last(nullptr, lastBounds);
    if (!require(last.size() == QSize(1200, 760),
                 "last startup mode did not use the saved bounds")) return 1;

    fixed.show();
    processGuiEvents();
    fixed.hide();
    processGuiEvents();
    if (!require(!fixed.isVisible(), "test window did not enter hidden state")) return 1;

    fixed.applySettings(QJsonObject{{QStringLiteral("useNativeTitleBar"), false}});
    processGuiEvents();
    if (!require(!fixed.isVisible(), "titlebar change re-shown a hidden window")) return 1;

    fixed.toggleAlwaysOnTop();
    processGuiEvents();
    if (!require(!fixed.isVisible(), "always-on-top toggle re-shown a hidden window")) return 1;

    fixed.show();
    fixed.showMaximized();
    processGuiEvents();
    fixed.applySettings(QJsonObject{{QStringLiteral("useNativeTitleBar"), true}});
    processGuiEvents();
    if (!require(fixed.isMaximized(), "titlebar change lost maximized state")) return 1;
    fixed.hide();
    processGuiEvents();

    HostRpcServer lifecycleHost;
    if (!require(lifecycleHost.start(), "GUI lifecycle host failed to listen")) return 1;
    QTcpSocket lifecycleClient;
    lifecycleClient.connectToHost(QStringLiteral("127.0.0.1"), lifecycleHost.port());
    if (!require(lifecycleClient.waitForConnected(3'000), "GUI lifecycle client failed to connect")) return 1;
    lifecycleClient.write(hostFrame(QJsonObject{
        {QStringLiteral("type"), QStringLiteral("hello")},
        {QStringLiteral("token"), lifecycleHost.token()},
    }));
    lifecycleClient.flush();
    QByteArray lifecycleBuffer;
    if (!require(waitForHostFrame(lifecycleClient, lifecycleBuffer, [](const QJsonObject &frame) {
            return frame.value(QStringLiteral("type")).toString() == QStringLiteral("hello")
                && frame.value(QStringLiteral("ok")).toBool();
        }), "GUI lifecycle host handshake failed")) return 1;

    MainWindow reloadStateWindow(&lifecycleHost, fixedBounds);
    reloadStateWindow.show();
    if (!require(waitForHostFrame(lifecycleClient, lifecycleBuffer, [](const QJsonObject &frame) {
            return frame.value(QStringLiteral("name")).toString() == QStringLiteral("window.visibleChanged")
                && frame.value(QStringLiteral("payload")).toBool();
        }), "GUI show event did not report visibility")) return 1;
    reloadStateWindow.load(QUrl(QStringLiteral("data:text/html,<html><body>native</body></html>")));
    if (!require(waitForHostFrame(lifecycleClient, lifecycleBuffer, [](const QJsonObject &frame) {
            return frame.value(QStringLiteral("name")).toString() == QStringLiteral("window.ready");
        }), "GUI renderer did not report the initial load")) return 1;
    reloadStateWindow.showMinimized();
    processGuiEvents();
    if (!require(reloadStateWindow.isMinimized(),
                 "test window did not enter minimized state")) return 1;
    reloadStateWindow.reload();
    if (!require(waitForHostFrame(lifecycleClient, lifecycleBuffer, [](const QJsonObject &frame) {
            return frame.value(QStringLiteral("name")).toString() == QStringLiteral("window.ready");
        }), "GUI renderer did not report the reload")) return 1;
    if (!require(reloadStateWindow.isMinimized(),
                 "renderer reload restored a minimized window")) return 1;
    lifecycleClient.disconnectFromHost();

    int clipboardChanges = 0;
    {
        ClipboardController clipboard([&clipboardChanges](const QJsonObject &) {
            ++clipboardChanges;
        });
        if (auto *systemClipboard = QGuiApplication::clipboard()) {
            systemClipboard->setText(QStringLiteral("native-gui-test-1"));
            processGuiEvents();
        }
    }
    const int changesAfterDestroy = clipboardChanges;
    if (auto *systemClipboard = QGuiApplication::clipboard()) {
        systemClipboard->setText(QStringLiteral("native-gui-test-2"));
        processGuiEvents();
    }
    if (!require(clipboardChanges == changesAfterDestroy,
                 "destroyed ClipboardController still received clipboard signals")) return 1;

    QMimeData pathMimeData;
    QList<QUrl> manyPaths;
    for (int index = 0; index < NativeFilePathLimits::kMaxFilePathCount + 1; ++index) {
        manyPaths.append(QUrl::fromLocalFile(QStringLiteral("C:/pideck-test/%1").arg(index)));
    }
    pathMimeData.setUrls(manyPaths);
    const QJsonArray countBoundedPaths = FileDropController::payload(&pathMimeData, {}).value(QStringLiteral("paths")).toArray();
    if (!require(countBoundedPaths.size() == NativeFilePathLimits::kMaxFilePathCount,
                 "file path count limit was not applied")) return 1;

    QMimeData byteLimitedPathMimeData;
    byteLimitedPathMimeData.setUrls({QUrl::fromLocalFile(
        QStringLiteral("C:/") + QString(NativeFilePathLimits::kMaxFilePathUtf8Bytes + 1, QLatin1Char('x')))});
    const QJsonArray byteBoundedPaths = FileDropController::payload(&byteLimitedPathMimeData, {}).value(QStringLiteral("paths")).toArray();
    if (!require(byteBoundedPaths.isEmpty(), "file path byte limit was not applied")) return 1;

    if (auto *systemClipboard = QGuiApplication::clipboard()) {
        auto *clipboardPathData = new QMimeData();
        clipboardPathData->setUrls(manyPaths);
        systemClipboard->setMimeData(clipboardPathData);
        processGuiEvents();
        ClipboardController boundedClipboard;
        if (!require(boundedClipboard.filePaths().size() == NativeFilePathLimits::kMaxFilePathCount,
                     "clipboard file path count limit was not applied")) return 1;
    }

    ClipboardController imageClipboard;
    if (auto *systemClipboard = QGuiApplication::clipboard()) {
        QImage image(32, 32, QImage::Format_ARGB32);
        image.fill(QColor("#2f855a"));
        systemClipboard->setImage(image);
        processGuiEvents();
        const QString imageDataUrl = imageClipboard.snapshot().value(QStringLiteral("imageDataUrl")).toString();
        if (!require(imageDataUrl.startsWith(QStringLiteral("data:image/png;base64,")),
                     "clipboard image snapshot was not encoded as PNG data")) return 1;
    }

    return 0;
}
