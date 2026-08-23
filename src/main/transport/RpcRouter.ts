export type RpcHandler<
	TArgs extends unknown[] = unknown[],
	TResult = unknown,
> = (...args: TArgs) => TResult | Promise<TResult>;

export interface RpcRouter {
	handle<TArgs extends unknown[], TResult>(
		channel: string,
		handler: RpcHandler<TArgs, TResult>,
	): void;
}
