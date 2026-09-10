import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { getAgentFromCatalog, type SubagentCatalog } from './subagentCatalog.ts';

const requireFromPackage = createRequire(import.meta.url);

export interface AstNode {
	type: string;
	[key: string]: unknown;
}

export interface WorkflowValidationResult {
	ok: boolean;
	reason?: string;
}

function getAcornParser(): { parse(source: string, options: Record<string, unknown>): unknown } {
	try {
		return requireFromPackage('acorn') as { parse(source: string, options: Record<string, unknown>): unknown };
	} catch (primaryError) {
		try {
			const manifestPath = requireFromPackage.resolve('acorn/package.json');
			const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { main?: unknown };
			const entry = typeof manifest.main === 'string' && manifest.main ? manifest.main : './dist/acorn.js';
			return requireFromPackage(resolvePath(dirname(manifestPath), entry)) as { parse(source: string, options: Record<string, unknown>): unknown };
		} catch {
			throw primaryError;
		}
	}
}

function astNode(value: unknown): value is AstNode {
	return Boolean(value && typeof value === 'object' && typeof (value as AstNode).type === 'string');
}

function walkAstWithParents(
	node: unknown,
	visit: (node: AstNode, parents: AstNode[]) => void,
	parents: AstNode[] = [],
): void {
	if (Array.isArray(node)) {
		for (const item of node) walkAstWithParents(item, visit, parents);
		return;
	}
	if (!astNode(node)) return;
	visit(node, parents);
	const nextParents = [node, ...parents];
	for (const [key, child] of Object.entries(node)) {
		if (key !== 'loc' && key !== 'range') walkAstWithParents(child, visit, nextParents);
	}
}

/** Fail-closed check ensuring an object literal has only static, uncomputed, unique keys without spread elements. */
export function inspectStaticObject(obj: AstNode): { ok: boolean; reason?: string } {
	if (obj.type !== 'ObjectExpression' || !Array.isArray(obj.properties)) {
		return {
			ok: false,
			reason: '[change-pi-prompt] standalone Pi 环境下子代理调用参数必须为对象字面量。',
		};
	}

	const seenKeys = new Set<string>();

	for (const prop of obj.properties) {
		if (!prop || typeof prop !== 'object') continue;
		const p = prop as AstNode;

		if (p.type === 'SpreadElement' || p.type === 'ExperimentalSpreadProperty') {
			return {
				ok: false,
				reason: '[change-pi-prompt] standalone Pi 环境下子代理参数不支持对象展开运算符（SpreadElement），必须显式声明静态属性。',
			};
		}

		if (p.type !== 'Property') {
			return {
				ok: false,
				reason: '[change-pi-prompt] standalone Pi 环境下子代理参数必须为常规对象属性。',
			};
		}

		if (p.computed === true) {
			return {
				ok: false,
				reason: '[change-pi-prompt] standalone Pi 环境下子代理参数不支持计算属性（computed property），必须显式声明静态属性。',
			};
		}

		const key = p.key as AstNode | undefined;
		let keyName: string | undefined;
		if (key) {
			if (key.type === 'Identifier' && typeof key.name === 'string') {
				keyName = key.name;
			} else if (key.type === 'Literal' && typeof key.value === 'string') {
				keyName = key.value;
			}
		}

		if (typeof keyName !== 'string') {
			return {
				ok: false,
				reason: '[change-pi-prompt] standalone Pi 环境下子代理参数键必须为静态标识符或字符串字面量。',
			};
		}

		if (seenKeys.has(keyName)) {
			return {
				ok: false,
				reason: `[change-pi-prompt] standalone Pi 环境下子代理参数存在重复静态键 "${keyName}"，必须唯一。`,
			};
		}
		seenKeys.add(keyName);
	}

	return { ok: true };
}

/** Retrieve property value from an object that has passed inspectStaticObject. */
function getProperty(obj: AstNode, name: string): AstNode | undefined {
	if (obj.type !== 'ObjectExpression' || !Array.isArray(obj.properties)) return undefined;
	for (const prop of obj.properties) {
		if (prop && typeof prop === 'object' && (prop as AstNode).type === 'Property') {
			const p = prop as AstNode;
			const key = p.key as AstNode | undefined;
			if (!key || p.computed) continue;
			if (key.type === 'Identifier' && key.name === name) return p.value as AstNode;
			if (key.type === 'Literal' && key.value === name) return p.value as AstNode;
		}
	}
	return undefined;
}

const ALLOWED_DIRECT_RUNS_METHODS = new Set([
	'run',
	'all',
	'lanes',
	'host',
	'steer',
	'status',
	'ref',
	'refs',
]);

