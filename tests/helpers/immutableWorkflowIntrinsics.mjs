import vm from "node:vm";
import v8 from "node:v8";
import { isMainThread } from "node:worker_threads";

/** Emulate Pi-Bolt's immutable Promise methods only in isolated workflow workers. */
function fixPromiseMethods(constructor) {
	for (const target of [constructor, constructor.prototype]) {
		for (const key of Reflect.ownKeys(target)) {
			const descriptor = Object.getOwnPropertyDescriptor(target, key);
			if (typeof descriptor?.value === "function") {
				Object.defineProperty(target, key, { ...descriptor, writable: false, configurable: false });
			}
		}
	}
}

if (!isMainThread) {
	if (process.env.PIDECK_TEST_PROMISE_MODE.includes("immutable")) {
		fixPromiseMethods(Promise);
		const createContext = vm.createContext;
		vm.createContext = function (...args) {
			const context = Reflect.apply(createContext, vm, args);
			// Async functions use the realm intrinsic even when its global Promise is a facade.
			fixPromiseMethods(vm.runInContext("(async () => {})().constructor", context));
			return context;
		};
	}
	if (process.env.PIDECK_TEST_PROMISE_MODE.includes("nohooks")) {
		v8.promiseHooks.createHook = () => {
			const error = new Error("Promise hooks are not available in this runtime");
			error.name = "NotImplementedError";
			throw error;
		};
	}
}
