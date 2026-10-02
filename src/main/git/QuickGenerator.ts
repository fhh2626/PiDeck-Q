import { spawn, type ChildProcess } from "node:child_process";
import { PiRpcClient } from "../pi/PiRpcClient";
import type { PiLocator } from "../pi/PiLocator";
import type { SettingsStore } from "../settings/SettingsStore";
import type { AppLogger } from "../logging/AppLogger";

interface QuickGeneratorDeps {
	piLocator: PiLocator;
	settingsStore: SettingsStore;
	appLogger: Pick<AppLogger, "warn">;
}

/** Owns one backend's lightweight Pi process, requests, and paired disposal. */
export function createQuickGenerator({ piLocator, settingsStore, appLogger }: QuickGeneratorDeps) {
	let genProcess: ChildProcess | null = null;
	let genRpcClient: PiRpcClient | null = null;
	let genModelKey = "";
	let genIdleTimer: NodeJS.Timeout | null = null;
	let genBusy = false;
	let disposed = false;
	let rejectGeneration: ((error: Error) => void) | undefined;

	/** Clear ownership before killing: late events must not affect a replacement process. */
	function stopGenProcess(error = new Error("QuickGen process stopped")) {
		if (genIdleTimer) clearTimeout(genIdleTimer);
		genIdleTimer = null;
		const child = genProcess;
		const rpc = genRpcClient;
		genProcess = null;
		genRpcClient = null;
		genModelKey = "";
		rejectGeneration?.(error);
		rpc?.close(error);
		if (child && child.exitCode === null) {
			try { child.kill(); } catch { /* Already exited or could not be signalled. */ }
		}
	}

	/** Idle reuse is bounded; an active generation never owns an idle timer. */
	function resetGenIdleTimer() {
		if (genIdleTimer) clearTimeout(genIdleTimer);
		genIdleTimer = setTimeout(() => stopGenProcess(), 30 * 60_000);
		genIdleTimer.unref();
	}

	/** Select a model only after process event handlers own all startup failures. */
	async function ensureGenProcess(projectPath: string, model: { provider: string; modelId: string }): Promise<PiRpcClient> {
		const modelKey = `${model.provider}\0${model.modelId}`;
		// provider/model 变化时必须重启轻量进程，不能沿用旧模型的状态。
		if (genProcess && genRpcClient && genProcess.exitCode === null && genModelKey === modelKey) {
			return genRpcClient;
		}
		stopGenProcess();
		const settings = settingsStore.get();
		const command = piLocator.resolveCommand(
			settings.customPiPath, settings.wslEnabled, settings.wslDistro, settings.wslUser,
			settings.piRuntimePreference, settings.piTypescriptPath, settings.piRustPath,
		);
		const invocation = piLocator.createInvocation(command, [
			"--mode", "rpc", "--no-session", "--no-tools", "--no-extensions", "--no-skills",
			"--no-prompt-templates", "--no-themes", "--thinking", "off",
		]);
		const childProcess = spawn(invocation.command, invocation.args, {
			cwd: projectPath,
			env: piLocator.createProcessEnv(settings, invocation.pathPrefix, invocation.wsl),
			stdio: ["pipe", "pipe", "pipe"], shell: invocation.shell,
			windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments,
		});
		genProcess = childProcess;
		const onError = (error: Error) => {
			if (genProcess === childProcess) stopGenProcess(error);
		};
		const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
			if (genProcess === childProcess) stopGenProcess(new Error(`QuickGen exited (${code ?? signal})`));
		};
		const onStderr = (chunk: Buffer) => {
			// Consume stderr from startup onward without logging prompts, paths, or credentials.
			void appLogger.warn("git", "QuickGen stderr", { bytes: chunk.length });
		};
		// Register before the first RPC await: spawn errors and early exits are asynchronous
		// events, not exceptions that the handler's try/catch can intercept by itself.
		childProcess.on("error", onError);
		childProcess.on("exit", onExit);
		childProcess.stdin?.on("error", onError);
		childProcess.stdout?.on("error", onError);
		childProcess.stderr?.on("error", onError);
		childProcess.stderr?.on("data", onStderr);
		childProcess.once("close", () => {
			onExit(childProcess.exitCode, childProcess.signalCode);
			childProcess.off("error", onError);
			childProcess.off("exit", onExit);
			childProcess.stdin?.off("error", onError);
			childProcess.stdout?.off("error", onError);
			childProcess.stderr?.off("error", onError);
			childProcess.stderr?.off("data", onStderr);
		});

		try {
			if (!childProcess.stdin || !childProcess.stdout) throw new Error("QuickGen RPC pipes unavailable");
			const rpc = new PiRpcClient(childProcess.stdin, childProcess.stdout);
			genRpcClient = rpc;
			const response = await rpc.request({ type: "set_model", provider: model.provider, modelId: model.modelId });
			if (!response.success) throw new Error(response.error ?? "Unable to select QuickGen model");
			if (genProcess !== childProcess || disposed) throw new Error("QuickGen process stopped during startup");
			genModelKey = modelKey;
			return rpc;
		} catch (error) {
			if (genProcess === childProcess) stopGenProcess();
			throw error;
		}
	}

	/** Generate via stdio only; Pi remains responsible for model and agent behavior. */
	async function generate(projectPath: string, prompt: string, model: { provider: string; modelId: string }): Promise<string> {
		if (disposed) throw new Error("QuickGen is disposed");
		if (genBusy) throw new Error("Agent is already processing");
		genBusy = true;
		if (genIdleTimer) clearTimeout(genIdleTimer);
		genIdleTimer = null;
		try {
			const rpc = await ensureGenProcess(projectPath, model);
			return await new Promise<string>((resolve, reject) => {
				const collected: string[] = [];
				let settled = false;
				const finish = (error?: Error) => {
					if (settled) return;
					settled = true;
					clearTimeout(timeout);
					rpc.off("event", onEvent);
					rejectGeneration = undefined;
					if (error) reject(error);
					else resolve(collected.join(""));
				};
				const onEvent = (event: Record<string, unknown>) => {
					if (event.type === "message_update") {
						const update = event.assistantMessageEvent;
						if (update && typeof update === "object" && "type" in update && update.type === "text_delta" && "delta" in update && typeof update.delta === "string") {
							collected.push(update.delta);
						}
					}
					if (event.type === "agent_settled" || event.type === "agent_end") finish();
				};
				const timeout = setTimeout(() => {
					const error = new Error("Quick generate timed out");
					finish(error);
					stopGenProcess(error);
				}, 60_000);
				rejectGeneration = finish;
				rpc.on("event", onEvent);
				rpc.request({ type: "prompt", message: prompt }).then(response => {
					if (!response.success) finish(new Error(response.error ?? "Prompt rejected"));
				}).catch(error => {
					const failure = error instanceof Error ? error : new Error(String(error));
					finish(failure);
					// A lost prompt acknowledgement has an uncertain result. Never reuse
					// the process while that previous generation may still be running.
					if (genRpcClient === rpc) stopGenProcess(failure);
				});
			});
		} finally {
			genBusy = false;
			if (!disposed && genProcess) resetGenIdleTimer();
		}
	}

	return {
		generate,
		/** Reject active work and stop resources when the owning backend shuts down. */
		dispose() {
			if (disposed) return;
			disposed = true;
			stopGenProcess(new Error("QuickGen is disposed"));
		},
	};
}
