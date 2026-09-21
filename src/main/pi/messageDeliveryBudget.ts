import type { ChatMessage, SessionMessagePage } from "../../shared/types/session";

/** 单批消息下发信封总预算（留出安全余量给 32 MiB 原生帧）：30 MiB */
export const MAX_MESSAGE_DELIVERY_ENVELOPE_BYTES = 30 * 1024 * 1024;

export type DeliveryBudgetResult<T> =
	| { ok: true; value: T }
	// 失败时仍带回「尽力处理后的最后 candidate」（如已剥光图片的 payload），
	// 供调用方决定是否走 listener 拒绝路径而不是直接丢弃。
	| { ok: false; code: "MESSAGE_DELIVERY_TOO_LARGE" | "SERIALIZATION_FAILED"; value?: T };

export type DeliveryPayloadWithMessages = {
	messages: ChatMessage[];
	slideOut?: ChatMessage[];
	[key: string]: unknown;
};

/**
 * 移除工具结果在 ChatMessage.meta 里的冗余副本（即 meta.result / partialResult / output）。
 * 工具结果在 ChatMessage.text 里已经有了紧凑纯文本，meta 里的原始大对象只用于主进程查看全文。
 * 发给渲染层或下发信封前必须剔除，避免重复膨胀。
 */
export function stripToolResultForDelivery(messages: ChatMessage[]): ChatMessage[] {
	let changed = false;
	const stripped = messages.map((m) => {
		if (m.role !== "tool" || !m.meta) return m;
		if (
			m.meta.result === undefined &&
			m.meta.partialResult === undefined &&
			m.meta.output === undefined
		) {
			return m;
		}
		changed = true;
		const nextMeta = { ...m.meta };
		delete nextMeta.result;
		delete nextMeta.partialResult;
		delete nextMeta.output;
		return { ...m, meta: nextMeta };
	});
	return changed ? stripped : messages;
}

/**
 * 计算任意对象的完整 UTF-8 JSON 序列化字节数。
 * 若序列化失败抛出异常，返回 null 标记失败（不得返回 0）。
 */
export function measureUtf8JsonBytes(target: unknown): number | null {
	try {
		const json = JSON.stringify(target);
		if (typeof json !== "string") return null;
		return Buffer.byteLength(json, "utf8");
	} catch {
		return null;
	}
}

/**
 * 完整信封预算保护（纯函数，Copy-on-Write）：
 * buildWrapper: 接收当前的 payload，构建将要发送给传输层的完整外层对象。
 * 1. 深度拷贝 messages 和 slideOut，并执行 stripToolResultForDelivery。
 * 2. 测量完整外层对象的 UTF-8 字节数。
 * 3. 若超限，按 slideOut (旧) -> messages (新) 顺序逐条移除展示图片并附加 delivery-budget-exceeded notice。
 * 4. 再次测量。若在 30 MiB 内返回 ok: true；若仍超限返回 ok: false, code: "MESSAGE_DELIVERY_TOO_LARGE"。
 */
