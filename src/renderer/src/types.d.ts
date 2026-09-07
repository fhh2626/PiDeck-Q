import type { PiDesktopApi } from "@shared/desktop/createPiDesktopApi";

declare global {
  interface Window {
    piDesktop: PiDesktopApi;
  }
}

export {};
