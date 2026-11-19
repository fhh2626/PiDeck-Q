import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultSecurityConfig } from "../src/shared/types/security.ts";
import { withHookHost } from "./helpers/l5_hookHost.mjs";
import { deferred, nodes } from "./helpers/imagePreviewHarness.mjs";

const copy = (value) => JSON.parse(JSON.stringify(value));
const primitive = (...names) => Object.fromEntries(names.map((name) => [name, name]));
const uiStubs = {
	"../ui-shadcn/button": primitive("Button"),
	"../ui-shadcn/input": primitive("Input"),
	"../ui-shadcn/select": primitive("Select", "SelectContent", "SelectItem", "SelectTrigger", "SelectValue"),
	"../ui-shadcn/switch": primitive("Switch"),
	"../ui-shadcn/textarea": primitive("Textarea"),
	"../../i18n": { t: (key) => key },
};

/** Exercise the public save handle with real React state and an IPC substitute. */
async function mountSection(host, updateConfig, initial = createDefaultSecurityConfig(), getConfig = async () => copy(initial)) {
	const dirty = [];
	const ref = host.React.createRef();
	const { SecuritySection } = host.load("src/renderer/src/components/config/SecuritySection.tsx", {
		stubs: {
			...uiStubs,
			"../../desktopApi": { desktopApi: { security: {
				getConfig,
				updateConfig,
			} } },
		},
	});
	const mounted = await host.mount((props) => SecuritySection.render(props, ref), { onDirtyChange: (value) => dirty.push(value) });
	const card = (id = "standard") => nodes(mounted.result(), (node) => node.type?.name === "SecurityLevelCard" && node.props.level.id === id)[0];
	return { initial, mounted, ref, dirty, card };
}

test("security regex inputs retain a trailing newline while adding another rule", async () => {
	await withHookHost(async (host) => {
		const section = await mountSection(host, async () => { throw new Error("unexpected save"); });
		await host.act(async () => section.card().props.onToggle());
		const input = () => {
			const card = section.card();
			return nodes(card.type(card.props), (node) => node.type === "Textarea")[0];
		};
		const text = `${input().props.value}\n`;
		await host.act(async () => input().props.onChange({ target: { value: text } }));
		assert.equal(input().props.value, text);
	});
});

test("a failed security read cannot publish the default draft and can be retried", async () => {
	await withHookHost(async (host) => {
		const initial = createDefaultSecurityConfig();
		initial.enabled = true;
		initial.defaultLevelId = "strict";
		let failRead = true;
		const writes = [];
		const section = await mountSection(host, async (patch) => {
			writes.push(copy(patch));
			return { ok: true, config: { ...initial, ...patch } };
		}, initial, async () => {
			if (failRead) throw new Error("temporary read failure");
			return copy(initial);
		});
		let result;
		await host.act(async () => { result = await section.ref.current.save(); });
		assert.equal(result, false);
		assert.equal(writes.length, 0);
		assert.equal(section.card(), undefined, "failed reads must not expose an editable default policy");
		failRead = false;
		const retry = nodes(section.mounted.result(), (node) => node.type === "Button" && node.props.children === "security.retryLoad")[0];
		assert.ok(retry);
		await host.act(async () => retry.props.onClick());
		assert.ok(section.card());
		await host.act(async () => section.card().props.onChange({ denyPowerShellPatterns: ["\\bStop-Service\\b"] }));
		await host.act(async () => { result = await section.ref.current.save(); });
		assert.equal(result, true);
		assert.equal(writes.length, 1);
		assert.equal(writes[0].enabled, true);
		assert.equal(writes[0].defaultLevelId, "strict");
	});
});

test("each security level exposes an independent PowerShell editor below Bash", async () => {
	await withHookHost(async (host) => {
		const section = await mountSection(host, async () => { throw new Error("unexpected save"); });
		for (const id of ["off", "standard", "strict"]) {
			const card = section.card(id);
			const tree = card.type({ ...card.props, expanded: true });
			const editors = nodes(tree, (node) => node.type === "Textarea");
			assert.equal(editors[0].props.id, `security-bash-patterns-${id}`);
			assert.equal(editors[1].props.id, `security-powershell-patterns-${id}`);
			assert.equal(editors[1].props.value, card.props.level.denyPowerShellPatterns.join("\n"));
			assert.equal(nodes(tree, (node) => node.type === "SelectTrigger" && node.props["aria-label"] === "security.tool.powershell").length, 1);
		}
	});
});

