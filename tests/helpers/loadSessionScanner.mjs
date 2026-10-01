import { join } from "node:path";
import { loadTsCommonJs } from "./loadTsCommonJs.mjs";

/**
 * 统一加载生产 SessionScanner。相对 import 由 loadTsCommonJs 自动解析，
 * 这里只替换宿主边界：electron、共享日志，以及（可选）node:child_process。
 * 新增 SessionScanner 依赖时不需要再改任何测试。
 */
export function loadSessionScanner(homePath, options = {}) {
	const stubs = {
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
	return loadTsCommonJs("src/main/sessions/SessionScanner.ts", { stubs });
}
