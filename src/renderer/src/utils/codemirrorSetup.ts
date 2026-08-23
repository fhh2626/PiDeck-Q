import { StreamLanguage, HighlightStyle, syntaxHighlighting, type Language, type LanguageSupport } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

// 官方语言包与 legacy-modes 改为按需动态 import（见下方 loadEditorLanguage）：
// 用户只聊天时不再把十几个 CodeMirror parser 拉进 renderer 初始模块图。
// core（language/state/view/lezer）仍静态，因为 baseEditorExtensions 首帧就要用。

/** 语言包类型：官方包返回 LanguageSupport，legacy-modes 的 StreamLanguage 返回 Language，
 * 两者都能直接作为 extension 安装，统一用联合类型避免各自强转。 */
export type EditorLanguage = Language | LanguageSupport;

/** 语言 loader 的 Promise 缓存：同一 key 并发打开多文件时只 import/创建一次 parser。
 * 与 Markdown renderer 的「全局 Promise + 失败清缓存」同思路：失败时删掉缓存项，
 * 下次重试可重新 import，不会永久卡在失败态。 */
const languagePromiseCache = new Map<string, Promise<EditorLanguage | null>>();

/** 真正加载某个归一化 key 的语言解析器：按需 import 对应包。
 * 冷门 legacy 语言用 StreamLanguage 包装经典 CM5 模式（官方 Lezer 包没有 shell/ruby/toml 等）。 */
async function actuallyLoadLanguage(key: string): Promise<EditorLanguage | null> {
  switch (key) {
    case "js":
    case "mjs":
    case "cjs":
    case "javascript": {
      const { javascript } = await import("@codemirror/lang-javascript");
      return javascript();
    }
    case "jsx": {
      const { javascript } = await import("@codemirror/lang-javascript");
      return javascript({ jsx: true });
    }
    case "ts":
    case "typescript": {
      const { javascript } = await import("@codemirror/lang-javascript");
      return javascript({ typescript: true });
    }
    case "tsx": {
      const { javascript } = await import("@codemirror/lang-javascript");
      return javascript({ jsx: true, typescript: true });
    }
    case "json":
    case "jsonc": {
      const { json } = await import("@codemirror/lang-json");
      return json();
    }
    case "md":
    case "mdx":
    case "markdown": {
      const { markdown } = await import("@codemirror/lang-markdown");
      return markdown();
    }
    case "css": {
      const { css } = await import("@codemirror/lang-css");
      return css();
    }
    case "scss": {
      const { sass } = await import("@codemirror/lang-sass");
      return sass({ indented: false });
    }
    case "less": {
      const { less } = await import("@codemirror/lang-less");
      return less();
    }
    case "html":
    case "htm": {
      const { html } = await import("@codemirror/lang-html");
      return html();
    }
    case "yaml":
    case "yml": {
      const { yaml } = await import("@codemirror/lang-yaml");
      return yaml();
    }
    case "xml":
    case "svg": {
      const { xml } = await import("@codemirror/lang-xml");
      return xml();
    }
    case "py":
    case "python": {
      const { python } = await import("@codemirror/lang-python");
      return python();
    }
    case "go": {
      const { go } = await import("@codemirror/lang-go");
      return go();
    }
    case "rs":
    case "rust": {
      const { rust } = await import("@codemirror/lang-rust");
      return rust();
    }
    case "java": {
      const { java } = await import("@codemirror/lang-java");
      return java();
    }
    case "c":
    case "c++":
    case "cpp":
    case "h":
    case "hpp": {
      const { cpp } = await import("@codemirror/lang-cpp");
      return cpp();
    }
    case "sql": {
      const { sql } = await import("@codemirror/lang-sql");
      return sql();
    }
    // legacy-modes：冷门语言用经典 CodeMirror 5 模式（StreamLanguage 包装），
    // 官方 Lezer 包没有 shell/ruby/toml/dockerfile 等，一个包覆盖，避免引多个社区包。
    case "sh":
    case "bash":
    case "zsh":
    case "shell": {
      const { shell: shellMode } = await import("@codemirror/legacy-modes/mode/shell");
      return StreamLanguage.define(shellMode);
    }
    case "rb":
    case "ruby": {
      const { ruby: rubyMode } = await import("@codemirror/legacy-modes/mode/ruby");
      return StreamLanguage.define(rubyMode);
    }
    case "proto": {
      const { protobuf: protobufMode } = await import("@codemirror/legacy-modes/mode/protobuf");
      return StreamLanguage.define(protobufMode);
    }
    case "toml": {
      const { toml: tomlMode } = await import("@codemirror/legacy-modes/mode/toml");
      return StreamLanguage.define(tomlMode);
    }
    case "ini":
    case "cfg":
    case "env": {
      const { properties: propertiesMode } = await import("@codemirror/legacy-modes/mode/properties");
      return StreamLanguage.define(propertiesMode);
    }
    case "dockerfile": {
      const { dockerFile: dockerfileMode } = await import("@codemirror/legacy-modes/mode/dockerfile");
      return StreamLanguage.define(dockerfileMode);
    }
    default:
      // 无官方/稳定包的冷门类型（makefile/graphql/gql/plaintext 等）明确降级纯文本
      return null;
  }
}

