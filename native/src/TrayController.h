#pragma once

#include <QJsonObject>
#include <QSystemTrayIcon>

#include <functional>

class QMenu;
class QAction;

class TrayController final : public QObject {
public:
    using Action = std::function<void()>;

    TrayController(const QIcon &icon, Action showWindow, Action restart, Action quit,
                   QObject *parent = nullptr);
    ~TrayController() override;

    void update(const QJsonObject &labels);
    void setVisible(bool visible);
    bool isAvailableAndVisible() const;
    bool showMessage(const QString &title, const QString &message,
                     QSystemTrayIcon::MessageIcon icon, int millisecondsTimeoutHint);

private:
    QSystemTrayIcon m_tray;
    QMenu *m_menu = nullptr;
    QAction *m_showAction = nullptr;
    QAction *m_restartAction = nullptr;
    QAction *m_quitAction = nullptr;
    Action m_showWindow;
    Action m_restart;
    Action m_quit;
};
