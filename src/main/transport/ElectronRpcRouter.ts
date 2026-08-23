import type { IpcMain } from "electron";
import type { RpcHandler, RpcRouter } from "./RpcRouter";

export class ElectronRpcRouter implements RpcRouter {
	private readonly ipc: IpcMain;

	constructor(ipc: IpcMain) {
		this.ipc = ipc;
	}

	handle<TArgs extends unknown[], TResult>(
		channel: string,
		handler: RpcHandler<TArgs, TResult>,
	): void {
		this.ipc.handle(channel, (_event, ...args: TArgs) => handler(...args));
	}
}
