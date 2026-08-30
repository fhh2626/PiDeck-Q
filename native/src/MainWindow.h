#pragma once

#include <QAbstractNativeEventFilter>
#include <QCloseEvent>
#include <QDragEnterEvent>
#include <QDropEvent>
#include <QJsonObject>
#include <QMainWindow>
#include <QUrl>

#include <functional>
#include <memory>

class HostRpcServer;
class MainWebSurface;
class QObject;
class QEvent;
class QHideEvent;
class QShowEvent;
class FileDropController;

class MainWindow final : public QMainWindow, public QAbstractNativeEventFilter {
public:
    MainWindow(HostRpcServer *host, const QJsonObject &startup, QWidget *parent = nullptr);
    ~MainWindow() override;

    bool nativeEventFilter(const QByteArray &eventType, void *message, qintptr *result) override;

    void load(const QUrl &url);
    void reload();
    void focusWindow();
    void minimizeWindow();
    void restoreWindow();
    void showWindow();
    bool toggleMaximize();
    bool toggleAlwaysOnTop();
    bool isMaximizedWindow() const;
    void closeFromHost();
    void setQuitting(bool quitting);
    void setQuitHandler(std::function<void()> handler);
    void setCloseHideAvailableHandler(std::function<bool()> handler);
    void applySettings(const QJsonObject &settings);
    void beginSystemMove();
    bool beginSystemResize(Qt::Edges edges);
    void toggleDevTools();
    void showLoadError(const QString &url, const QString &error);

protected:
    bool nativeEvent(const QByteArray &eventType, void *message, qintptr *result) override;
    bool eventFilter(QObject *watched, QEvent *event) override;
    void closeEvent(QCloseEvent *event) override;
    void dragEnterEvent(QDragEnterEvent *event) override;
    void dropEvent(QDropEvent *event) override;
    void moveEvent(QMoveEvent *event) override;
    void resizeEvent(QResizeEvent *event) override;
    void changeEvent(QEvent *event) override;
    void showEvent(QShowEvent *event) override;
    void hideEvent(QHideEvent *event) override;

private:
    void emitMaximizedState();
    void emitMinimizedState();
    void emitFullScreenState();
    void emitBounds();
    void emitVisible(bool visible);
    void applyStartupMode(const QString &mode, bool hasLastBounds);
    void clampNormalGeometry();

    HostRpcServer *m_host = nullptr;
    QUrl m_reloadUrl;
    std::unique_ptr<MainWebSurface> m_surface;
    FileDropController *m_fileDrop = nullptr;
    bool m_closeToTray = true;
    bool m_quitting = false;
    std::function<void()> m_quitHandler;
    std::function<bool()> m_closeHideAvailableHandler;
#ifdef Q_OS_WIN
    quintptr m_nativeWebViewWinId = 0;
    bool m_nativeControlDown = false;
    bool m_nativeAltDown = false;
#endif
};
