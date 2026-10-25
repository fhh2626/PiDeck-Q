import { loadTsCommonJs } from "./loadTsCommonJs.mjs";

/** 本机 node_modules/electron 未必有二进制：真实 require 会触发下载，一律 stub。 */
const ELECTRON_STUB = { app: {}, Notification: class {} };

export const BASE_PLATFORM_DEPS = {
	appName: "PiDeck",
	appPath: "/app",
	resourcesPath: "/res",
	isPackaged: true,
	notifications: { isSupported: () => false, show: () => undefined },
	focusSessionFromNotification: () => false,
};

/**
 * 装载 AgentManager，并把 PiProcess 换成可记录的替身。
 *
 * - `log` 按时间顺序记录替身上发生的事件（construct / on:<event> / start / stop），
 *   用来断言「先挂监听再 start」「屏障放行后才构造」这类顺序契约。
 * - `constructed` 保存每次构造收到的 (cwd, settings, locator, options)，
 *   用来断言 AgentManager 注入给 PiProcess 的依赖是否真的接通。
 * - `startImpl(sessionPath, trustOverride, noSession)` 可定制 start 行为（抛错 / 挂起）。
 */
export function loadAgentManagerWithFakePi({ startImpl, diagnostics = null, globals } = {}) {
	const log = [];
	const constructed = [];
	const client = { request: async () => ({ success: true, data: {} }) };
	class FakePiProcess {
		constructor(cwd, settings, locator, options) {
			constructed.push({ cwd, settings, locator, options, instance: this });
			log.push("construct");
			this.client = client;
		}
		on(event) {
			log.push(`on:${event}`);
			return this;
		}
		async start(sessionPath, trustOverride, noSession) {
			log.push("start");
			if (startImpl) return startImpl(sessionPath, trustOverride, noSession);
			return client;
		}
		stop() {
			log.push("stop");
		}
		isRunning() {
			return true;
		}
		getDiagnostics() {
			return diagnostics;
		}
	}
	const loaded = loadTsCommonJs("src/main/pi/AgentManager.ts", {
		stubs: { electron: ELECTRON_STUB, "./PiProcess": { PiProcess: FakePiProcess } },
		globals,
	});
	return { ...loaded, log, constructed, client };
}

/**
 * 位置参数顺序与 createBackend 装配一致（见 AgentManager 构造函数）。
 * 只暴露测试关心的几项，其余保持缺省。
 */
export function createFakePiManager(harness, {
	platformDeps,
	appLogger,
	repairSessionFile,
	onBeforeAgentSpawn,
	sendToRenderer = () => undefined,
	project = { id: "p1", name: "Project", path: "/proj" },
} = {}) {
	return new harness.AgentManager(
		(id) => (id === project.id ? project : undefined),
		sendToRenderer,
		{ get: () => ({}) },
		// 干净项目路径只需要 ensureTrustedDirectory
		{ ensureTrustedDirectory: async () => undefined },
		undefined,
		appLogger,
		undefined,
		undefined,
		onBeforeAgentSpawn,
		undefined,
		repairSessionFile,
		undefined,
		platformDeps,
	);
}

/** 让出若干轮微任务/宏任务，使被 await 的异步链推进到下一个真正挂起点。 */
export async function settle(rounds = 5) {
	for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}