/**
 * 按需加载编辑器语言：先 normalize（trim + lowercase），命中 Promise 缓存直接返回；
 * 否则真正 import 对应包并缓存。扩展名（"ts"）与旧 Monaco 语言 id（"typescript"/"markdown"）
 * 都支持。null 表示无对应模式（降级纯文本）。
 */
export function loadEditorLanguage(input?: string): Promise<EditorLanguage | null> {
  const key = input?.trim().toLowerCase();
  if (!key) return Promise.resolve(null);
  const cached = languagePromiseCache.get(key);
  if (cached) return cached;
  const promise = actuallyLoadLanguage(key).catch((error) => {
    // 失败清缓存：下次重试可重新 import，不永久卡在失败态
    languagePromiseCache.delete(key);
    throw error;
  });
  languagePromiseCache.set(key, promise);
  return promise;
}

/** 编辑器 UI 主题：全部引用应用 CSS 变量，随 data-theme 明暗自动切换，
 * 与侧栏/弹框等 shadcn token 保持一致，不写死色值。 */
const editorThemeSpec = {
  "&": {
    backgroundColor: "var(--color-bg-panel)",
    color: "var(--color-text-primary)",
    fontSize: "13px",
    height: "100%",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-family-mono)", lineHeight: "1.6" },
  ".cm-content": { caretColor: "var(--color-accent)", padding: "12px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-accent)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--color-accent-soft)",
  },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--color-text-tertiary)", border: "none", borderRight: "1px solid var(--color-border-subtle)", paddingRight: "2px" },
  ".cm-activeLine": { backgroundColor: "var(--color-bg-active)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--color-bg-active)", color: "var(--color-text-primary)" },
  // 折叠箭头：加粗 + 放大 + 透明度渐现（hover 时全显）；折叠列宽度由 CM6 自动测量
  ".cm-foldGutter .cm-gutterElement span": { fontWeight: "700", fontSize: "15px", lineHeight: "1" },
  ".cm-foldGutter .cm-gutterElement": { cursor: "pointer", opacity: 0.35, transition: "opacity 0.12s, color 0.12s", textAlign: "center", display: "flex", alignItems: "center", justifyContent: "center" },
  ".cm-foldGutter .cm-gutterElement:hover": { opacity: 1, color: "var(--color-accent)" },
  ".cm-foldPlaceholder": { backgroundColor: "color-mix(in srgb, #4C8BF5 10%, transparent)", border: "1px solid color-mix(in srgb, #4C8BF5 20%, transparent)", color: "var(--color-accent)", borderRadius: "3px", padding: "0 4px", cursor: "pointer" },
  ".cm-tooltip": { backgroundColor: "var(--color-bg-panel)", border: "1px solid var(--color-border-subtle)", borderRadius: "var(--radius-sm)" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--color-bg-active)", color: "var(--color-text-primary)" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { color: "var(--color-text-secondary)" },
  ".cm-searchMatch": { backgroundColor: "var(--color-accent-soft)", outline: "1px solid var(--color-accent-strong)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--color-accent)", color: "var(--color-text-inverse)" },
  ".cm-panels": { backgroundColor: "var(--color-bg-panel)", color: "var(--color-text-primary)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--color-border-subtle)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--color-border-subtle)" },
  ".cm-button": { backgroundImage: "none", background: "var(--color-bg-muted)", border: "1px solid var(--color-border-default)", borderRadius: "var(--radius-sm)", color: "var(--color-text-primary)" },
  ".cm-textfield": { background: "var(--color-bg-input)", border: "1px solid var(--color-border-default)", borderRadius: "var(--radius-sm)", color: "var(--color-text-primary)" },
  ".cm-selectionMatch": { backgroundColor: "var(--color-accent-soft)" },
} as const;

