#pragma once

#include <QUrl>
#include <QWidget>

class QWebView;

class MainWebSurface final {
public:
    explicit MainWebSurface(QWidget *parent = nullptr);

    QWebView *view() const;
    QWidget *container() const;
    void load(const QUrl &url);
    void reload();
    void focus();

private:
    QWebView *m_view = nullptr;
    QWidget *m_container = nullptr;
};
