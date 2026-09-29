/** Web 服务访问 URL 中携带一次性交换令牌的查询参数名。 */
export const WEB_SERVICE_TOKEN_QUERY_PARAM = "pideck_token";

const WEB_SERVICE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

/** 令牌格式校验：base64url 字符集，长度 32–128，拒绝空值与弱令牌。 */
export function isValidWebServiceAccessToken(value: unknown): value is string {
	return typeof value === "string" && WEB_SERVICE_TOKEN_PATTERN.test(value);
}

/** 构造带访问令牌的 Web 服务入口 URL（二维码 / 打开按钮使用）；IPv6 地址自动加方括号。 */
export function buildWebServiceAccessUrl(host: string, port: number | string, token: string): string {
	const hostPart = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
	const url = new URL(`http://${hostPart}:${port}/`);
	if (isValidWebServiceAccessToken(token)) url.searchParams.set(WEB_SERVICE_TOKEN_QUERY_PARAM, token);
	return url.toString();
}
