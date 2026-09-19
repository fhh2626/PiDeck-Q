import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { deferred } from "./helpers/securityStoreFixture.mjs";

const { createDefaultSecurityConfig } = loadTsCommonJs("src/shared/types/security.ts");
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Execute component event/state/effect behavior with the repository's lightweight hook-stub pattern.
 * UI primitives are opaque JSX nodes; this is not a DOM or visual layout test. */
function mountComponent(file, name, security, props = {}) {
	const slots = [];
	let cursor = 0;
	let pending = [];
	const ref = { current: null };
	const jsx = (type, props) => ({ type, props: props ?? {} });
	const react = {
		forwardRef: (render) => render,
		useState(initial) {
			const index = cursor++;
			if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
			return [slots[index], (next) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
		},
		useRef(initial) {
			const index = cursor++;
			if (!(index in slots)) slots[index] = { current: initial };
			return slots[index];
		},
		useMemo: (fn) => fn(),
		useCallback: (fn) => fn,
		useImperativeHandle: (target, factory) => { target.current = factory(); },
		useEffect(effect, deps) {
			const index = cursor++;
			const previous = slots[index];
			if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
				pending.push(() => {
					previous?.cleanup?.();
					slots[index] = { deps, cleanup: effect() };
				});
			}
		},
	};
	const primitives = (names) => Object.fromEntries(names.split(" ").map((name) => [name, name]));
	const module = loadTsCommonJs(file, { stubs: {
		react,
		"react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
		"lucide-react": primitives("Trash2 Check RotateCcw Shield ShieldAlert ShieldCheck ShieldOff"),
		"../../i18n": { t: (key) => `localized:${key}` },
		"../../desktopApi": { desktopApi: { security } },
		"../ui-shadcn/button": primitives("Button"),
		"../ui-shadcn/dialog": primitives("Dialog DialogContent"),
		"../ui-shadcn/command": primitives("CommandItem CommandSeparator"),
		"../ui-shadcn/command-picker": primitives("CommandPickerPanel"),
		"../ui-shadcn/input": primitives("Input"),
		"../ui-shadcn/select": primitives("Select SelectContent SelectItem SelectTrigger SelectValue"),
		"../ui-shadcn/switch": primitives("Switch"),
		"../ui-shadcn/textarea": primitives("Textarea"),
	} });
	return {
		ref,
		render() {
			cursor = 0;
			pending = [];
			const tree = module[name](props, ref);
			pending.forEach((effect) => effect());
			return tree;
		},
		unmount() { for (const slot of slots) slot?.cleanup?.(); },
	};
}

function nodes(tree) {
	if (!tree || typeof tree !== "object") return [];
	if (Array.isArray(tree)) return tree.flatMap(nodes);
	return [tree, ...nodes(tree.props?.children)];
}
const find = (tree, type) => nodes(tree).find((node) => node.type === type);
const containsText = (tree, text) => nodes(tree).some((node) => node.props?.children === text);
const failures = [
	["VALIDATION_FAILED", "security.error.validationFailed"],
	["SNAPSHOT_WRITE_FAILED", "security.error.snapshotWriteFailed"],
	["UNKNOWN_ERROR", "security.error.unknown"],
	["rejection", "security.error.unknown"],
];

for (const [code, key] of failures) {
	test(`SecurityLevelMenu ${code} shows localized feedback and retains selection until successful retry`, async (t) => {
		const config = createDefaultSecurityConfig();
		config.enabled = true;
		const request = deferred();
		const calls = [];
		let retry = false;
		const security = {
			getConfig: async () => config,
			setSessionLevel: async (...args) => {
				calls.push(args);
				if (retry) return { ok: true, config: { ...config, sessionOverrides: { s1: "strict" } } };
				await request.promise;
				if (code === "rejection") throw new Error("raw private error");
				return { ok: false, code, error: "raw private error" };
			},
		};
		const view = mountComponent("src/renderer/src/components/session/SecurityLevelMenu.tsx", "SecurityLevelMenu", security, { sessionId: "s1" });
		t.after(() => view.unmount());
		view.render(); await flush();
		find(view.render(), "Button").props.onClick();
		const pick = () => nodes(view.render()).find((node) => node.type === "CommandItem" && node.props.value === "strict").props.onSelect();
		pick();
		assert.equal(find(view.render(), "Button").props.disabled, true);
		request.resolve(); await flush();
		const failed = view.render();
		assert.equal(find(failed, "Dialog").props.open, true);
		assert.equal(find(failed, "CommandPickerPanel").props.value, "standard");
		assert.equal(find(failed, "Button").props.disabled, false);
		assert.ok(containsText(failed, `localized:${key}`));
		assert.equal(containsText(failed, "raw private error"), false);
		assert.deepEqual(calls, [["s1", "strict"]]);
		retry = true; pick(); await flush();
		const succeeded = view.render();
		assert.equal(find(succeeded, "Dialog").props.open, false);
		assert.equal(find(succeeded, "CommandPickerPanel").props.value, "strict");
		assert.equal(containsText(succeeded, `localized:${key}`), false);
	});

	test(`SecuritySection ${code} retains unsaved draft and dirty state then saves on retry`, async (t) => {
		const config = createDefaultSecurityConfig();
		let retry = false;
		const calls = [];
		const dirty = [];
		const security = {
			getConfig: async () => config,
			updateConfig: async (patch) => {
				calls.push(structuredClone(patch));
				if (retry) return { ok: true, config: { ...config, ...patch } };
				if (code === "rejection") throw new Error("raw private error");
				return { ok: false, code, error: "raw private error" };
			},
		};
		const view = mountComponent("src/renderer/src/components/config/SecuritySection.tsx", "SecuritySection", security, { onDirtyChange: (value) => dirty.push(value) });
		t.after(() => view.unmount());
		view.render(); await flush();
		find(view.render(), "Select").props.onValueChange("strict");
		view.render();
		assert.equal(dirty.at(-1), true);
		assert.equal(await view.ref.current.save(), false);
		const failed = view.render();
		assert.equal(find(failed, "Select").props.value, "strict");
		assert.equal(dirty.at(-1), true);
		assert.ok(containsText(failed, `localized:${key}`));
		assert.equal(containsText(failed, "raw private error"), false);
		assert.equal(calls[0].defaultLevelId, "strict");
		retry = true;
		assert.equal(await view.ref.current.save(), true);
		const succeeded = view.render();
		assert.equal(dirty.at(-1), false);
		assert.equal(find(succeeded, "Select").props.value, "strict");
		assert.deepEqual(calls[1], calls[0]);
		assert.equal(containsText(succeeded, `localized:${key}`), false);
	});
}
