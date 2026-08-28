/** Rebuild the authenticated native navigation URL from the in-memory token. */
export function createNativeReloadUrl(currentUrl: string, token: string): string {
	const url = new URL(currentUrl);
	url.searchParams.set("runtime", "native");
	url.searchParams.set("token", token);
	return url.toString();
}
