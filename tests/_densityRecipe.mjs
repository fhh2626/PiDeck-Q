import { readFileSync } from "node:fs";

/**
 * 读取 src/renderer/src/lib/density.ts 中某个共享视觉 recipe 常量的字面量。
 * recipe 是 Native/Web 共用表面的唯一真源；测试通过它断言「值」，
 * 再通过各组件文件断言「消费了该 recipe」，从而避免把像素值锁死在组件里。
 *
 * @param {string} name - 导出常量名，如 "USER_TURN_BUBBLE"
 * @returns {string} 该常量的 class 字符串
 */
export function getRecipe(name) {
	const src = readFileSync("src/renderer/src/lib/density.ts", "utf8");
	// recipe 可能写成单行 `= "..."` 或多行 `=\n\t"..."`，两种都兼容。
	const re = new RegExp(`export const ${name}\\s*=\\s*\\n?\\t?"([^"]*)"`);
	const match = src.match(re);
	if (!match) throw new Error(`recipe ${name} not found in lib/density.ts`);
	return match[1];
}

/** 断言某组件文件 import 并使用了给定 recipe 常量（防「样式分叉」回归）。 */
export function assertConsumes(componentSource, recipeName) {
	const imported = new RegExp(`import \\{[^}]*\\b${recipeName}\\b[^}]*\\} from "@\\/lib/density"`);
	if (!imported.test(componentSource)) {
		throw new Error(`component does not import ${recipeName} from lib/density`);
	}
	// 使用处：className 里以 {RECIPE} 或 `${RECIPE}` 形式出现。
	const used = new RegExp(`(\\{${recipeName}\\}|\\$\\{${recipeName}\\})`);
	if (!used.test(componentSource)) {
		throw new Error(`component imports ${recipeName} but never renders it`);
	}
}
