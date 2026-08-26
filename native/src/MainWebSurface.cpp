#include "MainWebSurface.h"

#include <QtWebView/QWebView>
#include <QtWebView/QWebViewSettings>

#include <QVBoxLayout>

MainWebSurface::MainWebSurface(QWidget *parent)
{
    m_view = new QWebView();
    // Qt's WebView2 backend creates the QWindow with WindowDoesNotAcceptFocus
    // because its QML host normally owns focus. This QWidget container is the
    // desktop host, so clear that flag or browser shortcuts (F12/Ctrl+Shift+I)
    // never reach WebView2.
    m_view->setFlag(Qt::WindowDoesNotAcceptFocus, false);
    auto *settings = m_view->settings();
    settings->setAttribute(QWebViewSettings::WebAttribute::JavaScriptEnabled, true);
    settings->setAttribute(QWebViewSettings::WebAttribute::LocalStorageEnabled, true);
    settings->setAttribute(QWebViewSettings::WebAttribute::AllowFileAccess, false);
    settings->setAttribute(QWebViewSettings::WebAttribute::LocalContentCanAccessFileUrls, false);

    m_container = QWidget::createWindowContainer(m_view, parent);
    m_container->setFocusPolicy(Qt::StrongFocus);
}

QWebView *MainWebSurface::view() const
{
    return m_view;
}

QWidget *MainWebSurface::container() const
{
    return m_container;
}

void MainWebSurface::load(const QUrl &url)
{
    m_view->setUrl(url);
}

void MainWebSurface::reload()
{
    m_view->reload();
}

void MainWebSurface::focus()
{
    m_container->setFocus(Qt::ActiveWindowFocusReason);
}
