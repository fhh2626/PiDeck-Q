import { isNativeRuntime } from "../desktopApi";
import { getNativeRendererToken } from "../native/initializeNativeDesktop";

/** Build the runtime-specific protected background image URL. */
export function backgroundImageUrl(name: string): string {
	const encoded = encodeURIComponent(name);
	if (!isNativeRuntime) return `pideck-bg://local/${encoded}`;
	const token = getNativeRendererToken();
	return token
		? `/__pideck/background/${encoded}?token=${encodeURIComponent(token)}`
		: `/__pideck/background/${encoded}`;
}
