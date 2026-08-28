#pragma once

/**
 * Resolves window chrome capabilities that differ between Qt platform plugins.
 * macOS keeps system decorations because QWindow::startSystemResize cannot
 * reliably resize a frameless window there.
 */
bool nativeWindowUsesSystemTitleBar(bool requestedNativeTitleBar);

/** Whether renderer edge handles may delegate to QWindow::startSystemResize. */
bool nativeWindowSupportsCustomResize();
