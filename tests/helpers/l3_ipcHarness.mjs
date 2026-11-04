import { loadTsCommonJs } from "./loadTsCommonJs.mjs";

/**
 * 假 RpcRouter：记录每个通道的注册次数与处理函数。
 * 真实 RpcRouter 对重复注册不报错，所以“同一通道被两个模块各注册一次”
 * 只能靠 registrations 计数发现。
 */
export function createFakeRouter() {
  const handlers = new Map();
  const registrations = new Map();
  return {
    handlers,
    registrations,
    handle(channel, handler) {
      handlers.set(channel, handler);
      registrations.set(channel, (registrations.get(channel) ?? 0) + 1);
    },
    invoke(channel, ...args) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No handler registered: ${channel}`);
      return handler(...args);
    },
  };
}

const REGISTRAR_MODULES = {
  usageStats: ["../ipc/usageStatsIpc", "registerUsageStatsIpc"],
  editors: ["../ipc/editorsIpc", "registerEditorsIpc"],
  backgrounds: ["../ipc/backgroundsIpc", "registerBackgroundsIpc"],
  projects: ["../ipc/projectsIpc", "registerProjectsIpc"],
  scratchPad: ["../ipc/scratchPadIpc", "registerScratchPadIpc"],
  security: ["../ipc/securityIpc", "registerSecurityIpc"],
  vision: ["../ipc/visionIpc", "registerVisionIpc"],
  session: ["../ipc/sessionIpc", "registerSessionIpc"],
  git: ["../ipc/gitIpc", "registerGitIpc"],
  system: ["../ipc/systemIpc", "registerSystemIpc"],
  store: ["../ipc/storeIpc", "registerStoreIpc"],
  terminal: ["../ipc/terminalIpc", "registerTerminalIpc"],
  files: ["../ipc/filesIpc", "registerFilesIpc"],
};

/**
 * 在沙箱里加载真实的 registerBackendRpc，把各 `register*Ipc` 换成录制替身，
 * 这样可以断言“装配层把哪些服务交给了哪个 IPC 域”，而不依赖源码文字。
 * 所有服务都是带 `__name` 的假对象，便于用 === 校验传递的是同一实例。
 */
export function runBackendRpcWiring({ disposeGit = () => {}, modelListCache, timers, clearedTimers, sessionIpc = {} } = {}) {
  const captured = new Map();
  const stubs = {};
  for (const [key, [specifier, exportName]] of Object.entries(REGISTRAR_MODULES)) {
    stubs[specifier] = {
      [exportName]: (router, deps) => {
        captured.set(key, { router, deps });
        return key === "git" ? disposeGit : undefined;
      },
      // sessionIpc 还导出启动预扫描调度函数及其配对的清理函数
      scheduleCatalogBackgroundScan: () => true,
      disposeCatalogBackgroundScans: () => {},
    };
  }
  // 测试可覆盖 sessionIpc 的调度/清理导出，观察预扫描生命周期
  Object.assign(stubs[REGISTRAR_MODULES.session[0]], sessionIpc);
  stubs["../pi/modelListCache"] = modelListCache ?? { fetchModelList: async () => [], getCachedModelList: () => [] };
  stubs["../pi/PiProxyTester"] = { testPiProxy: async () => ({}) };
  stubs["../settings/DesktopProxy"] = { applyDesktopProxy: () => {} };
  stubs["../backgrounds/BackgroundPaths"] = { resolveBackgroundsDir: (dir) => `${dir}/backgrounds` };
  stubs["../backgrounds/BackgroundImageService"] = { BackgroundImageService: class {} };
  stubs["../fs/trash"] = { createTrashPath: () => () => {} };

  // 预扫描/预取用的 setTimeout 默认不触发，也不挂住事件循环；传入 timers 数组时把回调收集起来，由测试决定何时触发
  // 句柄带上回调，传入 clearedTimers 时记录被 clearTimeout 的句柄，便于断言 dispose 清理了哪些定时器
  const inertTimer = (fn) => {
    if (timers) timers.push(fn);
    return { unref() {}, callback: fn };
  };
  const { registerBackendRpc } = loadTsCommonJs("src/main/backend/registerBackendRpc.ts", {
    stubs,
    globals: { setTimeout: inertTimer, clearTimeout: (handle) => { clearedTimers?.push(handle); } },
  });

  const named = (__name, extra = {}) => ({ __name, ...extra });
  const services = {
    projectStore: named("projectStore", { list: () => [{ id: "p1", path: "/work/p1" }] }),
    fileSystemService: named("fileSystemService"),
    sessionScanner: named("sessionScanner"),
    sessionCatalog: named("sessionCatalog"),
    sessionRecordService: named("sessionRecordService"),
    sessionRuntimeCoordinator: named("sessionRuntimeCoordinator"),
    codexSessionImporter: named("codexSessionImporter"),
    claudeSessionImporter: named("claudeSessionImporter"),
    openCodeSessionImporter: named("openCodeSessionImporter"),
    settingsStore: named("settingsStore"),
    securityStore: named("securityStore"),
    worktreeService: named("worktreeService"),
    gitService: named("gitService"),
    piLocator: named("piLocator"),
    agentManager: named("agentManager"),
    configManager: named("configManager"),
    promptManager: named("promptManager", { getDir: () => "/prompts" }),
    xuePromptManager: named("xuePromptManager"),
    skillManager: named("skillManager", { getDirs: () => ["/skills"] }),
    extensionManager: named("extensionManager"),
    projectResourceManager: named("projectResourceManager"),
    webServiceManager: named("webServiceManager"),
    terminalManager: named("terminalManager"),
    appLogger: named("appLogger", { info() {}, warn() {}, error() {} }),
    rpcLogger: named("rpcLogger"),
    usageStatsService: named("usageStatsService"),
    modelSpecsStore: named("modelSpecsStore", { warm() {} }),
    visionBridge: named("visionBridge"),
  };
  const router = createFakeRouter();
  const platform = {
    paths: { home: "/home/u", userData: "/data" },
    shell: { trashItem: async () => {}, openPath: async () => "" },
    dialogs: named("dialogs"),
    application: named("application"),
    theme: named("theme"),
    proxy: named("proxy"),
  };
  const host = {
    sendToRenderer: () => {},
    mainWindowControls: named("mainWindowControls", { toggleDevTools() {} }),
    peekPendingFocusTarget: () => null,
    acknowledgeFocusTarget: () => {},
  };
  const runtimeBridge = new Proxy({}, { get: (_t, key) => `bridge:${String(key)}` });
  const dispose = registerBackendRpc({
    router,
    host,
    platform,
    mainCopy: (key) => key,
    getLocale: () => "en-US",
    runtimeBridge,
    services,
  });
  return { captured, services, router, platform, dispose };
}
