import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");

test("desktop pet runtime, renderer, and bundled resources are removed", () => {
	for (const path of [
		"src/main/pet",
		"src/renderer/src/pet",
		"src/renderer/pet.html",
		"src/shared/petNotificationLayout.ts",
		"build/pets",
	]) {
		assert.equal(existsSync(path), false, path);
	}
});

test("desktop pet is absent from cross-process APIs, settings menu, and build inputs", () => {
	const sources = [
		read("src/native-node/index.ts"),
		read("src/shared/desktop/createPiDesktopApi.ts"),
		read("src/shared/ipc.ts"),
		read("src/shared/types/settings.ts"),
		read("src/renderer/src/components/app/SettingsModal.tsx"),
		read("vite.config.ts"),
		read("package.json"),
	];
	for (const source of sources) {
		assert.doesNotMatch(source, /desktop.?pet|桌面宠物|piDesktop\.pet|\bpet(?:Enabled|Id|AlwaysOnTop|Scale|Patrol)|pet:/i);
	}
});
