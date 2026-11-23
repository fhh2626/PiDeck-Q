import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import type { Plugin } from "vite";

/**
 * Windows 盘符大小写工作区：cwd 为 `d:\...` 时，Vite 内部 realpath 可能返回 `D:\...`，
 * 导致 HTML inline proxy 的缓存 key 大小写不一致，构建报 "No matching HTML proxy module"。
 * 统一把盘符规范为大写，让 root/input/alias 与 realpath 结果一致；非 Windows 不变。
 */
const projectRoot = process.platform === "win32"
	? process.cwd().replace(/^([a-z]):/, (_, drive: string) => `${drive.toUpperCase()}:`)
	: process.cwd();
const fromProjectRoot = (...parts: string[]) => resolve(projectRoot, ...parts);

/** Keep renderer build behavior identical while removing Electron's main/preload targets. */
function katexWoff2OnlyPlugin(): Plugin {
	const KATEX_CSS = /katex[\\/]dist[\\/]katex\.min\.css/;
	const FONT_FACE_RE = /@font-face\s*\{([^}]*?src\s*:\s*)([^}]*?)\};?/gi;
	return {
		name: "katex-woff2-only",
		enforce: "pre",
		transform(code, id) {
			if (!KATEX_CSS.test(id)) return;
			const replaced = code.replace(FONT_FACE_RE, (_match, prefix, srcValue) => {
				const woff2Match = srcValue.match(/url\([^)]+\)\s*format\(['"]?woff2['"]?\)/i);
				if (!woff2Match) {
					const firstUrl = srcValue.match(/url\([^)]+\)/i);
					return firstUrl ? `@font-face{${prefix}${firstUrl[0]};}` : _match;
				}
				return `@font-face{${prefix}${woff2Match[0]};}`;
			});
			return { code: replaced, map: null };
		},
	};
}

export default defineConfig({
	root: fromProjectRoot("src/renderer"),
	server: {
		host: "127.0.0.1",
		port: 5181,
	},
	optimizeDeps: {
		include: [
			"@ai-sdk/react", "ai", "@ai-sdk/provider", "@ai-sdk/provider-utils",
			"@ai-sdk/mcp", "@ai-sdk/gateway", "swr", "throttleit", "json-schema",
			"eventsource-parser", "undici", "pkce-challenge", "dequal",
			"use-sync-external-store", "@standard-schema/spec", "@workflow/serde",
		],
	},
	resolve: {
		alias: {
			"@": fromProjectRoot("src/renderer/src"),
			"@renderer": fromProjectRoot("src/renderer/src"),
			"@shared": fromProjectRoot("src/shared"),
		},
	},
	plugins: [react(), tailwindcss(), katexWoff2OnlyPlugin()],
	worker: { format: "es" },
	build: {
		outDir: fromProjectRoot("out/renderer"),
		emptyOutDir: true,
		reportCompressedSize: false,
		cssMinify: "esbuild",
		rollupOptions: {
			input: {
				index: fromProjectRoot("src/renderer/index.html"),
				web: fromProjectRoot("src/renderer/web.html"),
			},
			output: {
			manualChunks(id) {
				if (id.includes("/node_modules/react/") || id.includes("/node_modules/react-dom/") || id.includes("/node_modules/scheduler/")) return "vendor-react";
				if (id.includes("/node_modules/lucide-react/")) return "vendor-icons";
			},
			},
		},
	},
});
