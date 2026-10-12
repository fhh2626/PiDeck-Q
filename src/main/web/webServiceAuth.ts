import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { WEB_SERVICE_TOKEN_QUERY_PARAM } from "../../shared/webServiceAccess";

export type WebAuthDecision =
	| { kind: "public" }
	| { kind: "authorized" }
	| { kind: "exchange"; location: string; setCookie: string }
	| { kind: "unauthorized" }
	| { kind: "forbidden-origin" };

const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** Cookie 名带端口：同主机不同端口的实例共享 Cookie 命名空间，避免互相覆盖。 */
export function webServiceCookieName(port: number): string {
	return `pideck_web_token_${port}`;
}

/** 从 Cookie 头读取指定名称的值；无该 Cookie 返回 undefined。 */
export function readCookie(header: string | undefined, name: string): string | undefined {
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const index = part.indexOf("=");
		if (index < 0) continue;
		if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
	}
	return undefined;
}

/** 常量时间比较；期望令牌为空时恒为 false（服务未配置令牌即全部拒绝）。 */
export function tokensEqual(expected: string, actual: string | undefined): boolean {
	if (!expected || !actual) return false;
	const left = Buffer.from(expected, "utf8");
	const right = Buffer.from(actual, "utf8");
	return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Web 服务请求鉴权决策（按顺序）：
 * 1. /api/health 公开；
 * 2. 非安全方法带跨源 Origin → 拒绝（防 CSRF / DNS rebinding）；
 * 3. URL 带 pideck_token：GET 且正确 → 下发 Cookie 并重定向去掉 token；否则拒绝；
 * 4. Authorization: Bearer 或 Cookie 正确 → 放行；
 * 5. 其他 → 未授权。
 */
export function authorizeWebRequest(input: {
	method: string;
	url: URL;
	headers: IncomingHttpHeaders;
	port: number;
	expectedToken: string;
}): WebAuthDecision {
	const { method, url, headers, port, expectedToken } = input;
	if (url.pathname === "/api/health") return { kind: "public" };

	const safeMethod = method === "GET" || method === "HEAD" || method === "OPTIONS";
	const origin = typeof headers.origin === "string" ? headers.origin : undefined;
	if (!safeMethod && origin !== undefined && origin !== `http://${headers.host ?? ""}`) {
		return { kind: "forbidden-origin" };
	}

	const queryToken = url.searchParams.get(WEB_SERVICE_TOKEN_QUERY_PARAM);
	if (queryToken !== null) {
		if (method !== "GET" || !tokensEqual(expectedToken, queryToken)) return { kind: "unauthorized" };
		const cleaned = new URL(url.toString());
		cleaned.searchParams.delete(WEB_SERVICE_TOKEN_QUERY_PARAM);
		return {
			kind: "exchange",
			location: `${cleaned.pathname}${cleaned.search}`,
			setCookie: `${webServiceCookieName(port)}=${queryToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
		};
	}

	const authorization = typeof headers.authorization === "string" ? headers.authorization : "";
	if (authorization.startsWith("Bearer ") && tokensEqual(expectedToken, authorization.slice(7).trim())) {
		return { kind: "authorized" };
	}
	const cookieHeader = typeof headers.cookie === "string" ? headers.cookie : undefined;
	if (tokensEqual(expectedToken, readCookie(cookieHeader, webServiceCookieName(port)))) {
		return { kind: "authorized" };
	}
	return { kind: "unauthorized" };
}