export const editorTheme = EditorView.theme(editorThemeSpec, {
  dark: typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "dark",
});

/** 语法高亮配色：引用 --code-* CSS 变量（styles/ 里按 data-theme 定义明暗两套），
 * 高亮颜色随应用主题联动。 */
export const editorHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "var(--code-keyword)" },
  { tag: [t.string, t.special(t.string)], color: "var(--code-string)" },
  { tag: [t.comment, t.blockComment, t.lineComment], color: "var(--code-comment)", fontStyle: "italic" },
  { tag: [t.number, t.integer, t.float], color: "var(--code-number)" },
  { tag: [t.variableName, t.definition(t.variableName)], color: "var(--code-variable)" },
  { tag: [t.typeName, t.className, t.definition(t.typeName)], color: "var(--code-type)" },
  { tag: [t.function(t.variableName), t.definition(t.function(t.variableName)), t.function(t.propertyName)], color: "var(--code-function)" },
  { tag: [t.operator, t.arithmeticOperator, t.logicOperator, t.compareOperator], color: "var(--code-operator)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--code-property)" },
  { tag: [t.bool, t.null, t.atom], color: "var(--code-constant)" },
  { tag: [t.regexp, t.escape], color: "var(--code-string)" },
  { tag: [t.heading, t.strong], color: "var(--code-keyword)", fontWeight: "600" },
  { tag: [t.link, t.url], color: "var(--code-string)", textDecoration: "underline" },
  { tag: [t.quote, t.emphasis], color: "var(--code-comment)" },
  { tag: [t.meta, t.annotation, t.invalid], color: "var(--code-operator)" },
  { tag: t.invalid, textDecoration: "underline wavy var(--color-danger)" },
]);

/** 供 CodemirrorEditor 组合基础扩展：行号/折叠/历史/补全/查找/括号匹配等，
 * 等价于 Monaco 常用 options 集合（minimap 不需要，CM6 无此概念）。 */
export function baseEditorExtensions(opts: {
  readOnly?: boolean;
  wordWrap?: boolean;
  language?: EditorLanguage | null;
} = {}) {
  const { readOnly = false, wordWrap = false, language } = opts;
  return [
    editorTheme,
    syntaxHighlighting(editorHighlightStyle, { fallback: true }),
    ...(wordWrap ? [EditorView.lineWrapping] : []),
    ...(language ? [language] : []),
    // 只读只设 EditorState.readOnly，不设 EditorView.editable.of(false)：
    // editable=false 会移除 contenteditable 属性，浏览器原生选择（双击选词、
    // 三击选行、拖拽选块）全部失效；readOnly 在状态层拒绝一切变更事务，
    // 已足以阻止编辑，同时保留完整的鼠标选择/复制能力。
    ...(readOnly ? [EditorState.readOnly.of(true)] : []),
  ];
}
