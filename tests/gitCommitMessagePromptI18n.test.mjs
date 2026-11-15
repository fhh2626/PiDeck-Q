import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFakeRouter } from "./helpers/l3_ipcHarness.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	DEFAULT_GIT_COMMIT_MESSAGE_PROMPT_EN_US,
	DEFAULT_GIT_COMMIT_MESSAGE_PROMPT_ZH_CN,
	getDefaultGitCommitMessagePrompt,
	isDefaultGitCommitMessagePrompt,
	resolveGitCommitMessagePromptLocale,
} = loadTsCommonJs("src/shared/gitCommitMessagePrompt.ts");

test("commit prompt defaults are distinct localized templates with a diff slot", () => {
	const zh = getDefaultGitCommitMessagePrompt("zh-CN");
	const en = getDefaultGitCommitMessagePrompt("en-US");
	assert.equal(zh, DEFAULT_GIT_COMMIT_MESSAGE_PROMPT_ZH_CN);
	assert.equal(en, DEFAULT_GIT_COMMIT_MESSAGE_PROMPT_EN_US);
	assert.match(zh, /中文 git commit message/);
	assert.match(en, /English git commit message/);
	assert.match(zh, /\{diff\}/);
	assert.match(en, /\{diff\}/);
	assert.notEqual(zh, en);
});

test("commit prompt locale follows an explicit language, otherwise the system language", () => {
	assert.equal(resolveGitCommitMessagePromptLocale("zh-CN", "en-US"), "zh-CN");
	assert.equal(resolveGitCommitMessagePromptLocale("en-US", "zh-CN"), "en-US");
	assert.equal(resolveGitCommitMessagePromptLocale("en_GB"), "en-US");
	assert.equal(resolveGitCommitMessagePromptLocale("pseudo", "zh-CN"), "en-US");
	assert.equal(resolveGitCommitMessagePromptLocale("system", "en-US"), "en-US");
	assert.equal(resolveGitCommitMessagePromptLocale("system", "zh-Hans"), "zh-CN");
	assert.equal(resolveGitCommitMessagePromptLocale(undefined, undefined), "zh-CN");
});

test("only an empty value or an exact built-in template counts as the default prompt", () => {
	assert.equal(isDefaultGitCommitMessagePrompt(""), true);
	assert.equal(isDefaultGitCommitMessagePrompt("   "), true);
	assert.equal(isDefaultGitCommitMessagePrompt(DEFAULT_GIT_COMMIT_MESSAGE_PROMPT_ZH_CN), true);
	assert.equal(isDefaultGitCommitMessagePrompt(DEFAULT_GIT_COMMIT_MESSAGE_PROMPT_EN_US), true);
	assert.equal(isDefaultGitCommitMessagePrompt(` ${DEFAULT_GIT_COMMIT_MESSAGE_PROMPT_ZH_CN}`), false);
	assert.equal(isDefaultGitCommitMessagePrompt("custom\n{diff}"), false);
});

function loadSettingsStore() {
	return loadTsCommonJs("src/main/settings/SettingsStore.ts", {
		stubs: { electron: { app: { getPath: () => tmpdir() } } },
	});
}

test("SettingsStore localizes a built-in commit prompt and leaves a custom template alone", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-commit-prompt-"));
	const settingsFile = join(tempDir, "settings.json");
	try {
		writeFileSync(settingsFile, JSON.stringify({
			language: "en-US",
			gitCommitMessagePrompt: DEFAULT_GIT_COMMIT_MESSAGE_PROMPT_ZH_CN,
		}), "utf8");
		const { SettingsStore } = loadSettingsStore();
		const store = new SettingsStore({
			desktopSettingsFile: settingsFile,
			getSystemLocale: () => "zh-CN",
		});
		await store.load();
		assert.equal(store.get().gitCommitMessagePrompt, DEFAULT_GIT_COMMIT_MESSAGE_PROMPT_EN_US);

		const custom = "custom template\n{diff}";
		await store.update({ gitCommitMessagePrompt: custom });
		await store.update({ language: "zh-CN" });
		assert.equal(store.get().gitCommitMessagePrompt, custom);

		await store.update({
			language: "zh-CN",
			gitCommitMessagePrompt: DEFAULT_GIT_COMMIT_MESSAGE_PROMPT_ZH_CN,
		});
		const switched = await store.update({ language: "en-US" });
		assert.equal(switched.gitCommitMessagePrompt, DEFAULT_GIT_COMMIT_MESSAGE_PROMPT_EN_US);
	} finally {
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
});

test("commit message generation fills the saved template, or the locale default when it is empty", async () => {
	const prompts = [];
	const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
	const { registerGitIpc } = loadTsCommonJs("src/main/ipc/gitIpc.ts", {
		stubs: {
			"../git/QuickGenerator": {
				createQuickGenerator: () => ({
					generate: async (_cwd, promptText) => {
						prompts.push(promptText);
						return " feat: ok \n";
					},
					dispose: () => {},
				}),
			},
		},
	});
	const settings = {
		gitCommitMessageProvider: "openai",
		gitCommitMessageModel: "gpt-test",
		gitCommitMessagePrompt: "",
	};
	const router = createFakeRouter();
	const dispose = registerGitIpc(router, {
		appLogger: { info() {}, warn() {}, error() {} },
		mainCopy: (key) => key,
		getLocale: () => "en-US",
		gitService: { getStagedDiff: async () => "diff --git a/a b/a\n+hello" },
		piLocator: {},
		projectStore: { get: (id) => (id === "p1" ? { id, path: "/work/p1" } : undefined) },
		settingsStore: { get: () => settings },
		worktreeService: {},
		getAuthorizedRoots: () => ["/work/p1"],
	});
	try {
		const generated = await router.invoke(ipcChannels.gitGenerateCommitMessage, "p1");
		assert.equal(generated.ok, true);
		assert.equal(generated.message, "feat: ok");
		assert.match(prompts[0], /English git commit message/);
		assert.match(prompts[0], /\+hello/);
		assert.doesNotMatch(prompts[0], /\{diff\}/);

		settings.gitCommitMessagePrompt = "ONLY-CUSTOM\n{diff}";
		await router.invoke(ipcChannels.gitGenerateCommitMessage, "p1");
		assert.match(prompts[1], /^ONLY-CUSTOM\ndiff --git/);
		assert.match(prompts[1], /\+hello/);
	} finally {
		dispose();
	}
});
