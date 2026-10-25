import { join } from "node:path";
import * as os from "node:os";
import { loadTsCommonJs } from "./loadTsCommonJs.mjs";

/**
 * 统一加载生产 SessionScanner。相对 import 由 loadTsCommonJs 自动解析，
 * 这里只替换宿主边界：electron、共享日志，以及（可选）node:child_process。
 * 新增 SessionScanner 依赖时不需要再改任何测试。
 */
export function loadSessionScanner(homePath, options = {}) {
	const stubs = {
		// Native Scanner/cache resolve homedir directly; an Electron-only stub leaked cache
		// fixtures into the real home and made repeated WSL tests spuriously warm.
		"node:os": { ...os, homedir: () => homePath },
		os: { ...os, homedir: () => homePath },
		electron: {
			app: { getPath: (key) => (key === "home" ? homePath : join(homePath, String(key))) },
			shell: { trashItem: async () => {} },
		},
		"../logging/sharedLogger": { getAppLogger: () => options.logger ?? null },
	};
	if (options.childProcess) {
		stubs["node:child_process"] = options.childProcess;
		stubs.child_process = options.childProcess;
	}
	// 其他需要替换的模块（例如 node:fs 的局部 override）；注意它们对所有被加载的模块都生效。
	Object.assign(stubs, options.stubs ?? {});
	const loaded = loadTsCommonJs("src/main/sessions/SessionScanner.ts", { stubs, globals: options.globals });
	const Base = loaded.SessionScanner;
	// 登记每个实例：摘要缓存按 800ms 防抖异步写盘，测试 rm 掉 home 之后它会用 mkdir -p 把
	// `.pi-desktop/` 重新建出来，在系统临时目录里留下垃圾。测试清理前先 flushLoadedScanners()。
	class TrackedSessionScanner extends Base {
		constructor(...args) {
			super(...args);
			trackedScanners.add(this);
		}
	}
	return { ...loaded, SessionScanner: TrackedSessionScanner };
}

const trackedScanners = new Set();

/** 把所有已创建 scanner 的待写摘要缓存立刻落盘并取消防抖计时器；清理临时 home 之前调用。 */
export async function flushLoadedScanners() {
	const scanners = [...trackedScanners];
	trackedScanners.clear();
	await Promise.all(scanners.map((scanner) => scanner.flushSummaryCache().catch(() => undefined)));
}
