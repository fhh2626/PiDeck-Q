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

function walkAst(node: unknown, visit: (node: AstNode) => void): void {
	if (Array.isArray(node)) {
		for (const item of node) walkAst(item, visit);
		return;
	}
	if (!astNode(node)) return;
	visit(node);
	for (const [key, child] of Object.entries(node)) {
		if (key !== 'loc' && key !== 'range') walkAst(child, visit);
	}
}

function directRunsCall(node: AstNode, method: 'run' | 'all' | 'lanes'): boolean {
	if (node.type !== 'CallExpression') return false;
	const callee = node.callee as AstNode | undefined;
	if (!astNode(callee) || callee.type !== 'MemberExpression') return false;
	const obj = callee.object as AstNode | undefined;
	if (!astNode(obj) || obj.type !== 'Identifier' || obj.name !== 'runs') return false;
	const prop = callee.property as AstNode | undefined;
	if (!astNode(prop)) return false;
	if (callee.computed === true) {
		return prop.type === 'Literal' && prop.value === method;
	}
	return prop.type === 'Identifier' && prop.name === method;
}

function getProperty(obj: AstNode, name: string): AstNode | undefined {
	if (obj.type !== 'ObjectExpression' || !Array.isArray(obj.properties)) return undefined;
	for (const prop of obj.properties) {
		if (prop && typeof prop === 'object' && prop.type === 'Property') {
			const key = prop.key as AstNode | undefined;
			if (!key) continue;
			if (prop.computed) {
				if (key.type === 'Literal' && key.value === name) return prop.value as AstNode;
			} else {
				if (key.type === 'Identifier' && key.name === name) return prop.value as AstNode;
				if (key.type === 'Literal' && key.value === name) return prop.value as AstNode;
			}
		}
	}
	return undefined;
}

/** Bounded AST parser for standalone workflowScript execution.
 *  Enforces that all native child launches explicitly declare async:false. */
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

	// 1. 全局检查：AST 中是否有任何 async: true 属性
	let hasAsyncTrue = false;
	walkAst(root, (node) => {
		if (node.type === 'Property') {
			const key = node.key as AstNode | undefined;
			const isAsyncKey = key && (
				(node.computed ? (key.type === 'Literal' && key.value === 'async') : (key.type === 'Identifier' && key.name === 'async'))
				|| (key.type === 'Literal' && key.value === 'async')
			);
			if (isAsyncKey) {
				const val = node.value as AstNode | undefined;
				if (val && val.type === 'Literal' && val.value === true) {
					hasAsyncTrue = true;
				}
			}
		}
	});

	if (hasAsyncTrue) {
		return {
			ok: false,
			reason: '[change-pi-prompt] standalone Pi 环境不支持在 workflowScript 内部调用中使用 async:true。请移除 async:true 或改为 async:false。',
		};
	}

	// 2. 收集所有子代理调用的配置对象
	const childConfigs: AstNode[] = [];
	let structureError: string | undefined;

	walkAst(root, (node) => {
		if (directRunsCall(node, 'run')) {
			const args = Array.isArray(node.arguments) ? (node.arguments as AstNode[]) : [];
			if (args[1]) {
				childConfigs.push(args[1]);
			} else {
				structureError = 'runs.run 缺少子代理参数对象';
			}
		} else if (directRunsCall(node, 'all')) {
			const args = Array.isArray(node.arguments) ? (node.arguments as AstNode[]) : [];
			const arrayArg = args[0];
			if (arrayArg && arrayArg.type === 'ArrayExpression' && Array.isArray(arrayArg.elements)) {
				for (const elem of arrayArg.elements) {
					if (elem) childConfigs.push(elem as AstNode);
				}
			} else {
				structureError = 'runs.all 必须传入字面量数组以供静态前台策略校验';
			}
		} else if (directRunsCall(node, 'lanes')) {
			const args = Array.isArray(node.arguments) ? (node.arguments as AstNode[]) : [];
			const arrayArg = args[0];
			if (arrayArg && arrayArg.type === 'ArrayExpression' && Array.isArray(arrayArg.elements)) {
				for (const lane of arrayArg.elements) {
					if (lane && lane.type === 'ObjectExpression') {
						const stages = getProperty(lane as AstNode, 'stages');
						if (stages && stages.type === 'ArrayExpression' && Array.isArray(stages.elements)) {
							for (const stage of stages.elements) {
								if (stage && stage.type === 'ObjectExpression') {
									if (getProperty(stage as AstNode, 'agent')) {
										childConfigs.push(stage as AstNode);
									}
								}
							}
						}
					}
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

	// 3. 对每个 childConfig 进行校验
	for (const cfg of childConfigs) {
		if (cfg.type !== 'ObjectExpression' || !Array.isArray(cfg.properties)) {
			return {
				ok: false,
				reason: '[change-pi-prompt] standalone Pi 环境下子代理调用参数必须为对象字面量，且必须显式声明 async:false。',
			};
		}

		// 检查 agent 类型
		const agentVal = getProperty(cfg, 'agent');
		let isExternal = false;
		let agentName: string | undefined;
		if (agentVal && agentVal.type === 'Literal' && typeof agentVal.value === 'string') {
			agentName = agentVal.value;
			if (catalog) {
				const entry = getAgentFromCatalog(catalog, agentName);
				if (entry?.runnerType === 'external-cli' || entry?.runnerType === 'external-job') {
					isExternal = true;
				}
			}
		}

		if (isExternal) {
			return {
				ok: false,
				reason: `[change-pi-prompt] Agent "${agentName}" 使用 external runner，只支持 async/background，当前 standalone Pi 环境不可在 workflowScript 中执行。`,
			};
		}

		// native child: 必须明确具有 async: false
		const asyncVal = getProperty(cfg, 'async');
		if (!asyncVal) {
			return {
				ok: false,
				reason: '[change-pi-prompt] standalone Pi 环境下 workflowScript 中的每个 native child 调用都必须显式声明 async:false（发现未声明 async:false 的子代理调用）。',
			};
		}

		if (asyncVal.type === 'Literal' && asyncVal.value === false) {
			continue;
		}

		if (asyncVal.type === 'Literal' && asyncVal.value === true) {
			return {
				ok: false,
				reason: '[change-pi-prompt] standalone Pi 环境不支持在 workflowScript 内部调用中使用 async:true。请移除 async:true 或改为 async:false。',
			};
		}

		return {
			ok: false,
			reason: '[change-pi-prompt] standalone Pi 环境下 workflowScript 中的子代理 async 属性必须为显式字面量 false。',
		};
	}

	return { ok: true };
}
