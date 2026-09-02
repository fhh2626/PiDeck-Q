#include "StartupWindowBounds.h"

namespace {
constexpr QSize kLargeWindowSize(1480, 960);
constexpr QSize kMinimumWindowSize(880, 640);
}

QSize minimumWindowSizeForAvailable(const QSize &availableSize)
{
    return QSize(
        qMax(1, qMin(kMinimumWindowSize.width(), availableSize.width())),
        qMax(1, qMin(kMinimumWindowSize.height(), availableSize.height())));
}

QSize startupWindowSize(const QString &mode)
{
    if (mode == QStringLiteral("normal-compact")) return QSize(1100, 720);
    if (mode == QStringLiteral("normal-medium")) return QSize(1280, 840);
    if (mode == QStringLiteral("normal-large")) return kLargeWindowSize;
    // Maximized/fullscreen modes still need a sensible pre-state size, and the
    // historical default is also the fallback for unknown persisted values.
    return kLargeWindowSize;
}

int screenIndexWithLargestIntersection(const QRect &windowGeometry,
                                       const QList<QRect> &availableGeometries)
{
    if (!windowGeometry.isValid() || windowGeometry.isEmpty()) return -1;

    qint64 largestArea = 0;
    int largestIndex = -1;
    for (int index = 0; index < availableGeometries.size(); ++index) {
        const QRect intersection = windowGeometry.intersected(availableGeometries.at(index));
        if (!intersection.isValid() || intersection.isEmpty()) continue;
        const qint64 area = qint64(intersection.width()) * qint64(intersection.height());
        if (area <= largestArea) continue;
        largestArea = area;
        largestIndex = index;
    }
    return largestIndex;
}
