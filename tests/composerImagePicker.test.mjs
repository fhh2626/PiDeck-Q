import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function loadHookModule(customDesktopApi, customComposerImages) {
	const source = readFileSync("src/renderer/src/hooks/useComposerImagePicker.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});

	// 提供最小 React hooks 运行时，真实执行 Hook 源码
	let stateValue = false;
	let stateSetter = (v) => { stateValue = typeof v === "function" ? v(stateValue) : v; };
	const refs = [];
	let refIndex = 0;

	const mockReact = {
		useState: (initial) => {
			if (stateValue === undefined) stateValue = initial;
			return [stateValue, stateSetter];
		},
		useRef: (initial) => {
			const idx = refIndex++;
			if (!refs[idx]) refs[idx] = { current: initial };
			return refs[idx];
		},
		useEffect: (fn, deps) => {
			// 在测试中同步执行 effect
			const cleanup = fn();
			return cleanup;
		},
		useCallback: (fn) => fn,
	};

	const sandbox = {
		exports: {},
		require: (id) => {
			if (id === "react") return mockReact;
			if (id === "../desktopApi") return { desktopApi: customDesktopApi };
			if (id === "../utils/composerImages") return customComposerImages;
			return {};
		},
	};

	vm.runInNewContext(outputText, sandbox, { filename: "useComposerImagePicker.ts" });
	return {
		useComposerImagePicker: sandbox.exports.useComposerImagePicker,
		getState: () => stateValue,
	};
}

test("useComposerImagePicker: handles cancelled dialog gracefully", async () => {
	let added = [];
	let notices = [];
	const customApi = {
		dialog: {
			pickImages: async () => ({ kind: "cancelled" }),
		},
	};
	const { useComposerImagePicker } = loadHookModule(customApi, {});
	const hook = useComposerImagePicker({
		sessionId: "sess-1",
		onAddImages: (imgs) => { added = imgs; },
		showNotice: (msg) => { notices.push(msg); },
		t: (k) => k,
	});

	await hook.pickImages();
	assert.equal(added.length, 0, "No images should be added on cancel");
	assert.equal(notices.length, 0, "No notice should be shown on cancel");
});

test("useComposerImagePicker: handles transport rejection without unhandled rejection and shows notice", async () => {
	let notices = [];
	const customApi = {
		dialog: {
			pickImages: async () => {
				throw new Error("RPC disconnected");
			},
		},
	};
	const { useComposerImagePicker, getState } = loadHookModule(customApi, {});
	const hook = useComposerImagePicker({
		sessionId: "sess-1",
		onAddImages: () => {},
		showNotice: (msg) => { notices.push(msg); },
		t: (k) => k,
	});

	await hook.pickImages();
	assert.equal(notices.length, 1);
	assert.equal(notices[0], "composer.images.pickerFailed");
	assert.equal(getState(), false, "isPicking should be reset to false");
});

test("useComposerImagePicker: successfully processes images and reports partial failures", async () => {
	let added = [];
	let notices = [];
	const customApi = {
		dialog: {
			pickImages: async () => ({
				kind: "selected",
				capabilityId: "cap-1",
				paths: ["C:\\good.png", "C:\\bad.png"],
			}),
		},
		files: {
			readBase64External: async (_cap, path) => {
				if (path.includes("bad")) throw new Error("read error");
				return "data:image/png;base64,AAAA";
			},
		},
	};
	const customImages = {
		imageMimeTypeFromPath: () => "image/png",
		dataUrlToFile: (data, mime, name) => ({ name, size: 100 }),
		processComposerImageFile: async (file) => ({
			type: "image",
			data: "AAAA",
			mimeType: "image/png",
		}),
	};

	const { useComposerImagePicker } = loadHookModule(customApi, customImages);
	const hook = useComposerImagePicker({
		sessionId: "sess-1",
		onAddImages: (imgs) => { added = imgs; },
		showNotice: (msg) => { notices.push(msg); },
		t: (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k),
	});

	await hook.pickImages();
	assert.equal(added.length, 1, "One image should succeed");
	assert.equal(notices.length, 1, "One partial failure notice should be shown");
	assert.match(notices[0], /composer\.images\.partialFailed/);
});
