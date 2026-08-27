#include "ClipboardController.h"
#include "MainWindow.h"
#include "NativeTheme.h"
#include "WindowsToastNotifier.h"

#include <QtWebView/QtWebView>

#include <QApplication>
#include <QClipboard>
#include <QColor>
#include <QCoreApplication>
#include <QImage>
#include <QJsonObject>
#include <QPalette>
#include <QSize>
#include <QStyleHints>
#include <QThread>

#include <iostream>

namespace {
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

    applyNativeThemeSource(QStringLiteral("dark"));
    if (!require(QApplication::palette().color(QPalette::Window) == QColor("#121212"),
                 "dark native theme was not applied")) return 1;
    applyNativeThemeSource(QStringLiteral("light"));
    if (!require(QApplication::palette().color(QPalette::Window) == QColor("#f8f8f5"),
                 "light native theme was not applied")) return 1;
    const bool firstToastInitialization = WindowsToastNotifier::initialize();
    if (!require(WindowsToastNotifier::isSupported() == firstToastInitialization,
                 "toast capability did not reflect initialization state")) return 1;
    WindowsToastNotifier::uninitialize();
    const bool secondToastInitialization = WindowsToastNotifier::initialize();
    if (!require(secondToastInitialization == firstToastInitialization,
                 "toast apartment could not be initialized again after cleanup")) return 1;
    WindowsToastNotifier::uninitialize();

    applyNativeThemeSource(QStringLiteral("system"));
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
