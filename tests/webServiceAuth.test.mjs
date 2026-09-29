import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { authorizeWebRequest, webServiceCookieName } = loadTsCommonJs("src/main/web/webServiceAuth.ts");

const TOKEN = "a".repeat(43);
const PORT = 8765;
const HOST = "127.0.0.1:8765";

function decide({ method = "GET", url = "/api/state", headers = {}, token = TOKEN, port = PORT } = {}) {
	return authorizeWebRequest({
		method,
		url: new URL(url, `http://${HOST}`),
		headers: { host: HOST, ...headers },
		port,
		expectedToken: token,
	});
}

test("health endpoint stays public without credentials", () => {
	assert.equal(decide({ url: "/api/health" }).kind, "public");
});

test("api requests without credentials are unauthorized", () => {
	assert.equal(decide().kind, "unauthorized");
});

test("cookie issued for this port authorizes the request", () => {
	const decision = decide({ headers: { cookie: `${webServiceCookieName(PORT)}=${TOKEN}` } });
	assert.equal(decision.kind, "authorized");
});

test("cookie scoped to another port does not authorize", () => {
	const decision = decide({ headers: { cookie: `${webServiceCookieName(9999)}=${TOKEN}` } });
	assert.equal(decision.kind, "unauthorized");
});

test("bearer token authorizes the request", () => {
	assert.equal(decide({ headers: { authorization: `Bearer ${TOKEN}` } }).kind, "authorized");
});

test("wrong bearer token is rejected", () => {
	assert.equal(decide({ headers: { authorization: `Bearer ${"b".repeat(43)}` } }).kind, "unauthorized");
});

test("query token exchanges into a cookie and drops the token from the redirect target", () => {
	const decision = decide({ url: `/?pideck_token=${TOKEN}&view=legacy` });
	assert.equal(decision.kind, "exchange");
	assert.equal(decision.location, "/?view=legacy");
	assert.ok(decision.setCookie.includes(`pideck_web_token_${PORT}=${TOKEN}`));
	assert.ok(decision.setCookie.includes("HttpOnly"));
	assert.ok(decision.setCookie.includes("SameSite=Strict"));
});

test("wrong query token is rejected", () => {
	assert.equal(decide({ url: "/?pideck_token=wrong" }).kind, "unauthorized");
});

test("cross-site POST is rejected even with a valid cookie", () => {
	const decision = decide({
		method: "POST",
		url: "/api/chat",
		headers: {
			cookie: `${webServiceCookieName(PORT)}=${TOKEN}`,
			origin: "http://evil.test",
		},
	});
	assert.equal(decision.kind, "forbidden-origin");
});

test("same-origin POST is authorized", () => {
	const decision = decide({
		method: "POST",
		url: "/api/chat",
		headers: {
			cookie: `${webServiceCookieName(PORT)}=${TOKEN}`,
			origin: `http://${HOST}`,
		},
	});
	assert.equal(decision.kind, "authorized");
});

test("an unconfigured token rejects every request", () => {
	assert.equal(decide({ token: "", headers: { authorization: "Bearer " } }).kind, "unauthorized");
});
