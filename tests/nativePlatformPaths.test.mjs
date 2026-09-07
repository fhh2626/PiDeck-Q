import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { join } from "node:path";

const { resolveNativeDownloadsPath } = loadTsCommonJs("src/native-node/platform/createNativePlatformServices.ts", {
	stubs: {
		"./NativeApplication": { NativeApplication: class {} },
		"./NativeDialogs": { NativeDialogs: class {} },
		"./NativeNotifications": { NativeNotifications: class {} },
		"./NativeShell": { NativeShell: class {} },
		"./NativeTheme": { NativeTheme: class {} },
		"./NodeDownloads": { NodeDownloads: class {} },
	},
});

test("native platform falls back when the configured downloads path is empty", () => {
	assert.equal(resolveNativeDownloadsPath("C:/Users/test/AppData", ""), join("C:/Users/test/AppData", "Downloads"));
	assert.equal(resolveNativeDownloadsPath("C:/Users/test/AppData", "   "), join("C:/Users/test/AppData", "Downloads"));
	assert.equal(resolveNativeDownloadsPath("C:/Users/test/AppData", "D:/Downloads"), "D:/Downloads");
});
