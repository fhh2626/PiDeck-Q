import { randomUUID } from "node:crypto";
import type { AppLogger } from "../logging/AppLogger";
import type { ExternalProtocolRequestPayload } from "../../shared/types/app";

/**
 * guest 外部协议请求的 pending 注册表（仅主进程持有）。
 *
 * 安全模型：URL 的权威值只存在这里，渲染层只拿 { id, url } 用于展示，
 * 确认时回传 id、由本注册表用自己保存的 targetUrl 执行打开——渲染层
 * 无法伪造/替换目标 URL。
 *
 * 限流规则：
 * - 同一 guest 已有 pending：后续请求直接丢弃（不重复弹框）；
 * - 同一 guest 被拒绝后进入 cooldown（默认 2s），期间新请求直接丢弃，
 *   防止取消后被恶意脚本立即重新弹框（modal spam）。
 */

/** 拒绝后的冷却窗口（毫秒）。 */
export const EXTERNAL_PROTOCOL_COOLDOWN_MS = 2000;

export type PendingExternalProtocolRequest = {
	id: string;
	guestId: number;
	targetUrl: string;
};

export type ExternalProtocolGateway = {
	/**
	 * 记录一次 guest 外部协议请求。
	 * 返回推送给渲染层的 payload；被去重/cooldown 拒绝时返回 null。
	 */
	request(guestId: number, url: string): ExternalProtocolRequestPayload | null;
	/** 用户确认：按 id 取回权威 URL 并释放槽位；id 不存在返回 null。 */
	confirm(id: string): string | null;
	/** 用户取消：清除 pending 并对该 guest 进入 cooldown。 */
	cancel(id: string): void;
	/** guest 销毁：清掉它的 pending 与 cooldown。 */
	forgetGuest(guestId: number): void;
};

export function createExternalProtocolGateway(logger?: Pick<AppLogger, "warn">): ExternalProtocolGateway {
	/** 每个 guest 至多一条 pending（同 guest 后续请求丢弃）。 */
	const pendingByGuest = new Map<number, PendingExternalProtocolRequest>();
	/** id → request，供 confirm/cancel 反查。 */
	const pendingById = new Map<string, PendingExternalProtocolRequest>();
	/** guest → cooldown 截止时间戳（cancel 后生效）。 */
	const cooldownUntil = new Map<number, number>();

	return {
		request(guestId, url) {
			if (pendingByGuest.has(guestId)) {
				logger?.warn("browser", "Dropped external protocol request: one already pending", {
					guestId,
					url,
				});
				return null;
			}
			const now = Date.now();
			const until = cooldownUntil.get(guestId);
			if (until != null && until > now) {
				logger?.warn("browser", "Dropped external protocol request: guest in cancel cooldown", {
					guestId,
					url,
				});
				return null;
			}
			const request: PendingExternalProtocolRequest = {
				id: randomUUID(),
				guestId,
				targetUrl: url,
			};
			pendingByGuest.set(guestId, request);
			pendingById.set(request.id, request);
			return { id: request.id, url: request.targetUrl };
		},

		confirm(id) {
			const request = pendingById.get(id);
			if (!request) return null;
			pendingByGuest.delete(request.guestId);
			pendingById.delete(id);
			return request.targetUrl;
		},

		cancel(id) {
			const request = pendingById.get(id);
			if (!request) return;
			pendingById.delete(id);
			pendingByGuest.delete(request.guestId);
			cooldownUntil.set(request.guestId, Date.now() + EXTERNAL_PROTOCOL_COOLDOWN_MS);
		},

		forgetGuest(guestId) {
			const request = pendingByGuest.get(guestId);
			if (request) pendingById.delete(request.id);
			pendingByGuest.delete(guestId);
			cooldownUntil.delete(guestId);
		},
	};
}
