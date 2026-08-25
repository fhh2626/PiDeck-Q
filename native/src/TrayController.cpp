#include "TrayController.h"

#include <QAction>
#include <QMenu>

#include <utility>

TrayController::TrayController(const QIcon &icon, Action showWindow, Action restart, Action quit,
                               QObject *parent)
    : QObject(parent),
      m_tray(icon, this),
      m_showWindow(std::move(showWindow)),
      m_restart(std::move(restart)),
      m_quit(std::move(quit))
{
    m_tray.setToolTip(QStringLiteral("PiDeck-Q"));
    m_menu = new QMenu();
    m_showAction = m_menu->addAction(QStringLiteral("Show"));
    m_menu->addSeparator();
    m_restartAction = m_menu->addAction(QStringLiteral("Restart"));
    m_menu->addSeparator();
    m_quitAction = m_menu->addAction(QStringLiteral("Quit"));
    m_tray.setContextMenu(m_menu);
    connect(m_showAction, &QAction::triggered, this, [this] { if (m_showWindow) m_showWindow(); });
    connect(m_restartAction, &QAction::triggered, this, [this] { if (m_restart) m_restart(); });
    connect(m_quitAction, &QAction::triggered, this, [this] { if (m_quit) m_quit(); });
    connect(&m_tray, &QSystemTrayIcon::activated, this,
            [this](QSystemTrayIcon::ActivationReason reason) {
                if (reason == QSystemTrayIcon::DoubleClick && m_showWindow) m_showWindow();
            });
}

TrayController::~TrayController()
{
    delete m_menu;
}

void TrayController::update(const QJsonObject &labels)
{
    if (m_showAction) m_showAction->setText(labels.value(QStringLiteral("showWindow")).toString(m_showAction->text()));
    if (m_restartAction) m_restartAction->setText(labels.value(QStringLiteral("restart")).toString(m_restartAction->text()));
    if (m_quitAction) m_quitAction->setText(labels.value(QStringLiteral("quit")).toString(m_quitAction->text()));
}

void TrayController::setVisible(bool visible)
{
    m_tray.setVisible(visible);
}

void TrayController::showMessage(const QString &title, const QString &message,
                                  QSystemTrayIcon::MessageIcon icon, int millisecondsTimeoutHint)
{
    m_tray.showMessage(title, message, icon, millisecondsTimeoutHint);
}
