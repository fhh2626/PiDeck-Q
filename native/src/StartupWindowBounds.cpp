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

QRect clampRestoredNormalGeometry(const QRect &normal, const QRect &available)
{
    if (!available.isValid() || available.isEmpty()) return normal;

    QRect bounded = normal.isValid() && !normal.isEmpty() ? normal : available;
    bounded.setWidth(qBound(1, bounded.width(), available.width()));
    bounded.setHeight(qBound(1, bounded.height(), available.height()));

    const QRect overlap = bounded.intersected(available);
    const qint64 boundedArea = qint64(bounded.width()) * qint64(bounded.height());
    const qint64 overlapArea = overlap.isValid() && !overlap.isEmpty()
        ? qint64(overlap.width()) * qint64(overlap.height())
        : 0;
    // Qt can briefly report a restored rectangle that barely intersects the
    // work area (or sits entirely below it). Clamping that rectangle blindly
    // pins the window to the bottom-left. Recentre when less than half of the
    // restored window would remain visible.
    if (boundedArea <= 0 || overlapArea * 2 < boundedArea) {
        bounded.moveLeft(available.left() + (available.width() - bounded.width()) / 2);
        bounded.moveTop(available.top() + (available.height() - bounded.height()) / 2);
        return bounded;
    }

    const int maxLeft = available.right() - bounded.width() + 1;
    const int maxTop = available.bottom() - bounded.height() + 1;
    bounded.moveLeft(qBound(available.left(), bounded.left(), maxLeft));
    bounded.moveTop(qBound(available.top(), bounded.top(), maxTop));
    return bounded;
}
