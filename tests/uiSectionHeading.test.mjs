import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const heading = readFileSync(
  "src/renderer/src/components/ui-shadcn/section-heading.tsx",
  "utf8",
);
const storage = readFileSync(
  "src/renderer/src/components/app/settings/SettingsStorageTab.tsx",
  "utf8",
);
const piSettings = readFileSync(
  "src/renderer/src/config/SettingsTab.tsx",
  "utf8",
);
test("shared SectionHeading defines one title and description hierarchy", () => {
  assert.match(heading, /text-sm font-semibold leading-5 text-foreground/);
  assert.match(heading, /text-xs font-normal leading-4 text-muted-foreground/);
  assert.match(heading, /props\.description/);
});

test("settings and Pi management sections use the shared heading", () => {
  assert.match(storage, /import \{ SectionHeading \} from "\.\.\/\.\.\/ui-shadcn\/section-heading"/);
  assert.match(storage, /className="settings-section-header pb-1"/);
  assert.match(piSettings, /import \{ SectionHeading \} from "\.\.\/components\/ui-shadcn\/section-heading"/);
  assert.equal((piSettings.match(/<SectionHeading/g) ?? []).length, 3);
  assert.doesNotMatch(piSettings, /config-settings-section-title/);
});
