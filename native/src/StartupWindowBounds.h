#pragma once

#include <QSize>
#include <QString>

/** Returns the fixed initial size for a startup window mode. */
QSize startupWindowSize(const QString &mode);

/** Keep normal minimums when possible, but never exceed the active work area. */
QSize minimumWindowSizeForAvailable(const QSize &availableSize);
