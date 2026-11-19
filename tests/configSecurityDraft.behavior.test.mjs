import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { withHookHost } from "./helpers/l5_hookHost.mjs";

const nodeRequire = createRequire(import.meta.url);

/** Exercise the real tab lifecycle while keeping each editor behind its public save boundary. */
async function withConfigDialog(run, { securitySaveSucceeds = true } = {}) {
	await withHookHost(async (host) => {
		const { React } = host;
		const { Provider, createStore } = nodeRequire("jotai");
		const { Tabs } = nodeRequire("radix-ui");
		const previousStyles = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
		Object.defineProperty(globalThis, "getComputedStyle", {
			configurable: true, value: () => ({ display: "block", animationName: "none" }),
		});
		try {
			const atoms = host.load("src/renderer/src/atoms/model-atoms.ts");
			const store = createStore();
			let navigate;
			let requestClose;
			let reopen;
			let editSecurity;
			let securityReads = 0;
			let securityUnmounts = 0;
			let closes = 0;
			const securitySaves = [];
			const fragment = ({ children }) => React.createElement(React.Fragment, null, children);
			const empty = () => null;
			const button = ({ children, onClick, disabled, "aria-label": ariaLabel }) => React.createElement(
				"button", { onClick, disabled, "aria-label": ariaLabel }, children,
			);
			const SecuritySection = React.forwardRef(function SecurityEditor({ onDirtyChange }, ref) {
				const [draft, setDraft] = React.useState("original");
				const [dirty, setDirty] = React.useState(false);
				editSecurity = (value) => { setDraft(value); setDirty(true); };
				React.useEffect(() => {
					securityReads += 1;
					return () => { securityUnmounts += 1; };
				}, []);
				React.useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
				React.useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
				React.useImperativeHandle(ref, () => ({
					save: async () => {
						securitySaves.push(draft);
						if (!securitySaveSucceeds) return false;
						setDirty(false);
						return true;
					},
				}), [draft]);
				return React.createElement("div", { "data-testid": "security-draft" }, draft);
			});
			const stubs = {
				"./components/ui-shadcn/button": { Button: button, buttonVariants: () => "" },
				"./components/ui-shadcn/tabs": {
					Tabs: (props) => { navigate = props.onValueChange; return React.createElement(Tabs.Root, props); },
					TabsContent: Tabs.Content,
					TabsList: fragment,
					TabsTrigger: empty,
				},
				"./components/ui-shadcn/dialog": {
					Dialog: ({ open, children, onOpenChange }) => {
						requestClose = () => onOpenChange(false);
						return open ? children : null;
					},
					DialogClose: fragment, DialogContent: fragment, DialogHeader: fragment, DialogTitle: fragment,
				},
				"./components/ui-shadcn/alert-dialog": {
					AlertDialog: fragment, AlertDialogContent: fragment, AlertDialogHeader: fragment,
					AlertDialogTitle: fragment, AlertDialogDescription: fragment, AlertDialogFooter: fragment,
					AlertDialogAction: button, AlertDialogCancel: button,
				},
				"./components/ui-shadcn/ConfirmDialog": { ConfirmDialog: empty },
				"./desktopApi": { desktopApi: {
					config: {
						getSettings: async () => ({ parsed: {}, raw: "{}" }),
						getModels: async () => ({ parsed: { providers: {} }, raw: "{}" }),
					},
					projects: { listModels: async () => [] },
				} },
				"./atoms/model-atoms": atoms,
				"./utils/notice": { showNotice() {} },
				"./i18n": { t: (key) => key },
				"./config/ConfigShared": { openDocsInSystemBrowser: () => () => {} },
				"./components/config/SecuritySection": { SecuritySection },
				"./components/app/CodeMirrorEditor": { CodeMirrorEditor: empty },
				"./config/promptEditorStorage": { createGlobalPromptEditorStorage: () => ({}) },
				"./hooks/usePromptTemplateEditor": { usePromptTemplateEditor: () => ({}) },
				"./composerBehavior": { translateBuiltinPromptDescription: (value) => value },
			};
			for (const name of ["ModelsTab", "RawTab", "TrustTab", "SettingsTab", "PromptsTab", "SkillsTab", "ExtensionsTab"]) {
				stubs[`./config/${name}`] = { [name]: empty };
			}
			const { ConfigModal } = host.load("src/renderer/src/ConfigModal.tsx", {
				stubs,
				globals: { localStorage: { getItem: () => "config:models", setItem() {} } },
			});
			function Parent() {
				const [open, setOpen] = React.useState(true);
				reopen = () => setOpen(true);
				return React.createElement(Provider, { store }, React.createElement(ConfigModal, {
					open, onClose: () => { closes += 1; setOpen(false); }, onSaved() {},
				}));
			}
			await host.mount(() => null, undefined, (probe) => React.createElement(React.Fragment, null, probe, React.createElement(Parent)));
			const click = (label) => {
				const target = [...host.window.document.querySelectorAll("button")].find((node) => node.textContent === label);
				assert.ok(target, `Missing button ${label}`);
				target.click();
			};
			await run({
				act: host.act,
				navigate: (value) => navigate(value),
				edit: (value) => editSecurity(value),
				close: () => requestClose(), reopen: () => reopen(), click,
				draft: () => host.window.document.querySelector('[data-testid="security-draft"]'),
				reads: () => securityReads, unmounts: () => securityUnmounts, closes: () => closes,
				saves: securitySaves,
			});
		} finally {
			if (previousStyles) Object.defineProperty(globalThis, "getComputedStyle", previousStyles);
			else delete globalThis.getComputedStyle;
		}
	});
}

