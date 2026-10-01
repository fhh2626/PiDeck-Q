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
    /router\.handle\(\s*ipcChannels\.filesShowInFolder,[\s\S]*?showItemInFolder\(await authorizePath\(path, "show-in-folder", "read"\)\);/,
  );
  assert.ok(block, "filesShowInFolder handler must authorize the path before opening its folder");
  assert.match(filesIpc, /const toHostPath = \(path: string\): string => toWindowsPath\(path\)/);
});

// H4：本用例原来还断言 rename / copy 的源码正则，这些已由行为测试覆盖：
// - rename 不覆盖已有目标、换名规则：tests/renameWithoutOverwrite.test.mjs
// - copy 冲突换名、目录不合并、不自我递归：tests/copyToFreeName.test.mjs
// - 两个 handler 的端到端行为（含换号与拒绝合并）：tests/filesIpcPlatform.test.mjs
// 这里只保留「授权在副作用之前」这条结构约束——它描述的是调用顺序，
// 用注入 stub 只能断言“被调用”，无法证明“先授权后调用”。
test("file mutation handlers authorize every path before touching the filesystem", () => {
	assert.match(filesIpc, /const hostPath = await authorizePath\(path, "write", "write"\)/);
	assert.match(filesIpc, /const hostTargetDir = await authorizePath\(targetDir, "copy-target", "read"\)/);
	assert.match(filesIpc, /const hostTargetDir = await authorizePath\(targetDir, "move-target", "read"\)/);
	assert.match(filesIpc, /const hostSource = await authorizePath\(src, "move-source", "link"\)/);
	assert.match(filesIpc, /const toHostPath = \(path: string\): string => toWindowsPath\(path\)/);
	// 外部文件只能凭 capability 读，不允许渲染层自报路径
	assert.match(filesIpc, /ipcChannels\.filesCopyExternal/);
	assert.match(filesIpc, /externalFileCapabilities\?\.consumeRead/);
});
