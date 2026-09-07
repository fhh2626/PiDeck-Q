#pragma once

#include <QList>
#include <QRect>
#include <QSize>
#include <QString>

/** Returns the fixed initial size for a startup window mode. */
QSize startupWindowSize(const QString &mode);

/** Keep normal minimums when possible, but never exceed the active work area. */
QSize minimumWindowSizeForAvailable(const QSize &availableSize);

/**
 * Returns the index of the screen work area with the largest overlap with a
 * normal window rectangle, or -1 when the window does not overlap any area.
 */
int screenIndexWithLargestIntersection(const QRect &windowGeometry,
                                       const QList<QRect> &availableGeometries);

/**
 * Fits a restored normal rectangle onto a work area without forcing every
 * restore to the bottom-left corner. Keep a still-visible window on-screen;
 * only recentre windows whose overlap with the work area is under half.
 */
QRect clampRestoredNormalGeometry(const QRect &normal, const QRect &available);
