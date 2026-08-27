#include "NativeTheme.h"

#include <QApplication>
#include <QGuiApplication>
#include <QPalette>
#include <QStyle>
#include <QStyleHints>

void applyNativeThemeSource(const QString &source)
{
    const bool dark = source == QStringLiteral("dark")
        || (source != QStringLiteral("light")
            && QGuiApplication::styleHints()->colorScheme() == Qt::ColorScheme::Dark);
    QPalette palette = QApplication::style()->standardPalette();
    if (dark) {
        palette.setColor(QPalette::Window, QColor("#121212"));
        palette.setColor(QPalette::WindowText, QColor("#f4f4f5"));
        palette.setColor(QPalette::Base, QColor("#1e1e1e"));
        palette.setColor(QPalette::AlternateBase, QColor("#252525"));
        palette.setColor(QPalette::Text, QColor("#f4f4f5"));
        palette.setColor(QPalette::Button, QColor("#252525"));
        palette.setColor(QPalette::ButtonText, QColor("#f4f4f5"));
        palette.setColor(QPalette::Highlight, QColor("#3b82f6"));
        palette.setColor(QPalette::HighlightedText, QColor("#ffffff"));
    } else {
        // Explicit light colors keep "light" from inheriting a dark system
        // palette, while system reaches this branch when the style hint is light.
        palette.setColor(QPalette::Window, QColor("#f8f8f5"));
        palette.setColor(QPalette::WindowText, QColor("#1c1c1c"));
        palette.setColor(QPalette::Base, QColor("#ffffff"));
        palette.setColor(QPalette::AlternateBase, QColor("#f1f1ee"));
        palette.setColor(QPalette::Text, QColor("#1c1c1c"));
        palette.setColor(QPalette::Button, QColor("#f1f1ee"));
        palette.setColor(QPalette::ButtonText, QColor("#1c1c1c"));
        palette.setColor(QPalette::Highlight, QColor("#2563eb"));
        palette.setColor(QPalette::HighlightedText, QColor("#ffffff"));
    }
    QApplication::setPalette(palette);
}
