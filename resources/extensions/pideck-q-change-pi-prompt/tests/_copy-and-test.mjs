import { spawnSync } from 'node:child_process';
import { copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const src = 'D:/Users/Haohao/Documents/GitHub/PiDeck-Pi_Agent_Rust/resources/extensions/pideck-q-change-pi-prompt';
const dests = [
  'C:/Users/Haohao/.pi/agent/extensions/change-pi-prompt',
  'D:/Program Files/PiDeck/resources/extensions/pideck-q-change-pi-prompt',
];
for (const dest of dests) {
  for (const file of readdirSync(src).filter(name => !name.endsWith('.md') || true)) {
    const from = join(src, file);
    try { copyFileSync(from, join(dest, file)); } catch {}
  }
  for (const file of readdirSync(join(src, 'tests'))) {
    copyFileSync(join(src, 'tests', file), join(dest, 'tests', file));
  }
}
const result = spawnSync(process.execPath, ['--test', 'resources/extensions/pideck-q-change-pi-prompt/tests/*.test.mjs'], {
  cwd: 'D:/Users/Haohao/Documents/GitHub/PiDeck-Pi_Agent_Rust',
  stdio: 'inherit',
  shell: true,
});
process.exit(result.status ?? 1);
