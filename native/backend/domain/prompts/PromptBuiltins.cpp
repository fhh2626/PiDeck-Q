#include "PromptBuiltins.h"

namespace promptbuiltins {
namespace {

/**
 * The ten recommended templates shipped by PiDeck.
 *
 * Byte-identical to BUILTIN_TEMPLATES in src/main/prompts/PromptManager.ts, including
 * the escaped backticks in the review/commit bodies; the renderer copies `content` into
 * the composer verbatim, so a single changed character is a user-visible divergence.
 * `tests/native2PromptsSkillsParity.test.mjs` compares this table against the oracle.
 */
const Builtin kBuiltins[] = {
    {QStringLiteral("commit"),
     QStringLiteral("Generate a conventional commit message from staged changes"),
     QStringLiteral(R"PROMPT(---
description: Generate a conventional commit message
---

Generate a conventional commit message from the staged changes (\`git diff --cached\`).
Format: \`type(scope): description\`

Types: feat, fix, refactor, docs, style, test, chore, perf, ci, build, revert)PROMPT")},
    {QStringLiteral("doc"),
     QStringLiteral("Add or improve documentation and comments"),
     QStringLiteral(R"PROMPT(---
description: Add or improve documentation
---

Add or improve documentation. Include:
- A brief overview of what it does
- Parameters and return values
- Usage examples where helpful
- Edge cases and assumptions)PROMPT")},
    {QStringLiteral("explain"),
     QStringLiteral("Explain code or architecture in simple terms"),
     QStringLiteral(R"PROMPT(---
description: Explain code or architecture
---

Explain in simple terms. Cover:
- What it does at a high level
- Key design decisions
- How it fits into the broader architecture
- Potential improvements or concerns)PROMPT")},
    {QStringLiteral("fix"),
     QStringLiteral("Debug and fix issues with root cause analysis"),
     QStringLiteral(R"PROMPT(---
description: Debug and fix issues with root cause analysis
---

Debug and fix the following issue. Before making any changes:
1. Analyze the root cause
2. List affected files
3. Propose the fix
4. After confirming, apply the fix)PROMPT")},
    {QStringLiteral("pi-system"),
     QStringLiteral("View pi's default system prompt (identity, tools, guidelines)"),
     QStringLiteral(R"PROMPT(---
description: Pi system prompt
---

这是 pi 的默认系统提示词——核心身份描述、可用工具列表、行为准则和文档路径，定义了 AI agent 的行为基础。

---

You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
- read: Read file contents
- bash: Execute bash commands (ls, grep, find, etc.)
- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call
- write: Create or overwrite files
- ask_question: Ask the user a question (or a batch of questions) and wait for responses
- todo: Manage a todo list (add / toggle / clear)
- web_search: Use for web research questions with a focused {query:"..."}
- fetch_content: Use to extract readable content from URL(s), YouTube, GitHub repos, or local videos
- mcp: MCP gateway - connect to MCP servers and call their tools

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
- Use bash for file operations like ls, rg, find
- Use read to examine files instead of cat or sed.
- Use edit for precise changes
- Keep edits[].oldText as small as possible while still being unique
- Be concise in your responses
- Show file paths clearly when working with files

Current date: YYYY-MM-DD
Current working directory: /path/to/project)PROMPT")},
    {QStringLiteral("refactor"),
     QStringLiteral("Refactor code for better readability and maintainability"),
     QStringLiteral(R"PROMPT(---
description: Refactor code
---

Refactor. Follow these principles:
- Keep the same external behavior
- Improve readability and naming
- Reduce duplication
- Add type annotations where they improve clarity
- Maintain backward compatibility)PROMPT")},
    {QStringLiteral("review"),
     QStringLiteral("Review staged git changes for bugs, security issues, and logic errors"),
     QStringLiteral(R"PROMPT(---
description: Review staged git changes
---

Review the staged changes (\`git diff --cached\`). Focus on:
- Bugs and logic errors
- Security issues
- Error handling gaps
- Edge cases and boundary conditions)PROMPT")},
    {QStringLiteral("skill-discipline"),
     QStringLiteral("Skills execution discipline: rules for when and how to trigger agent skills"),
     QStringLiteral(R"PROMPT(---
description: Skills execution discipline: rules for when and how to trigger agent skills
---

# ========================================================================
# Skill Execution Discipline
# ========================================================================

This section defines when and how skills from available_skills should be triggered.
It helps suppress the tendency to "think first, then call a skill", ensuring skills
are invoked promptly when appropriate.

## Core Principle

Available skills are registered in this system. You should and must call them
when appropriate. If unsure whether a skill is needed, follow the rule:
**"Call before thinking"**—the cost of calling a skill is far lower than the risk of missing one.
**Skills are not a substitute for thinking; they are the starting point for thinking.**

## Execution Rules

1. **Trigger and Execute**: When user input matches any description or TRIGGERS
   keyword/scenario in a skill, call it immediately. Do NOT:
   - "Let me reason first, then decide"
   - "This is simple enough, I'll handle it"
   - "I'll give a preliminary answer first"

2. **No Bypassing**: If you catch yourself "answering yourself" instead of
   "calling a skill then answering", pause and re-evaluate.

3. **Priority Order** (conflict resolution):
   P0 — Meta skills (always first)
   P1 — Process discipline (testing, debugging, verification)
   P2 — Problem solving (plans, diagnosis, conflict resolution)
   P3 — Functional tools (browser, file organizer, vault)
   P4 — Design/review (codebase design, domain modeling, code review)
   P5 — Other skills by relevance

4. **Fallback**: When multiple skills might match and you're unsure which to pick,
   call the meta skill or output the candidate list for the user to choose.

## Thinking Inhibition

> Do NOT perform prolonged independent reasoning before calling a skill.
> The right flow: user input → check TRIGGERS → call skill → follow skill instructions

## Recursion Guard
> Each skill is called at most once per conversation turn unless context changes significantly.
> Avoid A calls B, B references A in an infinite loop.)PROMPT")},
    {QStringLiteral("test"),
     QStringLiteral("Write tests for a function or component covering edge cases"),
     QStringLiteral(R"PROMPT(---
description: Write tests for a function or component
---

Write comprehensive tests. Cover:
- Happy path
- Edge cases and boundary conditions
- Error handling
- Type correctness)PROMPT")},
};

} // namespace

const QVector<Builtin> &all()
{
    static const QVector<Builtin> table = [] {
        QVector<Builtin> items;
        for (const Builtin &item : kBuiltins) items.append(item);
        return items;
    }();
    return table;
}

QStringList names()
{
    QStringList list;
    for (const Builtin &item : all()) list.append(item.name);
    return list;
}

bool isBuiltinName(const QString &name)
{
    return names().contains(name);
}

} // namespace promptbuiltins
