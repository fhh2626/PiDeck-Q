#include "NativeWindowPolicy.h"

#include <QtGlobal>

bool nativeWindowUsesSystemTitleBar(bool requestedNativeTitleBar)
{
#ifdef Q_OS_MACOS
    Q_UNUSED(requestedNativeTitleBar);
    return true;
#else
    return requestedNativeTitleBar;
#endif
}

bool nativeWindowSupportsCustomResize()
{
#ifdef Q_OS_MACOS
    return false;
#else
    return true;
#endif
}
