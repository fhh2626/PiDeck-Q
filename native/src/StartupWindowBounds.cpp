#include "StartupWindowBounds.h"

namespace {
constexpr QSize kLargeWindowSize(1480, 960);
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
