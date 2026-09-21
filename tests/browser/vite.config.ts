import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
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
