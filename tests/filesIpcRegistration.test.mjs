import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ipc = readFileSync("src/shared/ipc.ts", "utf8");
const filesIpc = readFileSync("src/main/ipc/filesIpc.ts", "utf8");

/**
 * 回归（30b6954b）：新增 files:copy/files:move 时误删了 filesShowInFolder
 * handler，渲染层右键「在文件夹中显示」报 No handler registered。
 * 这里校验 shared/ipc.ts 中每个 files:* 通道都在 filesIpc.ts 注册了 handler，
 * 任何通道漏注册（或反向误删）都会让本测试先红。
 */
test("every files:* channel in shared/ipc.ts has a handler registered in filesIpc.ts", () => {
  // 从 ipc.ts 提取 files* 常量名（filesList / filesOpen / ...）
  const channelKeys = [...ipc.matchAll(/^\t(files\w+):\s*"files:/gm)].map((m) => m[1]);
  assert.ok(channelKeys.length >= 10, `expected files:* channels, got ${channelKeys.length}`);

  const missing = channelKeys.filter(
    (key) => !filesIpc.includes(`ipcChannels.${key}`),
  );
  assert.deepEqual(missing, [], "filesIpc.ts must register a handler for every files:* channel");
});

test("files:show-in-folder handler authorizes a Windows-converted path", () => {
  // 具体断言修复目标：handler 仍经过共享路径转换和边界校验（WSL 路径可用）
  const block = filesIpc.match(
    /router\.handle\(\s*ipcChannels\.filesShowInFolder,[\s\S]*?showItemInFolder\(authorizePath\(path, "show-in-folder"\)\);/,
  );
  assert.ok(block, "filesShowInFolder handler must authorize the path before opening its folder");
  assert.match(filesIpc, /const toHostPath = \(path: string\): string => toWindowsPath\(path\)/);
});

test("file mutation handlers normalize host paths and use authorization checks", () => {
	assert.match(filesIpc, /writeFile\(authorizePath\(path, "write"\)/);
	assert.match(filesIpc, /fileSystemService\.delete\(hostPath, recursive\)/);
	assert.match(filesIpc, /fileSystemService\.rename\(hostPath, newName\)/);
	assert.match(filesIpc, /const hostTargetDir = authorizePath\(targetDir, "copy-target"\)/);
	assert.match(filesIpc, /const hostTargetDir = authorizePath\(targetDir, "move-target"\)/);
	assert.match(filesIpc, /const hostSource = authorizePath\(src, "move-source"\)/);
	assert.match(filesIpc, /fsOperations\.copy\(hostSource, dest, \{[\s\S]*?force: false,[\s\S]*?errorOnExist: true/);
});
