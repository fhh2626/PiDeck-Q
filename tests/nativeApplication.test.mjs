import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { NativeApplication } = loadTsCommonJs("src/native-node/platform/NativeApplication.ts", {
	stubs: {
		"../../main/platform/PlatformServices": {},
		"../host/HostBridge": {},
	},
});

function withEnvironment(values, callback) {
	const previous = new Map();
	for (const [key, value] of Object.entries(values)) {
		previous.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return callback();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("NativeApplication preserves Qt's ordered preferred language list", () => {
	withEnvironment({
		PIDECK_PREFERRED_LANGUAGES_JSON: JSON.stringify(["zh-CN", "en-US", "zh-CN", 42]),
		PIDECK_LOCALE: "zh-CN",
	}, () => {
		const application = new NativeApplication({});
		assert.deepEqual(Array.from(application.getPreferredSystemLanguages()), ["zh-CN", "en-US"]);
	});
});

test("NativeApplication falls back to the locale when the preferred list is invalid", () => {
	withEnvironment({
		PIDECK_PREFERRED_LANGUAGES_JSON: "not-json",
		PIDECK_LOCALE: "fr-FR",
	}, () => {
		const application = new NativeApplication({});
		assert.deepEqual(Array.from(application.getPreferredSystemLanguages()), ["fr-FR"]);
	});
});