function directRunsCall(node: AstNode, method: string): boolean {
	if (node.type !== 'CallExpression') return false;
	const callee = node.callee as AstNode | undefined;
	if (!astNode(callee) || callee.type !== 'MemberExpression') return false;
	if (callee.computed === true) return false;
	const obj = callee.object as AstNode | undefined;
	if (!astNode(obj) || obj.type !== 'Identifier' || obj.name !== 'runs') return false;
	const prop = callee.property as AstNode | undefined;
	if (!astNode(prop) || prop.type !== 'Identifier') return false;
	return prop.name === method;
}

/** Bounded AST parser for standalone workflowScript execution.
 *  Enforces that all native child launches explicitly declare async:false.
 *  Fails closed on spread elements, non-literal arrays, computed properties,
 *  duplicate keys, runs method aliasing/destructuring, or unknown agents. */
export function validateStandaloneWorkflowScript(
	script: string,
	catalog?: SubagentCatalog,
): WorkflowValidationResult {
	let root: AstNode;
	try {
		const parser = getAcornParser();
		root = parser.parse(`(async () => {\n${script}\n})()`, {
			ecmaVersion: 'latest',
			sourceType: 'script',
			locations: true,
		}) as AstNode;
	} catch (error) {
		return {
			ok: false,
			reason: `[change-pi-prompt] workflowScript 语法校验失败：${error instanceof Error ? error.message : String(error)}`,
		};
	}

	const childConfigs: AstNode[] = [];
	let structureError: string | undefined;

	walkAstWithParents(root, (node, parents) => {
		if (structureError) return;

		// 0. 禁止通过 globalThis.runs 或 this.runs 间接引用
		if (node.type === 'MemberExpression') {
			const obj = node.object as AstNode | undefined;
			if (obj) {
				const isGlobalThis = obj.type === 'Identifier' && obj.name === 'globalThis';
				const isThis = obj.type === 'ThisExpression';
				if (isGlobalThis || isThis) {
					const prop = node.property as AstNode | undefined;
					const isRunsProp = prop && (
						(!node.computed && prop.type === 'Identifier' && prop.name === 'runs')
						|| (node.computed && prop.type === 'Literal' && prop.value === 'runs')
					);
					if (isRunsProp) {
						structureError = 'standalone Pi 环境下禁止通过 globalThis/this 间接访问 runs；必须直接使用 runs.<method>(...)。';
						return;
					}
				}
			}
		}

		// 1. 严格限制 runs 全局变量的使用：只能以 runs.<method>(...) 直接调用
		if (node.type === 'Identifier' && node.name === 'runs') {
			const parent = parents[0];
			const grandParent = parents[1];

			// 排除对象字面量键 { runs: 123 }
			if (parent && parent.type === 'Property' && parent.key === node && !parent.computed) {
				return;
			}
			// 排除其他对象属性访问 obj.runs
			if (parent && parent.type === 'MemberExpression' && parent.property === node && !parent.computed) {
				return;
			}

			if (
				!parent
				|| parent.type !== 'MemberExpression'
				|| parent.object !== node
				|| parent.computed === true
				|| !parent.property
				|| (parent.property as AstNode).type !== 'Identifier'
			) {
				structureError = 'standalone Pi 环境下 runs 只能用于直接方法调用（如 runs.run(...)），禁止解构、赋值或取引用';
				return;
			}

			const methodName = ((parent.property as AstNode).name as string) ?? '';
			if (!ALLOWED_DIRECT_RUNS_METHODS.has(methodName)) {
				structureError = `standalone Pi 环境下不支持 runs.${methodName} 方法调用`;
				return;
			}

			if (
				!grandParent
				|| grandParent.type !== 'CallExpression'
				|| grandParent.callee !== parent
			) {
				structureError = `standalone Pi 环境下 runs.${methodName} 必须直接调用，禁止赋值、取引用、使用 .call/.apply 或间接调用`;
				return;
			}
		}

		// 2. 识别并收集 runs.run / runs.all / runs.lanes 子代理配置
		if (directRunsCall(node, 'run')) {
			const args = Array.isArray(node.arguments) ? (node.arguments as AstNode[]) : [];
			const paramsArg = args[1];
			if (!paramsArg || paramsArg.type !== 'ObjectExpression') {
				structureError = 'runs.run 子代理参数必须为对象字面量以供静态前台策略校验';
			} else {
				const safety = inspectStaticObject(paramsArg);
				if (!safety.ok) {
					structureError = safety.reason;
				} else {
					childConfigs.push(paramsArg);
				}
			}
		} else if (directRunsCall(node, 'all')) {
			const args = Array.isArray(node.arguments) ? (node.arguments as AstNode[]) : [];
			const arrayArg = args[0];
			if (!arrayArg || arrayArg.type !== 'ArrayExpression' || !Array.isArray(arrayArg.elements)) {
				structureError = 'runs.all 必须传入字面量数组以供静态前台策略校验';
			} else {
				for (const elem of arrayArg.elements) {
					if (!elem || (elem as AstNode).type !== 'ObjectExpression') {
						structureError = 'runs.all 每个项必须为对象字面量以供静态前台策略校验';
						break;
					}
					const safety = inspectStaticObject(elem as AstNode);
					if (!safety.ok) {
						structureError = safety.reason;
						break;
					}
					childConfigs.push(elem as AstNode);
				}
			}
		} else if (directRunsCall(node, 'lanes')) {
			const args = Array.isArray(node.arguments) ? (node.arguments as AstNode[]) : [];
			const arrayArg = args[0];
			if (!arrayArg || arrayArg.type !== 'ArrayExpression' || !Array.isArray(arrayArg.elements)) {
				structureError = 'runs.lanes 必须传入字面量数组以供静态前台策略校验';
			} else {
				for (const lane of arrayArg.elements) {
					if (!lane || (lane as AstNode).type !== 'ObjectExpression') {
						structureError = 'runs.lanes 每个 lane 必须为对象字面量以供静态前台策略校验';
						break;
					}
					const laneSafety = inspectStaticObject(lane as AstNode);
					if (!laneSafety.ok) {
						structureError = laneSafety.reason;
						break;
					}
					const stages = getProperty(lane as AstNode, 'stages');
					if (!stages || stages.type !== 'ArrayExpression' || !Array.isArray(stages.elements)) {
						structureError = 'runs.lanes stages 必须传入字面量数组以供静态前台策略校验';
						break;
					}
					for (const stage of stages.elements) {
						if (!stage || (stage as AstNode).type !== 'ObjectExpression') {
							structureError = 'runs.lanes stage 必须为对象字面量以供静态前台策略校验';
							break;
						}
						const stageSafety = inspectStaticObject(stage as AstNode);
						if (!stageSafety.ok) {
							structureError = stageSafety.reason;
							break;
						}
						const hasResume = Boolean(getProperty(stage as AstNode, 'resume'));
						const hasAgent = Boolean(getProperty(stage as AstNode, 'agent'));
						if (hasResume && !hasAgent) {
							const resumeVal = getProperty(stage as AstNode, 'resume')!;
							if (resumeVal.type !== 'Literal' || typeof resumeVal.value !== 'string') {
								structureError = 'runs.lanes stage 的 resume 属性必须为静态字符串字面量';
								break;
							}
							continue;
						}
						childConfigs.push(stage as AstNode);
					}
					if (structureError) break;
				}
			}
		}
	});

	if (structureError) {
		return {
			ok: false,
			reason: `[change-pi-prompt] standalone Pi 环境校验失败：${structureError}。`,
		};
	}

	// 3. 对每个子代理配置进行前台策略与 Agent Runner 类型校验
	for (const cfg of childConfigs) {
		// 检查 agent
		const agentVal = getProperty(cfg, 'agent');
		if (!agentVal) {
			return {
				ok: false,
				reason: '[change-pi-prompt] standalone Pi 环境下子代理调用必须声明 agent。',
			};
		}

		if (agentVal.type !== 'Literal' || typeof agentVal.value !== 'string') {
			return {
				ok: false,
				reason: '[change-pi-prompt] agent 必须为静态字符串，才能验证 native/external runner 类型。',
			};
		}

		const agentName = agentVal.value.trim();
		if (!catalog) {
			return {
				ok: false,
				reason: `[change-pi-prompt] 无法获取 agent catalog，无法在 standalone Pi 环境下验证 agent "${agentName}" 的 runner 类型。`,
			};
		}

		const entry = getAgentFromCatalog(catalog, agentName);
		if (!entry) {
			return {
				ok: false,
				reason: `[change-pi-prompt] 未知的子代理 "${agentName}"，不在 catalog 中，无法验证 runner 类型。`,
			};
		}

		if (entry.runnerType !== 'native') {
			return {
				ok: false,
				reason: `[change-pi-prompt] Agent "${agentName}" 使用 external runner (${entry.runnerType})，只支持 async/background，当前 standalone Pi 环境不可在 workflowScript 中执行。`,
			};
		}

		// 检查 native child 的 async 属性：必须显式声明字面量 false
		const asyncVal = getProperty(cfg, 'async');
		if (!asyncVal) {
			return {
				ok: false,
				reason: '[change-pi-prompt] standalone Pi 环境下 workflowScript 中的每个 native child 调用都必须显式声明 async:false（发现未声明 async:false 的子代理调用）。',
			};
		}

		if (asyncVal.type === 'Literal' && asyncVal.value === true) {
			return {
				ok: false,
				reason: '[change-pi-prompt] standalone Pi 环境不支持在 workflowScript 内部调用中使用 async:true。请移除 async:true 或改为 async:false。',
			};
		}

		if (asyncVal.type === 'Literal' && asyncVal.value === false) {
			continue;
		}

		return {
			ok: false,
			reason: '[change-pi-prompt] standalone Pi 环境下 workflowScript 中的子代理 async 属性必须为显式字面量 false。',
		};
	}

	return { ok: true };
}
