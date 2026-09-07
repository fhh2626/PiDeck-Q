import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const nativeSensitiveModules = [
	"src/renderer/src/components/session/SecurityLevelMenu.tsx",
	"src/renderer/src/components/config/SecuritySection.tsx",
	"src/renderer/src/config/SkillStoreTab.tsx",
	"src/renderer/src/config/SkillHubStorePanel.tsx",
	"src/renderer/src/ConfigModal.tsx",
];

test("native-sensitive renderer modules resolve the API after async native bootstrap", () => {
	for (const file of nativeSensitiveModules) {
		const source = readFileSync(file, "utf8");
		assert.match(
			source,
			/import\s+\{[^}]*\bdesktopApi\b[^}]*\}\s+from\s+["'][^"']*desktopApi["']/s,
			`${file} must use the live desktopApi binding`,
		);
		assert.doesNotMatch(
			source,
			/const\s+api\b[^\n]*window\.piDesktop|const\s+api:\s*[^=]+=[\s\S]{0,180}?window\.piDesktop/,
			`${file} must not capture window.piDesktop before native bootstrap completes`,
		);
	}
});