test("security drafts load on first visit and survive tab changes until the dialog closes", async () => {
	await withConfigDialog(async (dialog) => {
		assert.equal(dialog.reads(), 0);
		await dialog.act(async () => dialog.navigate("security"));
		assert.equal(dialog.reads(), 1);
		await dialog.act(async () => dialog.edit("Remove-Item"));
		await dialog.act(async () => dialog.navigate("config:models"));
		assert.equal(dialog.unmounts(), 0, "changing pages must preserve the safety rule draft");
		assert.equal(dialog.draft().closest('[role="tabpanel"]').hidden, true);
		await dialog.act(async () => dialog.navigate("security"));
		assert.equal(dialog.reads(), 1);
		assert.equal(dialog.draft().textContent, "Remove-Item");
		await dialog.act(async () => dialog.close());
		await dialog.act(async () => dialog.click("config.discardChanges"));
		assert.equal(dialog.closes(), 1);
		assert.equal(dialog.unmounts(), 1);
		await dialog.act(async () => dialog.reopen());
		assert.equal(dialog.reads(), 2);
		assert.equal(dialog.draft().textContent, "original");
	});
});

test("Save and Close saves an unsaved security page while another page is active", async () => {
	await withConfigDialog(async (dialog) => {
		await dialog.act(async () => dialog.navigate("security"));
		await dialog.act(async () => dialog.edit("Stop-Process"));
		await dialog.act(async () => dialog.navigate("config:models"));
		await dialog.act(async () => dialog.close());
		assert.equal(dialog.closes(), 0);
		await dialog.act(async () => dialog.click("config.saveAndClose"));
		assert.deepEqual(dialog.saves, ["Stop-Process"]);
		assert.equal(dialog.closes(), 1);
		assert.equal(dialog.unmounts(), 1);
		await dialog.act(async () => dialog.reopen());
		assert.equal(dialog.reads(), 1, "opening another page starts no safety configuration read");
		assert.equal(dialog.draft(), null);
		await dialog.act(async () => dialog.navigate("security"));
		assert.equal(dialog.reads(), 2);
	});
});

test("a failed background security save keeps the dialog open and returns to the draft", async () => {
	await withConfigDialog(async (dialog) => {
		await dialog.act(async () => dialog.navigate("security"));
		await dialog.act(async () => dialog.edit("[invalid"));
		await dialog.act(async () => dialog.navigate("config:models"));
		await dialog.act(async () => dialog.close());
		await dialog.act(async () => dialog.click("config.saveAndClose"));
		assert.deepEqual(dialog.saves, ["[invalid"]);
		assert.equal(dialog.closes(), 0);
		assert.equal(dialog.draft().textContent, "[invalid");
		assert.equal(dialog.draft().closest('[role="tabpanel"]').dataset.state, "active");
	}, { securitySaveSucceeds: false });
});
