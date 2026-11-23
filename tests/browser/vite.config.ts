import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
	// Worker-only dynamic imports are not discovered by the HTML scan. Prebundle
	// Shiki before tests start so its first use cannot reload the fixture mid-probe.
	optimizeDeps: { entries: ["tests/browser/*.html"], include: ["shiki"] },
	server: {
		host: "127.0.0.1",
		port: 5189,
		strictPort: true,
	},
	resolve: {
		alias: {
			"@": resolve("src/renderer/src"),
			"@renderer": resolve("src/renderer/src"),
			"@shared": resolve("src/shared"),
		},
	},
	plugins: [react(), tailwindcss()],
});
