import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
	testDir: resolve(__dirname),
	testMatch: /.*\.spec\.ts$/,
	timeout: 30000,
	use: {
		baseURL: "http://127.0.0.1:5189",
		headless: true,
		launchOptions: {
			executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
		},
	},
	webServer: {
		command: "npm run test:browser:server",
		url: "http://127.0.0.1:5189/tests/browser/imagePreview.html",
		reuseExistingServer: false,
		timeout: 30000,
	},
	projects: [
		{
			name: "edge",
			use: { ...devices["Desktop Chrome"] },
		},
	],
});
