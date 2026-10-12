import { readdirSync, readFileSync } from "node:fs";

const entryPath = "src/native-node/index.ts";
const ipcDirectory = "src/main/ipc";
const backendDirectory = "src/main/backend";
const mainDomainPaths = [
  "src/main/window/MainWindowControlsContract.ts",
  "src/native-node/host/NativeMainWindowControls.ts",
  // E1：会话改名/删除/归档已收口到领域服务，"session.*" 文案引用随之移到这里。
  "src/main/sessions/SessionRecordService.ts",
];

export const mainIpcSources = [
  { path: entryPath, source: readFileSync(entryPath, "utf8") },
  ...mainDomainPaths.map((path) => ({ path, source: readFileSync(path, "utf8") })),
  ...readdirSync(backendDirectory)
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => {
      const path = `${backendDirectory}/${name}`;
      return { path, source: readFileSync(path, "utf8") };
    }),
  ...readdirSync(ipcDirectory)
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => {
      const path = `${ipcDirectory}/${name}`;
      return { path, source: readFileSync(path, "utf8") };
    }),
];

export const mainIpcSource = mainIpcSources
  .map(({ path, source }) => `// ${path}\n${source}`)
  .join("\n");
