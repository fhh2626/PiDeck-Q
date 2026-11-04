import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

/**
 * 万能惰性替身：任意属性读取/调用都返回自身。
 * 用来替换 React/jotai/desktopApi 等与被测纯函数无关的依赖，让大型 hook 模块能被装载。
 */
function createInertStub() {
	const target = function inert() {};
	const stub = new Proxy(target, {
		get: (_t, prop) => (prop === Symbol.toPrimitive ? () => "" : stub),
		apply: () => stub,
		construct: () => stub,
	});
	return stub;
}

/**
 * 装载一个 TS 模块并取出其“未导出”的内部函数做行为测试。
 *
 * 适用于：函数是模块私有的纯策略（例如 hook 文件里的错误文案映射），
 * 而生产代码不应仅为测试而改成 export。做法是转译源码后在模块尾部追加一行
 * 导出，再让所有 import 走替身；被测函数体本身仍是生产代码原样执行。
 *
 * @param {string} filePath 源文件
 * @param {string[]} names 需要取出的模块内标识符
 * @param {Record<string, unknown>} stubs 按 import 说明符指定的真实替身（其余自动用惰性替身）
 */
export function loadModuleInternals(filePath, names, stubs = {}) {
	const source = readFileSync(filePath, "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			jsx: ts.JsxEmit.ReactJSX,
		},
		fileName: filePath,
	});
	const module = { exports: {} };
	const inert = createInertStub();
	const sandbox = {
		module,
		exports: module.exports,
		require: (specifier) => (Object.hasOwn(stubs, specifier) ? stubs[specifier] : inert),
		console,
		process,
	};
	vm.runInNewContext(
		`${outputText}\n;module.exports.__internals = { ${names.join(", ")} };`,
		sandbox,
		{ filename: filePath },
	);
	return module.exports.__internals;
}
