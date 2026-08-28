export type NativeWindowChrome = {
  useNativeTitleBar: boolean;
  enableCustomResize: boolean;
};

/**
 * Keep platform window capabilities explicit at the renderer boundary.
 * Qt's macOS platform plugin cannot reliably start resizing for a frameless
 * window, so native runtime builds retain system traffic lights and resizing.
 */
export function resolveNativeWindowChrome(
  requestedNativeTitleBar: boolean,
  platform: NodeJS.Platform,
  nativeRuntime: boolean,
): NativeWindowChrome {
  const platformRequiresNativeTitleBar = nativeRuntime && platform === "darwin";
  const useNativeTitleBar = requestedNativeTitleBar || platformRequiresNativeTitleBar;
  return {
    useNativeTitleBar,
    enableCustomResize: nativeRuntime && !useNativeTitleBar && platform !== "darwin",
  };
}
