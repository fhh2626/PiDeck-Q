#pragma once

#include <QAbstractNativeEventFilter>
#include <QCloseEvent>
#include <QDragEnterEvent>
#include <QDropEvent>
#include <QJsonObject>
#include <QMainWindow>
#include <QRect>
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
    // The optional starter is a deterministic seam for exercising the RPC and
    // dispatch path without moving the user's real desktop cursor in tests.
    using SystemMoveStarter = std::function<bool()>;

    MainWindow(HostRpcServer *host, const QJsonObject &startup,
               QWidget *parent = nullptr, SystemMoveStarter systemMoveStarter = {});
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
    /** Re-publish Qt window state after a replacement sidecar connects. */
    void syncStateToHost();

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
    void rememberNormalGeometry();
    void clampNormalGeometry();
    void scheduleRestoredGeometryClamp();
    QRect currentNormalGeometry() const;
    bool isUsableNormalGeometry(const QRect &rect) const;

    HostRpcServer *m_host = nullptr;
    QUrl m_reloadUrl;
    std::unique_ptr<MainWebSurface> m_surface;
    FileDropController *m_fileDrop = nullptr;
    bool m_closeToTray = true;
    SystemMoveStarter m_systemMoveStarter;
    bool m_quitting = false;
    std::function<void()> m_quitHandler;
    std::function<bool()> m_closeHideAvailableHandler;
    QRect m_lastUsableNormalGeometry;
    bool m_systemMoveActive = false;
    bool m_restoringNormalGeometry = false;
#ifdef Q_OS_WIN
    quintptr m_nativeWebViewWinId = 0;
    bool m_nativeControlDown = false;
    bool m_nativeAltDown = false;
#endif
};
