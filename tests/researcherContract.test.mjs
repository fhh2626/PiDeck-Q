import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const researcherPrompt = readFileSync("resources/extensions/pideck-q-subagents/agents/researcher.md", "utf8");

test("Researcher agent prompt contract: valid tool references", () => {
	// 1. 验证 frontmatter 中 tools 声明
	const frontmatterMatch = researcherPrompt.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	assert.ok(frontmatterMatch, "researcher.md must have YAML frontmatter");
	const frontmatter = frontmatterMatch[1];

	// tools 声明中必须包含 web_search 与 webfetch
	assert.match(frontmatter, /tools:\s*\[?[^\]\n]*\bweb_search\b/, "frontmatter tools must include web_search");
	assert.match(frontmatter, /tools:\s*\[?[^\]\n]*\bwebfetch\b/, "frontmatter tools must include webfetch");

	// 禁止在 tools 中出现已废弃或不存在的工具
	assert.doesNotMatch(frontmatter, /\bfetch_content\b/, "frontmatter tools must not include fetch_content");
	assert.doesNotMatch(frontmatter, /\bget_search_content\b/, "frontmatter tools must not include get_search_content");
	assert.doesNotMatch(frontmatter, /\bsource_check\b/, "frontmatter tools must not include source_check");

	// 2. 验证正文提示词中工具调用指示
	assert.match(researcherPrompt, /web_search/, "prompt text must reference web_search");
	assert.match(researcherPrompt, /webfetch/, "prompt text must reference webfetch");

	// 验证参数语义正确性：web_search 对应 query，webfetch 对应 url / script / offset
	assert.match(researcherPrompt, /`query`|query:/i, "prompt must specify query parameter for search");
	assert.match(researcherPrompt, /`url`|url:/i, "prompt must specify url parameter for webfetch");

	// 正文中禁止出现已废弃或不存在的工具与参数
	assert.doesNotMatch(researcherPrompt, /\bfetch_content\b/, "prompt text must not reference fetch_content");
	assert.doesNotMatch(researcherPrompt, /\bget_search_content\b/, "prompt text must not reference get_search_content");
	assert.doesNotMatch(researcherPrompt, /\bsource_check\b/, "prompt text must not reference source_check");
	assert.doesNotMatch(researcherPrompt, /\bqueries\b\s*:/, "prompt text must not refer to queries param for search");

	// 3. 必须明确关于 script 参数的语义警示：正文提取时省略 script 或传 null，0 是第一个 inline script
	assert.match(researcherPrompt, /script/i, "prompt text must mention script parameter semantics");
	assert.match(researcherPrompt, /0/i, "prompt text must mention that script: 0 is the first inline script");
});