export function enforceDeliveryBudgetOnPayload<T extends DeliveryPayloadWithMessages>(
	payload: T,
	buildWrapper: (candidate: T) => unknown,
	maxBytes: number = MAX_MESSAGE_DELIVERY_ENVELOPE_BYTES,
): DeliveryBudgetResult<T> {
	// 1. 去除工具冗余 meta.result
	let modifiedSlideOut: ChatMessage[] | undefined = payload.slideOut
		? stripToolResultForDelivery(payload.slideOut)
		: undefined;
	let modifiedMessages: ChatMessage[] = stripToolResultForDelivery(payload.messages);

	let currentPayload: T = {
		...payload,
		messages: modifiedMessages,
		...(modifiedSlideOut ? { slideOut: modifiedSlideOut } : {}),
	};

	let bytes = measureUtf8JsonBytes(buildWrapper(currentPayload));
	if (bytes === null) {
		// 序列化失败不得当作 0 字节放行；带回已 strip 的 candidate 供调用方阻断。
		return { ok: false, code: "SERIALIZATION_FAILED", value: currentPayload };
	}
	if (bytes <= maxBytes) {
		return { ok: true, value: currentPayload };
	}

	// 2. 逐条卸载展示图片（slideOut -> messages）
	if (modifiedSlideOut) {
		modifiedSlideOut = modifiedSlideOut.map((m) => ({ ...m }));
		for (let i = 0; i < modifiedSlideOut.length; i++) {
			const msg = modifiedSlideOut[i];
			if (msg.images?.length) {
				const omitted = (msg.imageDisplayNotice?.omitted ?? 0) + msg.images.length;
				const count = msg.imageDisplayNotice?.count ?? msg.images.length;
				modifiedSlideOut[i] = {
					...msg,
					images: undefined,
					imageDisplayNotice: {
						kind: "delivery-budget-exceeded",
						count,
						omitted,
					},
				};
				currentPayload = {
					...currentPayload,
					slideOut: modifiedSlideOut,
				};
				bytes = measureUtf8JsonBytes(buildWrapper(currentPayload));
				if (bytes === null) return { ok: false, code: "SERIALIZATION_FAILED", value: currentPayload };
				if (bytes <= maxBytes) return { ok: true, value: currentPayload };
			}
		}
	}

	modifiedMessages = modifiedMessages.map((m) => ({ ...m }));
	for (let i = 0; i < modifiedMessages.length; i++) {
		const msg = modifiedMessages[i];
		if (msg.images?.length) {
			const omitted = (msg.imageDisplayNotice?.omitted ?? 0) + msg.images.length;
			const count = msg.imageDisplayNotice?.count ?? msg.images.length;
			modifiedMessages[i] = {
				...msg,
				images: undefined,
				imageDisplayNotice: {
					kind: "delivery-budget-exceeded",
					count,
					omitted,
				},
			};
			currentPayload = {
				...currentPayload,
				messages: modifiedMessages,
			};
			bytes = measureUtf8JsonBytes(buildWrapper(currentPayload));
			if (bytes === null) return { ok: false, code: "SERIALIZATION_FAILED", value: currentPayload };
			if (bytes <= maxBytes) return { ok: true, value: currentPayload };
		}
	}

	// 删完所有图片后仍超限：带回已剥光图片的 candidate（不得原样放行带图 payload）
	return { ok: false, code: "MESSAGE_DELIVERY_TOO_LARGE", value: currentPayload };
}

/**
 * 针对历史分页返回（SessionMessagePage）的预算处理：
 * 测量 { ok: true, result: page }，超限时移除图片。若删完图片仍超限返回失败。
 */
export function enforceDeliveryBudgetOnPage(
	page: SessionMessagePage,
	maxBytes: number = MAX_MESSAGE_DELIVERY_ENVELOPE_BYTES,
): DeliveryBudgetResult<SessionMessagePage> {
	const stripped = {
		...page,
		messages: stripToolResultForDelivery(page.messages),
	};

	const buildWrapper = (candidatePage: SessionMessagePage) => ({
		ok: true,
		result: candidatePage,
	});

	let bytes = measureUtf8JsonBytes(buildWrapper(stripped));
	if (bytes === null) return { ok: false, code: "SERIALIZATION_FAILED", value: stripped };
	if (bytes <= maxBytes) return { ok: true, value: stripped };

	let messages = stripped.messages.map((m) => ({ ...m }));
	let currentPayload = stripped;
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.images?.length) {
			const omitted = (msg.imageDisplayNotice?.omitted ?? 0) + msg.images.length;
			const count = msg.imageDisplayNotice?.count ?? msg.images.length;
			messages[i] = {
				...msg,
				images: undefined,
				imageDisplayNotice: {
					kind: "delivery-budget-exceeded",
					count,
					omitted,
				},
			};
			const candidate = { ...stripped, messages };
			currentPayload = candidate;
			bytes = measureUtf8JsonBytes(buildWrapper(candidate));
			if (bytes === null) return { ok: false, code: "SERIALIZATION_FAILED", value: candidate };
			if (bytes <= maxBytes) return { ok: true, value: candidate };
		}
	}

	// 删完所有图片后仍超限：带回已剥光图片的 candidate
	return { ok: false, code: "MESSAGE_DELIVERY_TOO_LARGE", value: currentPayload };
}
