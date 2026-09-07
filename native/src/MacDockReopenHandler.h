#pragma once

#include <QtGlobal>

#include <functional>

#ifdef Q_OS_MACOS
/** Install the macOS Dock reopen callback while preserving Qt's delegate. */
void installMacDockReopenHandler(std::function<void()> handler);
/** Restore Qt's original NSApplication delegate before the event loop exits. */
void uninstallMacDockReopenHandler();
#endif