test("PowerShell multiline edits save without changing Bash or publishing blank regexes", async () => {
	await withHookHost(async (host) => {
		const writes = [];
		const section = await mountSection(host, async (patch) => {
			writes.push(copy(patch));
			return { ok: true, config: { ...section.initial, ...patch } };
		});
		const input = () => {
			const card = section.card();
			return nodes(card.type({ ...card.props, expanded: true }), (node) => node.type === "Textarea")[1];
		};
		const text = "\\bRemove-Item\\b\n\n  \\bStop-Process\\b  \n";
		await host.act(async () => input().props.onChange({ target: { value: text } }));
		assert.equal(input().props.value, text);
		await host.act(async () => assert.equal(await section.ref.current.save(), true));
		const saved = writes[0].levels.find((level) => level.id === "standard");
		assert.deepEqual(saved.denyPowerShellPatterns, ["\\bRemove-Item\\b", "\\bStop-Process\\b"]);
		assert.deepEqual(saved.denyBashPatterns, section.initial.levels[1].denyBashPatterns);
		assert.equal(section.dirty.at(-1), false);
	});
});

test("cleared PowerShell patterns remain empty after saving and reopening", async () => {
	await withHookHost(async (host) => {
		let saved;
		const section = await mountSection(host, async (patch) => {
			saved = copy({ ...section.initial, ...patch });
			return { ok: true, config: saved };
		});
		await host.act(async () => section.card().props.onChange({ denyPowerShellPatterns: ["", "   "] }));
		await host.act(async () => assert.equal(await section.ref.current.save(), true));
		await section.mounted.unmount();
		const reopened = await mountSection(host, async () => { throw new Error("unexpected save"); }, saved);
		assert.deepEqual(copy(reopened.card().props.level.denyPowerShellPatterns), []);
	});
});

test("custom levels inherit the current PowerShell rules and can be edited independently", async () => {
	await withHookHost(async (host) => {
		const section = await mountSection(host, async () => { throw new Error("unexpected save"); });
		await host.act(async () => section.card().props.onChange({ denyPowerShellPatterns: ["\\bStop-Service\\b"] }));
		const add = nodes(section.mounted.result(), (node) => node.type === "Button" && node.props.children === "security.addLevel")[0];
		await host.act(async () => { add.props.onClick(); add.props.onClick(); });
		const custom = nodes(section.mounted.result(), (node) => node.type?.name === "SecurityLevelCard" && !node.props.level.builtin);
		assert.equal(custom.length, 2);
		assert.notEqual(custom[0].props.level.id, custom[1].props.level.id);
		for (const card of custom) assert.deepEqual(copy(card.props.level.denyPowerShellPatterns), ["\\bStop-Service\\b"]);
		await host.act(async () => custom[0].props.onChange({ denyPowerShellPatterns: ["\\bRestart-Computer\\b"] }));
		assert.deepEqual(copy(section.card(custom[0].props.level.id).props.level.denyPowerShellPatterns), ["\\bRestart-Computer\\b"]);
		assert.deepEqual(copy(section.card(custom[1].props.level.id).props.level.denyPowerShellPatterns), ["\\bStop-Service\\b"]);
		assert.deepEqual(copy(section.card().props.level.denyPowerShellPatterns), ["\\bStop-Service\\b"]);
	});
});

