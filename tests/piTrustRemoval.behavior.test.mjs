import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { withHookHost } from "./helpers/l5_hookHost.mjs";
import { nodes } from "./helpers/imagePreviewHarness.mjs";

test("desktop API exposes no project trust decisions or trust configuration reader", () => {
	const { createPiDesktopApi } = loadTsCommonJs("src/shared/desktop/createPiDesktopApi.ts");
	const api = createPiDesktopApi({ invoke: async () => undefined, subscribe: () => () => {} });
	assert.equal(Object.hasOwn(api.projects, "onTrustRequest"), false);
	assert.equal(Object.hasOwn(api.projects, "respondTrustRequest"), false);
	assert.equal(Object.hasOwn(api.config, "getTrust"), false);
});

test("the raw configuration picker offers only model and settings files", () => {
	const { RawTab } = loadTsCommonJs("src/renderer/src/config/RawTab.tsx", {
		stubs: {
			"./ConfigShared": { ConfigSelect: "ConfigSelect" },
			"../components/ui-shadcn/textarea": { Textarea: "Textarea" },
		},
	});
	const tree = RawTab({ fileName: "models.json", content: "{}", saving: false, onChangeFileName() {}, onChangeContent() {}, onSave() {} });
	const picker = nodes(tree, (node) => node.type === "ConfigSelect")[0];
	assert.deepEqual(Array.from(picker.props.options, (option) => option.value), ["models.json", "settings.json"]);
});

test("legacy defaultProjectTrust settings no longer appear as an editable control", async () => {
	await withHookHost(async (host) => {
		const primitive = (...names) => Object.fromEntries(names.map((name) => [name, name]));
		const { SettingsTab } = host.load("src/renderer/src/config/SettingsTab.tsx", {
			stubs: {
				"../components/ui-shadcn/button": primitive("Button"),
				"../components/ui-shadcn/input": primitive("Input"),
				"../components/ui-shadcn/checkbox": primitive("Checkbox"),
				"../components/ui-shadcn/label": primitive("Label"),
				"../components/ui-shadcn/section-heading": primitive("SectionHeading"),
				"./ConfigShared": primitive("ConfigComboboxInput"),
				"../i18n": { t: (key) => key },
			},
		});
		const mounted = await host.mount(SettingsTab, {
			data: { defaultProjectTrust: "ask", retry: { maxRetries: 10, baseDelayMs: 5000 }, compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 } },
			saving: false, onChange() {}, onSave() {},
		});
		assert.equal(nodes(mounted.result(), (node) => node.props?.fieldKey === "defaultProjectTrust").length, 0);
	});
});
