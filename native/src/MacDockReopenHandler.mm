#include "MacDockReopenHandler.h"

#ifdef Q_OS_MACOS
#import <AppKit/AppKit.h>

#include <utility>

namespace {
std::function<void()> dockReopenHandler;
}

/**
 * Qt owns the normal NSApplication delegate. This wrapper only intercepts the
 * Dock reopen callback and forwards all other optional delegate methods to Qt.
 */
@interface PiDeckApplicationDelegate : NSObject <NSApplicationDelegate>
@property(nonatomic, assign) id wrappedDelegate;
- (instancetype)initWithWrappedDelegate:(id)delegate;
@end

@implementation PiDeckApplicationDelegate

- (instancetype)initWithWrappedDelegate:(id)delegate
{
    self = [super init];
    if (self) _wrappedDelegate = delegate;
    return self;
}

- (BOOL)applicationShouldHandleReopen:(NSApplication *)application
                    hasVisibleWindows:(BOOL)hasVisibleWindows
{
    // A Dock click with no visible windows is the reliable macOS reopen signal;
    // ApplicationStateChanged is not guaranteed after a window was merely hidden.
    if (!hasVisibleWindows && dockReopenHandler) dockReopenHandler();

    id delegate = self.wrappedDelegate;
    if (delegate && delegate != self && [delegate respondsToSelector:_cmd]) {
        const BOOL originalResult = [delegate applicationShouldHandleReopen:application
                                                          hasVisibleWindows:hasVisibleWindows];
        // Returning YES is required for a hidden-window Dock reopen even when
        // Qt's delegate reports that it did not handle the event itself.
        return hasVisibleWindows ? originalResult : YES;
    }
    return YES;
}

- (BOOL)respondsToSelector:(SEL)selector
{
    return [super respondsToSelector:selector]
        || (self.wrappedDelegate && [self.wrappedDelegate respondsToSelector:selector]);
}

- (id)forwardingTargetForSelector:(SEL)selector
{
    id delegate = self.wrappedDelegate;
    if (delegate && delegate != self && [delegate respondsToSelector:selector]) return delegate;
    return [super forwardingTargetForSelector:selector];
}

@end

namespace {
PiDeckApplicationDelegate *applicationDelegate = nullptr;
}

void installMacDockReopenHandler(std::function<void()> handler)
{
    dockReopenHandler = std::move(handler);
    if (applicationDelegate) return;
    applicationDelegate = [[PiDeckApplicationDelegate alloc]
        initWithWrappedDelegate:[NSApp delegate]];
    [NSApp setDelegate:applicationDelegate];
}

void uninstallMacDockReopenHandler()
{
    dockReopenHandler = {};
    if (!applicationDelegate) return;
    [NSApp setDelegate:applicationDelegate.wrappedDelegate];
    // The wrapper is intentionally kept for the process lifetime: NSApplication
    // does not retain its delegate, and releasing it here would make a late
    // Cocoa callback race with delegate restoration during shutdown.
    applicationDelegate = nullptr;
}
#endif
