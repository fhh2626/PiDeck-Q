import assert from "node:assert/strict";
import test from "node:test";
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
