import type { RpcHandler, RpcRouter } from "./RpcRouter";

/** In-process RPC registry used by the native Node sidecar. */
export class NativeRpcRouter implements RpcRouter {
	private readonly handlers = new Map<string, RpcHandler>();

	handle<TArgs extends unknown[], TResult>(
		channel: string,
		handler: RpcHandler<TArgs, TResult>,
	): void {
		if (this.handlers.has(channel)) {
			throw new Error(`Duplicate RPC handler: ${channel}`);
		}
		this.handlers.set(channel, handler as RpcHandler);
	}

	async invoke<TResult = unknown>(channel: string, args: unknown[]): Promise<TResult> {
		const handler = this.handlers.get(channel);
		if (!handler) throw new Error(`Unknown RPC channel: ${channel}`);
		return (await handler(...args)) as TResult;
	}
}