for (const field of ["denyBashPatterns", "denyPowerShellPatterns"]) {
	test(`invalid JavaScript ${field} are rejected before the backend can publish them`, async () => {
		await withHookHost(async (host) => {
			const writes = [];
			const section = await mountSection(host, async (patch) => {
				writes.push(copy(patch));
				return { ok: true, config: { ...section.initial, ...patch } };
			});
			// Qt accepts this PCRE option, but the extension uses JavaScript RegExp.
			await host.act(async () => section.card().props.onChange({ [field]: ["(?i)Remove-Item"] }));
			let result;
			await host.act(async () => { result = await section.ref.current.save(); });
			assert.equal(result, false);
			assert.equal(writes.length, 0);
			assert.equal(section.dirty.at(-1), true);
			assert.equal(nodes(section.mounted.result(), (node) => node.props?.children === "security.error.regexUnsupported").length, 1);
		});
	});
	for (const pattern of ["(?i:foo)", "(?<name>a)|(?<name>b)"]) {
		test(`${field} rejects ECMAScript 2025 pattern ${pattern} and retains its editable draft`, async () => {
			await withHookHost(async (host) => {
				const writes = [];
				const section = await mountSection(host, async (patch) => {
					writes.push(copy(patch));
					return { ok: true, config: { ...section.initial, ...patch } };
				});
				const input = () => {
					const card = section.card();
					return nodes(card.type({ ...card.props, expanded: true }), (node) => node.type === "Textarea")[field === "denyBashPatterns" ? 0 : 1];
				};
				const draft = `${pattern}\n`;
				await host.act(async () => input().props.onChange({ target: { value: draft } }));
				let result;
				await host.act(async () => { result = await section.ref.current.save(); });
				assert.equal(result, false, "a newer renderer cannot publish syntax unsupported by the oldest supported Pi runtime");
				assert.equal(writes.length, 0);
				assert.equal(section.dirty.at(-1), true);
				assert.equal(input().props.value, draft);
				assert.equal(nodes(section.mounted.result(), (node) => node.props?.children === "security.error.regexUnsupported").length, 1);
				await host.act(async () => input().props.onChange({ target: { value: "(?<command>foo|bar)\\k<command>" } }));
				await host.act(async () => { result = await section.ref.current.save(); });
				assert.equal(result, true, "correcting the pattern to supported syntax must permit saving");
				assert.equal(writes.length, 1);
				assert.deepEqual(writes[0].levels.find((level) => level.id === "standard")[field], ["(?<command>foo|bar)\\k<command>"]);
			});
		});
	}
	for (const { name, pattern } of [
		{ name: "Unicode 17 capture names", pattern: "(?<\u{11DB0}>a)" },
		{ name: "more than 32767 capture groups", pattern: "()".repeat(32768) },
	]) {
		test(`${field} rejects ${name} while preserving a correctable draft`, async () => {
			await withHookHost(async (host) => {
				const writes = [];
				const section = await mountSection(host, async (patch) => {
					writes.push(copy(patch));
					return { ok: true, config: { ...section.initial, ...patch } };
				});
				const input = () => {
					const card = section.card();
					return nodes(card.type({ ...card.props, expanded: true }), (node) => node.type === "Textarea")[field === "denyBashPatterns" ? 0 : 1];
				};
				const draft = `${pattern}\n`;
				await host.act(async () => input().props.onChange({ target: { value: draft } }));
				let result;
				await host.act(async () => { result = await section.ref.current.save(); });
				assert.equal(result, false, "renderer validation must match the supported Pi runtime");
				assert.equal(writes.length, 0, "unsupported patterns must not reach the update API");
				assert.equal(section.dirty.at(-1), true);
				assert.equal(input().props.value, draft);
				assert.equal(nodes(section.mounted.result(), (node) => node.props?.children === "security.error.regexUnsupported").length, 1);
				const corrected = "(?<command>foo|bar)\\k<command>";
				await host.act(async () => input().props.onChange({ target: { value: corrected } }));
				await host.act(async () => { result = await section.ref.current.save(); });
				assert.equal(result, true);
				assert.equal(writes.length, 1);
				assert.deepEqual(writes[0].levels.find((level) => level.id === "standard")[field], [corrected]);
				assert.equal(section.dirty.at(-1), false);
			});
		});
	}
	test(`${field} accepts Unicode 16 capture names supported by Pi`, async () => {
		await withHookHost(async (host) => {
			const writes = [];
			const section = await mountSection(host, async (patch) => {
				writes.push(copy(patch));
				return { ok: true, config: { ...section.initial, ...patch } };
			});
			const pattern = "(?<\u{105C0}>a)";
			await host.act(async () => section.card().props.onChange({ [field]: [pattern] }));
			let result;
			await host.act(async () => { result = await section.ref.current.save(); });
			assert.equal(result, true);
			assert.equal(writes.length, 1);
			assert.deepEqual(writes[0].levels.find((level) => level.id === "standard")[field], [pattern]);
			assert.equal(section.dirty.at(-1), false);
		});
	});
}

test("security saves preserve PowerShell edits made while the request is pending", async () => {
	await withHookHost(async (host) => {
		const pending = deferred();
		const writes = [];
		const section = await mountSection(host, (patch) => { writes.push(copy(patch)); return pending.promise; });
		await host.act(async () => section.card().props.onChange({ denyPowerShellPatterns: ["before-save"] }));
		let result;
		await host.act(async () => { result = section.ref.current.save(); });
		await host.act(async () => section.card().props.onChange({ denyPowerShellPatterns: ["newer-draft"] }));
		await host.act(async () => pending.resolve({ ok: true, config: { ...section.initial, ...writes[0] } }));
		assert.deepEqual(copy(section.card().props.level.denyPowerShellPatterns), ["newer-draft"]);
		assert.equal(section.dirty.at(-1), true);
		assert.equal(await result, false, "save-and-close must keep the newer draft open");
	});
});

test("simultaneous security saves share one request", async () => {
	await withHookHost(async (host) => {
		const pending = deferred();
		const writes = [];
		const section = await mountSection(host, (patch) => { writes.push(copy(patch)); return pending.promise; });
		await host.act(async () => section.card().props.onChange({ denyPowerShellPatterns: ["custom-rule"] }));
		let first;
		let second;
		await host.act(async () => {
			first = section.ref.current.save();
			second = section.ref.current.save();
		});
		await host.act(async () => pending.resolve({ ok: true, config: { ...section.initial, ...writes[0] } }));
		assert.equal(writes.length, 1);
		assert.equal(await first, true);
		assert.equal(await second, true);
	});
});
