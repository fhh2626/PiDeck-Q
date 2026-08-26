#pragma once

#include <QCloseEvent>
#include <QDragEnterEvent>
#include <QDropEvent>
#include <QJsonObject>
#include <QMainWindow>

#include <functional>

class HostRpcServer;
class MainWebSurface;
class QUrl;
class FileDropController;

class MainWindow final : public QMainWindow {
public:
    MainWindow(HostRpcServer *host, const QJsonObject &startup, QWidget *parent = nullptr);

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
    void applySettings(const QJsonObject &settings);
    void beginSystemMove();
    void toggleDevTools();
    void showLoadError(const QString &url, const QString &error);

protected:
    void closeEvent(QCloseEvent *event) override;
    void dragEnterEvent(QDragEnterEvent *event) override;
    void dropEvent(QDropEvent *event) override;
    void moveEvent(QMoveEvent *event) override;
    void resizeEvent(QResizeEvent *event) override;
    void changeEvent(QEvent *event) override;

private:
    void emitMaximizedState();
    void emitMinimizedState();
    void emitFullScreenState();
    void emitBounds();
    void emitVisible(bool visible);
    void applyStartupMode(const QString &mode, bool hasLastBounds);

    HostRpcServer *m_host = nullptr;
    MainWebSurface *m_surface = nullptr;
    FileDropController *m_fileDrop = nullptr;
    bool m_closeToTray = true;
    bool m_quitting = false;
    bool m_loadFinished = false;
    std::function<void()> m_quitHandler;
};
