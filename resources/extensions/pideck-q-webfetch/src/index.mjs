import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { Type } from "@sinclair/typebox";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { LRUCache } from "lru-cache";
import { mkdir, writeFile } from "node:fs/promises";
import { Readability } from "@mozilla/readability";
import { DOMParser, parseHTML } from "linkedom";
import TurndownService from "turndown";
//#region ../utils/src/paths.ts
function getPiLabGlobalDir(home = homedir()) {
	return join(home, ".pi", "agent", "pi-lab");
}
function getPiLabGlobalTmpDir(name, home = homedir()) {
	const tmpDir = join(getPiLabGlobalDir(home), "tmp");
	return name ? join(tmpDir, name) : tmpDir;
}
//#endregion
//#region ../utils/src/settings.ts
function readJsonFile(filePath) {
	try {
		return JSON.parse(readFileSync(filePath, "utf8"));
	} catch (error) {
		if (error.code === "ENOENT") return {};
		throw error;
	}
}
function readPiProjectSettings(cwd = process.cwd()) {
	return readJsonFile(join(cwd, ".pi", "settings.json"));
}
function readPiUserSettings(home = homedir()) {
	return readJsonFile(join(home, ".pi", "agent", "settings.json"));
}
function mergePiSettings(userSettings = {}, projectSettings = {}) {
	return deepMerge(userSettings, projectSettings);
}
function readMergedPiSettings(options = {}) {
	return mergePiSettings(readPiUserSettings(options.home), readPiProjectSettings(options.cwd));
}
function deepMerge(base, override) {
	const result = { ...base };
	for (const [key, value] of Object.entries(override)) {
		if (value === void 0) continue;
		const existing = result[key];
		if (isPlainObject(existing) && isPlainObject(value)) result[key] = deepMerge(existing, value);
		else result[key] = value;
	}
	return result;
}
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
//#endregion
//#region src/config.ts
const DEFAULT_CONFIG = {
	maxPageLength: 2e4,
	cache: {
		maxSizeBytes: 50 * 1024 * 1024,
		ttlMs: 900 * 1e3
	},
	optimizations: true
};
function mergeConfig(partial) {
	if (!partial) return DEFAULT_CONFIG;
	return {
		maxPageLength: partial.maxPageLength ?? DEFAULT_CONFIG.maxPageLength,
		cache: {
			...DEFAULT_CONFIG.cache,
			...partial.cache
		},
		optimizations: partial.optimizations ?? DEFAULT_CONFIG.optimizations
	};
}
function loadWebFetchConfig(settings = {}) {
	const webfetch = settings.webfetch;
	if (typeof webfetch !== "object" || webfetch === null || Array.isArray(webfetch)) return mergeConfig();
	const optimizations = webfetch.optimizations;
	return mergeConfig({ optimizations: typeof optimizations === "boolean" ? optimizations : void 0 });
}
//#endregion
//#region src/cache.ts
var WebFetchCache = class {
	cache;
	constructor(config) {
		this.cache = new LRUCache({
			maxSize: config.maxSizeBytes,
			sizeCalculation: (value) => {
				return Buffer.byteLength(value.markdown, "utf8") + value.scripts.reduce((sum, s) => sum + Buffer.byteLength(s.content, "utf8"), 0);
			},
			ttl: config.ttlMs,
			allowStale: false
		});
	}
	get(key) {
		return this.cache.get(key);
	}
	set(key, value, ttlMs) {
		if (ttlMs === void 0) this.cache.set(key, value);
		else this.cache.set(key, value, { ttl: ttlMs });
	}
	delete(key) {
		this.cache.delete(key);
	}
	clear() {
		this.cache.clear();
	}
};
//#endregion
//#region src/normalize.ts
/**
* Normalize a URL in a lossless way:
* 1. Lowercase protocol
* 2. Lowercase hostname
* 3. Upgrade http → https
* 4. Remove default ports (:80 for http, :443 for https)
*
* Does NOT reorder query params or normalize trailing slashes.
*/
function normalizeUrl(rawUrl) {
	const url = new URL(rawUrl);
	url.protocol = url.protocol.toLowerCase();
	url.hostname = url.hostname.toLowerCase();
	if (url.protocol === "http:") url.protocol = "https:";
	if (url.port === "443" && url.protocol === "https:") url.port = "";
	if (url.port === "80" && url.protocol === "http:") url.port = "";
	return url.toString();
}
//#endregion
//#region src/fetch.ts
const TEXT_ACCEPT = "text/markdown, text/plain, text/html, */*";
const NON_PAGE_EXTENSIONS = /* @__PURE__ */ new Set([
	".avif",
	".bmp",
	".gif",
	".ico",
	".jpeg",
	".jpg",
	".png",
	".svg",
	".tif",
	".tiff",
	".webp",
	".avi",
	".m3u8",
	".m4v",
	".mkv",
	".mov",
	".mp4",
	".mpeg",
	".mpg",
	".ts",
	".webm",
	".aac",
	".flac",
	".m4a",
	".mp3",
	".oga",
	".ogg",
	".opus",
	".wav",
	".weba",
	".7z",
	".bz2",
	".doc",
	".docx",
	".epub",
	".gz",
	".pdf",
	".ppt",
	".pptx",
	".rar",
	".tar",
	".wasm",
	".woff",
	".woff2",
	".xls",
	".xlsx",
	".xz",
	".zip"
]);
/**
* Prefer an unconstrained response for URLs that look like direct media or
* binary downloads. Keep content negotiation for ordinary web pages so sites
* that support Markdown can return it directly.
*/
function acceptHeaderForUrl(url) {
	const extension = new URL(url).pathname.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
	return extension && NON_PAGE_EXTENSIONS.has(extension) ? "*/*" : TEXT_ACCEPT;
}
/**
* Determine if two URLs are on the same domain.
* Same domain = same protocol + same port + same hostname (ignoring www prefix).
*/
function isSameDomain(a, b) {
	try {
		const u1 = new URL(a);
		const u2 = new URL(b);
		if (u1.protocol !== u2.protocol) return false;
		if (u1.port !== u2.port) return false;
		return u1.hostname.replace(/^www\./, "") === u2.hostname.replace(/^www\./, "");
	} catch {
		return false;
	}
}
const TEXT_CONTENT_TYPES = /* @__PURE__ */ new Set([
	"application/atom+xml",
	"application/json",
	"application/rss+xml",
	"application/xml",
	"text/xml"
]);
function isTextContentType(contentType) {
	const baseContentType = contentType.split(";")[0].trim().toLowerCase();
	return baseContentType.startsWith("text/") || TEXT_CONTENT_TYPES.has(baseContentType);
}
const CONTENT_TYPE_EXTENSIONS = {
	"image/jpeg": ".jpg",
	"image/png": ".png",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/svg+xml": ".svg",
	"application/pdf": ".pdf",
	"application/zip": ".zip",
	"application/json": ".json",
	"video/mp4": ".mp4",
	"audio/mpeg": ".mp3"
};
function extForContentType(contentType) {
	return CONTENT_TYPE_EXTENSIONS[contentType] ?? ".bin";
}
/**
* Fetch a URL, following same-domain redirects automatically.
* Cross-domain redirects are returned as RedirectResult for the LLM to handle.
* Binary content is saved to tempDir and returned as BinaryResult.
*/
async function fetchUrl(normalizedUrl, tempDir, signal, maxRedirects = 10) {
	let currentUrl = normalizedUrl;
	for (let hop = 0; hop <= maxRedirects; hop++) {
		const response = await fetch(currentUrl, {
			signal,
			redirect: "manual",
			headers: {
				Accept: acceptHeaderForUrl(currentUrl),
				"User-Agent": "pi/webfetch"
			}
		});
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location) throw new Error(`Redirect ${response.status} with no Location header`);
			let redirectUrl;
			try {
				redirectUrl = new URL(location, currentUrl).toString();
			} catch {
				throw new Error(`Invalid redirect location: ${location}`);
			}
			if (isSameDomain(currentUrl, redirectUrl)) {
				currentUrl = normalizeUrl(redirectUrl);
				continue;
			} else return {
				type: "redirect",
				originalUrl: normalizedUrl,
				redirectUrl,
				statusCode: response.status
			};
		}
		if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		const baseContentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
		if (isTextContentType(baseContentType)) return {
			type: "text",
			content: await response.text(),
			contentType: baseContentType,
			url: currentUrl
		};
		await mkdir(tempDir, { recursive: true });
		const ext = extForContentType(baseContentType);
		const filePath = join(tempDir, `webfetch-${Date.now()}${ext}`);
		const buffer = await response.arrayBuffer();
		await writeFile(filePath, Buffer.from(buffer));
		return {
			type: "binary",
			filePath,
			contentType: baseContentType,
			url: currentUrl
		};
	}
	throw new Error(`Too many redirects (max ${maxRedirects})`);
}
//#endregion
//#region src/content.ts
let turndownInstance = null;
function getTurndown() {
	if (!turndownInstance) {
		turndownInstance = new TurndownService({
			headingStyle: "atx",
			codeBlockStyle: "fenced",
			bulletListMarker: "-"
		});
		turndownInstance.remove([
			"style",
			"script",
			"noscript"
		]);
		turndownInstance.keep(["pre", "code"]);
	}
	return turndownInstance;
}
/** Convert an HTML fragment to Markdown without applying Readability. */
function htmlToMarkdown(html) {
	return getTurndown().turndown(html).trim();
}
/**
* Extract inline <script> elements (no src attribute) from a parsed document.
* External scripts are skipped — they have no inline content.
*/
function extractInlineScripts(document) {
	const results = [];
	const els = document.querySelectorAll("script:not([src])");
	let index = 0;
	for (const el of els) {
		const content = el.textContent?.trim() ?? "";
		if (content.length === 0) continue;
		results.push({
			index: index++,
			length: content.length,
			preview: content.slice(0, 80).replace(/\s+/g, " "),
			content
		});
	}
	return results;
}
/**
* Process HTML content:
* 1. Try Mozilla Readability to extract main content
* 2. If extraction ratio < 10%, fall back to full HTML → Markdown
* Also extracts inline scripts as a separate list.
*/
async function processHtml(html, _url) {
	const { document } = parseHTML(html);
	const scripts = extractInlineScripts(document);
	try {
		const article = new Readability(document).parse();
		if (article?.content) {
			if (article.content.length / html.length >= .1) return {
				markdown: htmlToMarkdown(article.content),
				scripts,
				method: "readability"
			};
		}
	} catch {}
	return {
		markdown: htmlToMarkdown(html),
		scripts,
		method: "full-html"
	};
}
/**
* Process plain text / markdown content.
*/
function processPlainText(text) {
	return text;
}
//#endregion
//#region src/paths.ts
function getBinaryTempDir(home = homedir()) {
	return getPiLabGlobalTmpDir("webfetch", home);
}
//#endregion
//#region src/optimizers/reddit.ts
const REDDIT_RSS_CACHE_TTL_MS = 3600 * 1e3;
const REDDIT_FALLBACK_CACHE_TTL_MS = 60 * 1e3;
const MEDIA_EXPIRY_SAFETY_MS = 60 * 1e3;
const MAX_PACKAGED_MEDIA_JSON_LENGTH = 1024 * 1024;
const MAX_VIDEO_DIMENSION = 16384;
const USER_AGENT = "Mozilla/5.0 (compatible; pi-webfetch/1.0)";
function cleanText(value) {
	return value?.trim() || void 0;
}
function cleanAuthor(value) {
	return value?.replace(/^\/u\//, "u/");
}
function parseRedditPostUrl(rawUrl) {
	let url;
	try {
		url = new URL(rawUrl);
	} catch {
		return;
	}
	const hostname = url.hostname.toLowerCase();
	if (hostname !== "reddit.com" && hostname !== "www.reddit.com") return void 0;
	const parts = url.pathname.split("/").filter(Boolean);
	if (parts.length < 4 || parts[0]?.toLowerCase() !== "r" || parts[2]?.toLowerCase() !== "comments") return;
	const subreddit = parts[1];
	const postId = parts[3]?.toLowerCase();
	if (!subreddit || !postId || !/^[a-z0-9]+$/.test(postId)) return void 0;
	const possibleSlug = parts[4];
	const slug = possibleSlug && possibleSlug !== ".rss" ? possibleSlug : void 0;
	const rootPath = `/r/${encodeURIComponent(subreddit)}/comments/${postId}/${slug ? `${encodeURIComponent(slug)}/` : ""}`;
	const permalink = `https://www.reddit.com${rootPath}`;
	const rssUrl = new URL(".rss", permalink);
	rssUrl.searchParams.set("limit", "500");
	rssUrl.searchParams.set("sort", "top");
	const embedUrl = new URL(rootPath, "https://embed.reddit.com");
	embedUrl.searchParams.set("ref_source", "embed");
	embedUrl.searchParams.set("ref", "share");
	embedUrl.searchParams.set("embed", "true");
	const oembedUrl = new URL("https://www.reddit.com/oembed");
	oembedUrl.searchParams.set("url", permalink);
	return {
		postId,
		subreddit,
		slug,
		permalink,
		cacheKey: `reddit:post:${postId}`,
		rssUrl: rssUrl.toString(),
		embedUrl: embedUrl.toString(),
		oembedUrl: oembedUrl.toString()
	};
}
function mediaFromHtml(html) {
	const { document } = parseHTML(`<main>${html}</main>`);
	const media = [];
	const seen = /* @__PURE__ */ new Set();
	for (const image of document.querySelectorAll("img")) {
		const url = cleanText(image.getAttribute("src"));
		if (!url || seen.has(url)) continue;
		seen.add(url);
		media.push({
			url,
			alt: cleanText(image.getAttribute("alt"))
		});
	}
	return media;
}
function entryBodyMarkdown(contentHtml) {
	const { document } = parseHTML(`<main>${contentHtml}</main>`);
	return htmlToMarkdown(document.querySelector(".md")?.innerHTML ?? contentHtml);
}
function parseRedditAtom(xml) {
	const document = new DOMParser().parseFromString(xml, "text/xml");
	const entries = [];
	for (const element of document.querySelectorAll("entry")) {
		const id = cleanText(element.querySelector("id")?.textContent);
		if (!id || !id.startsWith("t3_") && !id.startsWith("t1_")) continue;
		const contentHtml = element.querySelector("content")?.textContent ?? "";
		const permalink = cleanText(element.querySelector("link")?.getAttribute("href")) ?? "";
		entries.push({
			id,
			title: cleanText(element.querySelector("title")?.textContent) ?? "Untitled",
			author: cleanAuthor(cleanText(element.querySelector("author name")?.textContent)),
			bodyMarkdown: entryBodyMarkdown(contentHtml),
			permalink,
			updated: cleanText(element.querySelector("updated")?.textContent),
			media: mediaFromHtml(contentHtml)
		});
	}
	const post = entries.find((entry) => entry.id.startsWith("t3_"));
	if (!post) return void 0;
	return {
		post,
		comments: entries.filter((entry) => entry.id.startsWith("t1_"))
	};
}
function preferredImageUrl(image) {
	const srcset = image.getAttribute("srcset");
	if (srcset) {
		const candidates = srcset.split(",").map((candidate) => {
			const [url, width] = candidate.trim().split(/\s+/, 2);
			return {
				url,
				width: Number.parseInt(width ?? "0", 10) || 0
			};
		}).filter((candidate) => candidate.url);
		candidates.sort((a, b) => b.width - a.width);
		if (candidates[0]?.url) return candidates[0].url;
	}
	return cleanText(image.getAttribute("src"));
}
function validVideoDimension(value) {
	return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_VIDEO_DIMENSION ? value : void 0;
}
function parseUnixExpiry(value) {
	if (!value || !/^\d{10}$/.test(value)) return void 0;
	const seconds = Number(value);
	return Number.isSafeInteger(seconds) && seconds >= 1e9 ? seconds * 1e3 : void 0;
}
function parseRedditVideoExpiry(url) {
	try {
		const parsed = new URL(url);
		if (parsed.hostname.toLowerCase() === "packaged-media.redd.it") return parseUnixExpiry(parsed.searchParams.get("e"));
		if (parsed.hostname.toLowerCase() === "v.redd.it") return parseUnixExpiry(parsed.searchParams.get("a")?.split(",", 1)[0] ?? null);
	} catch {}
}
function parseTrustedMediaUrl(rawUrl, hostname, extension) {
	if (typeof rawUrl !== "string" || /[\u0000-\u001f\u007f]/.test(rawUrl)) return void 0;
	try {
		const url = new URL(rawUrl);
		if (url.protocol !== "https:" || url.hostname.toLowerCase() !== hostname || url.username || url.password || !url.pathname.toLowerCase().endsWith(extension)) return void 0;
		return rawUrl;
	} catch {
		return;
	}
}
function isFreshMediaUrl(url, now) {
	const expiresAt = parseRedditVideoExpiry(url);
	return expiresAt === void 0 || expiresAt - now > MEDIA_EXPIRY_SAFETY_MS;
}
function focalRedditPlayer(document, postId) {
	const players = Array.from(document.querySelectorAll("shreddit-player"));
	if (postId) {
		const expected = `t3_${postId.toLowerCase()}`;
		const matching = players.find((player) => cleanText(player.getAttribute("post-id"))?.toLowerCase() === expected);
		if (matching) return matching;
	}
	if (players.length !== 1) return void 0;
	const player = players[0];
	const playerPostId = cleanText(player?.getAttribute("post-id"))?.toLowerCase();
	if (postId && playerPostId && playerPostId !== `t3_${postId.toLowerCase()}`) return void 0;
	return player;
}
function parseRedditPackagedVideo(player, now) {
	const packagedJson = player.getAttribute("packaged-media-json");
	let playbackMp4s;
	if (packagedJson && packagedJson.length <= MAX_PACKAGED_MEDIA_JSON_LENGTH) try {
		const root = JSON.parse(packagedJson);
		if (root && typeof root === "object") {
			const playback = root.playbackMp4s;
			if (playback && typeof playback === "object") playbackMp4s = playback;
		}
	} catch {}
	const candidates = [];
	const permutations = playbackMp4s?.permutations;
	if (Array.isArray(permutations)) for (const [index, permutation] of permutations.entries()) {
		if (!permutation || typeof permutation !== "object") continue;
		const source = permutation.source;
		if (!source || typeof source !== "object") continue;
		const sourceData = source;
		const downloadUrl = parseTrustedMediaUrl(sourceData.url, "packaged-media.redd.it", ".mp4");
		if (!downloadUrl || !isFreshMediaUrl(downloadUrl, now)) continue;
		const dimensions = sourceData.dimensions;
		if (dimensions !== void 0 && (!dimensions || typeof dimensions !== "object" || Array.isArray(dimensions))) continue;
		const dimensionsData = dimensions;
		const width = validVideoDimension(dimensionsData?.width);
		const height = validVideoDimension(dimensionsData?.height);
		if (dimensionsData?.width !== void 0 && width === void 0 || dimensionsData?.height !== void 0 && height === void 0) continue;
		candidates.push({
			downloadUrl,
			width,
			height,
			expiresAt: parseRedditVideoExpiry(downloadUrl),
			index
		});
	}
	candidates.sort((a, b) => {
		return (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0) || (b.width ?? 0) - (a.width ?? 0) || a.index - b.index;
	});
	const hlsUrl = [cleanText(player.getAttribute("src")), cleanText(player.querySelector("source")?.getAttribute("src"))].map((url) => parseTrustedMediaUrl(url, "v.redd.it", ".m3u8")).find((url) => Boolean(url && isFreshMediaUrl(url, now)));
	const preferred = candidates[0];
	if (!preferred && !hlsUrl) return void 0;
	const duration = playbackMp4s?.duration;
	const durationSeconds = typeof duration === "number" && Number.isFinite(duration) && duration >= 0 ? duration : void 0;
	const expiries = [preferred?.expiresAt, hlsUrl ? parseRedditVideoExpiry(hlsUrl) : void 0].filter((expiry) => expiry !== void 0);
	return {
		downloadUrl: preferred?.downloadUrl,
		width: preferred?.width,
		height: preferred?.height,
		durationSeconds,
		hlsUrl,
		expiresAt: expiries.length > 0 ? Math.min(...expiries) : void 0
	};
}
function parseRedditEmbed(html, postId, now = Date.now()) {
	const { document } = parseHTML(html);
	const title = cleanText(document.querySelector("#embed-title")?.textContent);
	const author = cleanAuthor(cleanText(document.querySelector("a[href*=\"/user/\"]")?.textContent));
	const countMatch = cleanText(document.querySelector("[data-testid=\"cta\"]")?.textContent)?.replaceAll(",", "").match(/(\d+)\s+comments?/i);
	const displayedCommentCount = countMatch ? Number.parseInt(countMatch[1], 10) : void 0;
	const media = [];
	const seen = /* @__PURE__ */ new Set();
	for (const image of document.querySelectorAll("img")) {
		const url = preferredImageUrl(image);
		if (!url || seen.has(url)) continue;
		let hostname;
		try {
			hostname = new URL(url).hostname.toLowerCase();
		} catch {
			continue;
		}
		if (hostname !== "preview.redd.it" && hostname !== "i.redd.it" && hostname !== "external-preview.redd.it") continue;
		seen.add(url);
		media.push({
			url,
			alt: cleanText(image.getAttribute("alt"))
		});
	}
	const player = focalRedditPlayer(document, postId);
	const video = player ? parseRedditPackagedVideo(player, now) : void 0;
	if (!title && !author && media.length === 0 && displayedCommentCount === void 0 && !video) return void 0;
	return {
		title,
		author,
		displayedCommentCount,
		media,
		video
	};
}
function parseOEmbed(json) {
	try {
		const value = JSON.parse(json);
		const title = typeof value.title === "string" ? cleanText(value.title) : void 0;
		const author = typeof value.author_name === "string" ? cleanAuthor(cleanText(value.author_name)) : void 0;
		return title || author ? {
			title,
			author
		} : void 0;
	} catch {
		return;
	}
}
async function fetchText(url, signal, fetcher) {
	try {
		const response = await fetcher(url, {
			signal,
			headers: {
				Accept: "application/atom+xml, application/xml, application/json, text/html;q=0.9, */*;q=0.1",
				"User-Agent": USER_AGENT
			}
		});
		return {
			ok: response.ok,
			status: response.status,
			statusText: response.statusText,
			body: await response.text(),
			retryAfter: response.headers.get("retry-after") ?? void 0,
			rateLimitReset: response.headers.get("x-ratelimit-reset") ?? void 0
		};
	} catch (error) {
		if (signal?.aborted) throw error;
		return {
			ok: false,
			status: 0,
			statusText: error instanceof Error ? error.message : String(error),
			body: ""
		};
	}
}
function mergeMedia(...groups) {
	const result = [];
	const seen = /* @__PURE__ */ new Set();
	for (const media of groups.flat()) {
		if (seen.has(media.url)) continue;
		seen.add(media.url);
		result.push(media);
	}
	return result;
}
function renderRedditVideo(video) {
	const lines = [];
	if (video.downloadUrl) {
		const dimensions = video.width && video.height ? `, ${video.width}×${video.height}` : "";
		lines.push(`- [Download video (MP4${dimensions})](${video.downloadUrl})`);
	}
	if (video.hlsUrl && video.hlsUrl !== video.downloadUrl) lines.push(`- [Adaptive video stream (HLS)](${video.hlsUrl})`);
	return lines;
}
function renderRedditMarkdown(url, rss, embed, oembed, rssAttempt) {
	const post = rss?.post;
	const title = post?.title ?? embed?.title ?? oembed?.title ?? `Reddit post ${url.postId}`;
	const author = post?.author ?? embed?.author ?? oembed?.author;
	const comments = rss?.comments ?? [];
	const displayed = embed?.displayedCommentCount;
	const commentsTruncated = displayed !== void 0 && displayed > comments.length;
	const media = embed?.media.length ? embed.media : mergeMedia(post?.media ?? []);
	const sources = [
		rss && "RSS",
		embed && "Embed",
		oembed && "oEmbed"
	].filter(Boolean).join(", ");
	const lines = [`# ${title}`, ""];
	if (author) lines.push(`- Author: ${author}`);
	lines.push(`- Permalink: ${post?.permalink || url.permalink}`);
	if (post?.updated) lines.push(`- Updated: ${post.updated}`);
	if (rss) {
		const count = displayed === void 0 ? `${comments.length} fetched; displayed total unavailable` : `${comments.length} fetched / ${displayed} displayed${commentsTruncated ? " — incomplete" : ""}`;
		lines.push(`- Comments: ${count}`);
	} else lines.push(`- Comments: unavailable${displayed === void 0 ? "" : `; Reddit displays ${displayed}`}`);
	lines.push(`- Sources: ${sources || "none"}`);
	if (!rss) if (rssAttempt.status === 429) {
		const retry = rssAttempt.retryAfter ?? rssAttempt.rateLimitReset;
		lines.push(`- Notice: Reddit RSS was rate limited (HTTP 429)${retry ? `; retry indicated after ${retry} seconds` : ""}. Comment bodies could not be retrieved.`);
	} else lines.push(`- Notice: Reddit RSS was unavailable${rssAttempt.status ? ` (HTTP ${rssAttempt.status})` : ""}. Comment bodies could not be retrieved.`);
	lines.push("", "## Post", "", post?.bodyMarkdown || "Post body unavailable from the accessible Reddit endpoints.");
	const videoLines = embed?.video ? renderRedditVideo(embed.video) : [];
	if (videoLines.length > 0 || media.length > 0) {
		lines.push("", "## Media", "", ...videoLines);
		const videoUrls = new Set([embed?.video?.downloadUrl, embed?.video?.hlsUrl].filter(Boolean));
		for (const item of media) if (!videoUrls.has(item.url)) lines.push(`- ${item.alt ? `[${item.alt}](${item.url})` : item.url}`);
	}
	if (rss) {
		lines.push("", `## Comments (${comments.length} retrieved)`, "");
		lines.push("Reddit RSS does not expose scores, parent IDs, or reliable thread hierarchy.", "");
		for (const [index, comment] of comments.entries()) {
			lines.push(`### ${index + 1}. ${comment.author ?? "Deleted or unknown user"}`);
			if (comment.updated) lines.push(`Updated: ${comment.updated}`);
			if (comment.permalink) lines.push(`[Permalink](${comment.permalink})`);
			lines.push("", comment.bodyMarkdown || "[No retrievable comment body]", "");
		}
	}
	return lines.join("\n").trim();
}
async function fetchRedditPost(rawUrl, signal, fetcher = fetch, now = Date.now()) {
	const url = parseRedditPostUrl(rawUrl);
	if (!url) throw new Error(`Not a supported Reddit post URL: ${rawUrl}`);
	const rssAttempt = await fetchText(url.rssUrl, signal, fetcher);
	const rss = rssAttempt.ok ? parseRedditAtom(rssAttempt.body) : void 0;
	const embedAttempt = await fetchText(url.embedUrl, signal, fetcher);
	const embed = embedAttempt.ok ? parseRedditEmbed(embedAttempt.body, url.postId, now) : void 0;
	let oembed;
	let oembedAttempt;
	if (!rss && !embed) {
		oembedAttempt = await fetchText(url.oembedUrl, signal, fetcher);
		oembed = oembedAttempt.ok ? parseOEmbed(oembedAttempt.body) : void 0;
	}
	if (!rss && !embed && !oembed) {
		const summaries = [
			`RSS: ${rssAttempt.status || rssAttempt.statusText}`,
			`Embed: ${embedAttempt.status || embedAttempt.statusText}`,
			`oEmbed: ${oembedAttempt?.status || oembedAttempt?.statusText || "not attempted"}`
		];
		throw new Error(`Unable to fetch Reddit post ${url.postId} (${summaries.join("; ")})`);
	}
	const baseTtlMs = rss ? REDDIT_RSS_CACHE_TTL_MS : REDDIT_FALLBACK_CACHE_TTL_MS;
	const mediaTtlMs = embed?.video?.expiresAt === void 0 ? void 0 : embed.video.expiresAt - now - MEDIA_EXPIRY_SAFETY_MS;
	return {
		url: url.permalink,
		markdown: renderRedditMarkdown(url, rss, embed, oembed, rssAttempt),
		scripts: [],
		method: "optimized",
		ttlMs: mediaTtlMs === void 0 ? baseTtlMs : Math.min(baseTtlMs, mediaTtlMs)
	};
}
const redditOptimizer = {
	id: "reddit",
	match(url) {
		return parseRedditPostUrl(url) !== void 0;
	},
	cacheKey(url) {
		return parseRedditPostUrl(url)?.cacheKey;
	},
	fetch({ url, signal }) {
		return fetchRedditPost(url, signal);
	}
};
//#endregion
//#region src/optimizers/x.ts
function isXHost(hostname) {
	return hostname === "x.com" || hostname === "www.x.com" || hostname === "twitter.com" || hostname === "www.twitter.com";
}
function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function entitiesMap(value) {
	if (!isObject(value)) return {};
	const nested = value.entities;
	return isObject(nested) ? nested : value;
}
function stringValue(value) {
	return typeof value === "string" && value.trim() ? value : void 0;
}
function numberValue(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function extractStatusId(url) {
	try {
		return new URL(url).pathname.match(/\/status(?:es)?\/(\d+)/)?.[1];
	} catch {
		return;
	}
}
function readJsString(source, start) {
	const quote = source[start];
	if (quote !== "\"" && quote !== "'" && quote !== "`") return void 0;
	let value = "";
	for (let i = start + 1; i < source.length; i++) {
		const char = source[i];
		if (char === quote) return {
			value,
			end: i + 1
		};
		if (char !== "\\") {
			value += char;
			continue;
		}
		const escaped = source[++i];
		if (escaped === void 0) return void 0;
		const simpleEscapes = {
			b: "\b",
			f: "\f",
			n: "\n",
			r: "\r",
			t: "	",
			v: "\v",
			"0": "\0"
		};
		if (escaped in simpleEscapes) {
			value += simpleEscapes[escaped];
			continue;
		}
		if (escaped === "\n") continue;
		if (escaped === "\r") {
			if (source[i + 1] === "\n") i++;
			continue;
		}
		if (escaped === "x") {
			const hex = source.slice(i + 1, i + 3);
			if (!/^[0-9a-f]{2}$/i.test(hex)) return void 0;
			value += String.fromCodePoint(Number.parseInt(hex, 16));
			i += 2;
			continue;
		}
		if (escaped === "u") {
			if (source[i + 1] === "{") {
				const close = source.indexOf("}", i + 2);
				if (close === -1) return void 0;
				const hex = source.slice(i + 2, close);
				if (!/^[0-9a-f]{1,6}$/i.test(hex)) return void 0;
				const codePoint = Number.parseInt(hex, 16);
				if (codePoint > 1114111) return void 0;
				value += String.fromCodePoint(codePoint);
				i = close;
				continue;
			}
			const hex = source.slice(i + 1, i + 5);
			if (!/^[0-9a-f]{4}$/i.test(hex)) return void 0;
			value += String.fromCharCode(Number.parseInt(hex, 16));
			i += 4;
			continue;
		}
		value += escaped;
	}
}
function skipTrivia(source, start, limit = source.length) {
	let i = start;
	while (i < limit) {
		if (/\s/.test(source[i] ?? "")) {
			i++;
			continue;
		}
		if (source.startsWith("//", i)) {
			const newline = source.indexOf("\n", i + 2);
			return newline === -1 || newline >= limit ? limit : skipTrivia(source, newline + 1, limit);
		}
		if (source.startsWith("/*", i)) {
			const close = source.indexOf("*/", i + 2);
			return close === -1 || close + 2 > limit ? limit : skipTrivia(source, close + 2, limit);
		}
		break;
	}
	return i;
}
function scanBalanced(source, start) {
	const pairs = {
		"{": "}",
		"[": "]",
		"(": ")"
	};
	const first = source[start];
	if (!first || !(first in pairs)) return void 0;
	const expected = [pairs[first]];
	for (let i = start + 1; i < source.length; i++) {
		const char = source[i];
		if (char === "\"" || char === "'" || char === "`") {
			const token = readJsString(source, i);
			if (!token) return void 0;
			i = token.end - 1;
			continue;
		}
		if (source.startsWith("//", i) || source.startsWith("/*", i)) {
			const next = skipTrivia(source, i);
			if (next <= i || next >= source.length) return void 0;
			i = next - 1;
			continue;
		}
		if (char in pairs) {
			expected.push(pairs[char]);
			continue;
		}
		if (char === "}" || char === "]" || char === ")") {
			if (expected.pop() !== char) return void 0;
			if (expected.length === 0) return {
				start,
				end: i + 1
			};
		}
	}
}
function assignedObject(source, start, limit) {
	const pairs = {
		"[": "]",
		"(": ")"
	};
	const expected = [];
	for (let i = start; i < limit; i++) {
		const char = source[i];
		if (char === "\"" || char === "'" || char === "`") {
			const token = readJsString(source, i);
			if (!token) return void 0;
			i = token.end - 1;
			continue;
		}
		if (source.startsWith("//", i) || source.startsWith("/*", i)) {
			const next = skipTrivia(source, i, limit);
			if (next <= i || next >= limit) return void 0;
			i = next - 1;
			continue;
		}
		if (char === "{" && expected.length === 0) return scanBalanced(source, i);
		if (char in pairs) expected.push(pairs[char]);
		else if (char === "]" || char === ")") {
			if (expected.pop() !== char) return void 0;
		} else if (char === "," && expected.length === 0) return;
	}
}
function directProperty(source, range, name) {
	const closers = ["}"];
	const pairs = {
		"{": "}",
		"[": "]",
		"(": ")"
	};
	let i = range.start + 1;
	while (i < range.end - 1) {
		i = skipTrivia(source, i, range.end);
		const char = source[i];
		let key;
		let keyEnd = i;
		if (char === "\"" || char === "'" || char === "`") {
			const token = readJsString(source, i);
			if (!token) return void 0;
			if (closers.length === 1) key = token.value;
			keyEnd = token.end;
			i = token.end;
		} else if (char && /[A-Za-z_$]/.test(char)) {
			const match = source.slice(i, range.end).match(/^[A-Za-z_$][\w$]*/);
			if (!match) return void 0;
			if (closers.length === 1) key = match[0];
			keyEnd = i + match[0].length;
			i = keyEnd;
		} else {
			if (char && char in pairs) closers.push(pairs[char]);
			else if (char === "}" || char === "]" || char === ")") {
				if (closers.pop() !== char) return void 0;
			}
			i++;
			continue;
		}
		if (key !== name) continue;
		let valueStart = skipTrivia(source, keyEnd, range.end);
		if (source[valueStart] !== ":") continue;
		valueStart = skipTrivia(source, valueStart + 1, range.end);
		const valueChar = source[valueStart];
		if (valueChar === "\"" || valueChar === "'" || valueChar === "`") {
			const token = readJsString(source, valueStart);
			return token ? {
				type: "string",
				value: token.value
			} : void 0;
		}
		if (valueChar === "{") {
			const object = scanBalanced(source, valueStart);
			return object && object.end <= range.end ? {
				type: "object",
				...object
			} : void 0;
		}
		const assigned = assignedObject(source, valueStart, range.end);
		if (assigned && assigned.end <= range.end) return {
			type: "object",
			...assigned
		};
		const numberMatch = source.slice(valueStart, range.end).match(/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i);
		if (numberMatch) {
			const value = Number(numberMatch[0]);
			return Number.isFinite(value) ? {
				type: "number",
				value
			} : void 0;
		}
		return;
	}
}
function findSocialPostingRanges(script) {
	const ranges = [];
	const seen = /* @__PURE__ */ new Set();
	const delimiters = [];
	const pairs = {
		"{": "}",
		"[": "]",
		"(": ")"
	};
	for (let i = 0; i < script.length; i++) {
		const char = script[i];
		if (char === "\"" || char === "'" || char === "`") {
			const token = readJsString(script, i);
			if (!token) return ranges;
			if (token.value === "SocialMediaPosting") {
				let object;
				for (let j = delimiters.length - 1; j >= 0; j--) if (delimiters[j]?.char === "{") {
					object = delimiters[j];
					break;
				}
				if (object && !seen.has(object.start)) {
					const range = scanBalanced(script, object.start);
					if (range) {
						seen.add(object.start);
						ranges.push(range);
					}
				}
			}
			i = token.end - 1;
			continue;
		}
		if (script.startsWith("//", i) || script.startsWith("/*", i)) {
			const next = skipTrivia(script, i);
			if (next <= i || next >= script.length) break;
			i = next - 1;
			continue;
		}
		if (char in pairs) delimiters.push({
			char,
			start: i
		});
		else if (char === "}" || char === "]" || char === ")") {
			const opening = delimiters.pop();
			if (!opening || pairs[opening.char] !== char) return ranges;
		}
	}
	return ranges;
}
function propertyString(source, range, name) {
	const property = directProperty(source, range, name);
	return property?.type === "string" ? property.value : void 0;
}
function propertyNumber(source, range, name) {
	const property = directProperty(source, range, name);
	return property?.type === "number" ? property.value : void 0;
}
function postingMatchesStatus(script, range, statusId) {
	if (propertyString(script, range, "identifier") === statusId) return true;
	const id = propertyString(script, range, "@id");
	if (!id) return false;
	try {
		return new URL(id).pathname.match(/\/status(?:es)?\/(\d+)/)?.[1] === statusId;
	} catch {
		return false;
	}
}
function validVideoUrl(value) {
	if (/[\u0000-\u0020\u007f]/.test(value)) return void 0;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.hostname !== "video.twimg.com") return void 0;
		if (!url.pathname.toLowerCase().endsWith(".mp4") || url.pathname.toLowerCase().includes("hevc")) return void 0;
		return value;
	} catch {
		return;
	}
}
function validThumbnailUrl(value) {
	if (!value || /[\u0000-\u0020\u007f]/.test(value)) return void 0;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && url.hostname === "pbs.twimg.com" ? value : void 0;
	} catch {
		return;
	}
}
function parseDurationMillis(duration) {
	if (!duration) return void 0;
	const match = duration.match(/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
	if (!match || !match.slice(1).some(Boolean)) return void 0;
	const millis = ((Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)) * 60 + Number(match[3] ?? 0)) * 1e3;
	return Number.isFinite(millis) && millis >= 0 ? Math.round(millis) : void 0;
}
function extractXDirectVideo(html, statusId) {
	const { document } = parseHTML(html);
	for (const element of document.querySelectorAll("script:not([src])")) {
		const script = element.textContent ?? "";
		if (!script.includes(statusId) || !script.includes("video.twimg.com")) continue;
		for (const posting of findSocialPostingRanges(script)) {
			if (propertyString(script, posting, "@type") !== "SocialMediaPosting") continue;
			if (!postingMatchesStatus(script, posting, statusId)) continue;
			const video = directProperty(script, posting, "video");
			if (video?.type !== "object" || propertyString(script, video, "@type") !== "VideoObject") continue;
			const url = validVideoUrl(propertyString(script, video, "contentUrl") ?? "");
			if (!url) continue;
			return {
				type: new URL(url).pathname.includes("/tweet_video/") ? "gif" : "video",
				url,
				thumbnailUrl: validThumbnailUrl(propertyString(script, video, "thumbnailUrl")),
				durationMillis: parseDurationMillis(propertyString(script, video, "duration")),
				width: propertyNumber(script, video, "width"),
				height: propertyNumber(script, video, "height"),
				source: "json-ld"
			};
		}
	}
}
function renderDirectMedia(media) {
	const lines = [
		"## Direct media",
		"",
		`- ${media.type === "gif" ? "GIF" : "Video"} (MP4): ${media.url}`
	];
	if (media.thumbnailUrl) lines.push(`- Thumbnail: ${media.thumbnailUrl}`);
	if (media.durationMillis !== void 0) lines.push(`- Duration: ${media.durationMillis / 1e3} seconds`);
	if (media.width !== void 0 && media.height !== void 0) lines.push(`- Dimensions: ${media.width}×${media.height}`);
	return lines.join("\n");
}
function enrichXMarkdown(result, media) {
	if (result.markdown.includes(media.url)) return result;
	return {
		...result,
		markdown: `${result.markdown.trimEnd()}\n\n${renderDirectMedia(media)}`
	};
}
function extractInitialStateJson(script) {
	const start = script.indexOf("window.__INITIAL_STATE__=");
	if (start === -1) return void 0;
	const jsonStart = script.indexOf("{", start + 25);
	if (jsonStart === -1) return void 0;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = jsonStart; i < script.length; i++) {
		const char = script[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === "\"") inString = false;
			continue;
		}
		if (char === "\"") inString = true;
		else if (char === "{") depth++;
		else if (char === "}") {
			depth--;
			if (depth === 0) return script.slice(jsonStart, i + 1);
		}
	}
}
function parseInitialState(html) {
	const { document } = parseHTML(html);
	for (const script of document.querySelectorAll("script:not([src])")) {
		const json = extractInitialStateJson(script.textContent ?? "");
		if (!json) continue;
		try {
			const parsed = JSON.parse(json);
			return isObject(parsed) ? parsed : void 0;
		} catch {
			return;
		}
	}
}
function decodeHtmlEntities(text) {
	let result = text;
	for (let i = 0; i < 3; i++) {
		const decoded = result.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16))).replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10))).replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
		if (decoded === result) break;
		result = decoded;
	}
	return result;
}
function tweetMedia(tweet) {
	const extended = isObject(tweet.extended_entities) ? tweet.extended_entities : void 0;
	const entities = isObject(tweet.entities) ? tweet.entities : void 0;
	return Array.isArray(extended?.media) ? extended.media : Array.isArray(entities?.media) ? entities.media : [];
}
function bestMp4Variant(media) {
	const videoInfo = isObject(media.video_info) ? media.video_info : void 0;
	const variants = Array.isArray(videoInfo?.variants) ? videoInfo.variants : [];
	let best;
	for (const variant of variants) {
		if (!isObject(variant)) continue;
		const url = stringValue(variant.url);
		if (!url) continue;
		if (!((stringValue(variant.content_type) ?? "").includes("mp4") || url.includes(".mp4")) || url.includes("hevc")) continue;
		const bitrate = numberValue(variant.bitrate) ?? 0;
		if (!best || bitrate > best.bitrate) best = {
			url,
			bitrate
		};
	}
	return best?.url;
}
function markdownMedia(tweet) {
	const items = [];
	const seen = /* @__PURE__ */ new Set();
	for (const item of tweetMedia(tweet)) {
		if (!isObject(item)) continue;
		const mediaType = stringValue(item.type);
		const thumbnailUrl = stringValue(item.media_url_https) ?? stringValue(item.media_url);
		if (mediaType === "video" || mediaType === "animated_gif") {
			const url = bestMp4Variant(item);
			if (url && !seen.has(url)) {
				seen.add(url);
				items.push({
					type: mediaType === "animated_gif" ? "gif" : "video",
					url,
					thumbnailUrl
				});
			}
			continue;
		}
		if (thumbnailUrl && !seen.has(thumbnailUrl)) {
			seen.add(thumbnailUrl);
			items.push({
				type: "photo",
				url: thumbnailUrl
			});
		}
	}
	return items;
}
function formatStats(tweet) {
	const stats = [
		["Replies", numberValue(tweet.reply_count)],
		["Retweets", numberValue(tweet.retweet_count)],
		["Quotes", numberValue(tweet.quote_count)],
		["Likes", numberValue(tweet.favorite_count)]
	].filter((entry) => entry[1] !== void 0);
	if (stats.length === 0) return void 0;
	return stats.map(([label, value]) => `${label}: ${value}`).join(" · ");
}
function selectTweet(tweets, url) {
	const statusId = extractStatusId(url);
	if (statusId && isObject(tweets[statusId])) return tweets[statusId];
	return Object.values(tweets).find(isObject);
}
function renderTweetMarkdown(tweet, users) {
	const text = stringValue(tweet.full_text) ?? stringValue(tweet.text);
	if (!text) return void 0;
	const userId = stringValue(tweet.user);
	const user = userId ? users[userId] : void 0;
	const userObj = isObject(user) ? user : void 0;
	const name = stringValue(userObj?.name) ?? "Unknown author";
	const screenName = stringValue(userObj?.screen_name);
	const createdAt = stringValue(tweet.created_at);
	const stats = formatStats(tweet);
	const media = markdownMedia(tweet);
	let body = decodeHtmlEntities(text).replace(/\s+https:\/\/t\.co\/\S+\s*$/g, "").trim();
	if (!body) return void 0;
	const lines = [];
	lines.push(screenName ? `# Tweet by ${name} (@${screenName})` : `# Tweet by ${name}`);
	if (createdAt) lines.push("", `Posted: ${createdAt}`);
	if (stats) lines.push(stats);
	lines.push("", body);
	if (media.length > 0) {
		lines.push("", "Media:");
		for (const item of media) if (item.type === "video") {
			lines.push(`- Video: ${item.url}`);
			if (item.thumbnailUrl) lines.push(`  Thumbnail: ${item.thumbnailUrl}`);
		} else if (item.type === "gif") {
			lines.push(`- GIF: ${item.url}`);
			if (item.thumbnailUrl) lines.push(`  Thumbnail: ${item.thumbnailUrl}`);
		} else lines.push(`- ${item.url}`);
	}
	return lines.join("\n");
}
async function optimizeXHtml({ url, html, defaultProcess }) {
	const state = parseInitialState(html);
	const tweets = entitiesMap(state?.entities?.tweets);
	const users = entitiesMap(state?.entities?.users);
	const tweet = selectTweet(tweets, url);
	if (tweet) {
		const markdown = renderTweetMarkdown(tweet, users);
		if (markdown) return {
			markdown,
			scripts: [],
			method: "optimized"
		};
	}
	const statusId = extractStatusId(url);
	if (!statusId) return void 0;
	try {
		const media = extractXDirectVideo(html, statusId);
		if (!media) return void 0;
		return enrichXMarkdown(await defaultProcess(), media);
	} catch {
		return;
	}
}
//#endregion
//#region src/optimizers/index.ts
const BUILT_IN_OPTIMIZERS = [redditOptimizer, {
	id: "x",
	match(url) {
		try {
			return isXHost(new URL(url).hostname.toLowerCase());
		} catch {
			return false;
		}
	},
	async processHtml(input) {
		return optimizeXHtml(input);
	}
}];
function findOptimizer(url, config) {
	if (!config.optimizations) return void 0;
	return BUILT_IN_OPTIMIZERS.find((optimizer) => optimizer.match(url));
}
function applyFetchOptimizations(url, config) {
	const optimizer = findOptimizer(url, config);
	const cacheKey = optimizer?.cacheKey?.(url) ?? url;
	if (!optimizer?.rewriteUrl) return {
		url,
		cacheKey,
		optimizerId: optimizer?.id
	};
	const rewritten = optimizer.rewriteUrl(url);
	if (!rewritten || rewritten === url) return {
		url,
		cacheKey,
		optimizerId: optimizer.id
	};
	return {
		url: normalizeUrl(rewritten),
		cacheKey,
		optimizerId: optimizer.id
	};
}
async function fetchWithOptimizations(url, config, signal) {
	return findOptimizer(url, config)?.fetch?.({
		url,
		signal
	});
}
async function processHtmlWithOptimizations({ url, html, config, defaultProcess }) {
	const optimizer = findOptimizer(url, config);
	if (optimizer?.processHtml) {
		const optimized = await optimizer.processHtml({
			url,
			html,
			defaultProcess
		});
		if (optimized) return optimized;
	}
	return defaultProcess();
}
//#endregion
//#region src/tool.ts
function formatScriptIndex(scripts) {
	if (scripts.length === 0) return "";
	const width = String(scripts.reduce((m, s) => Math.max(m, s.length), 0)).length;
	const lines = scripts.map((s) => `  [${s.index}] ${String(s.length).padStart(width)} chars  ${s.preview}`);
	return [
		"",
		`Inline scripts (${scripts.length}, call webfetch with script=N to read full content):`,
		...lines
	].join("\n");
}
function formatTextResult(output, scripts) {
	const lines = [];
	lines.push(`URL: ${output.url}`);
	if (output.truncated) {
		const next = output.offset + output.returned_length;
		lines.push(`Offset: ${output.offset} / ${output.total_length} chars — truncated, call again with offset=${next}`);
	} else lines.push(`Length: ${output.total_length} chars`);
	lines.push("", "---", "", output.content);
	const scriptIndex = formatScriptIndex(scripts);
	if (scriptIndex) lines.push(scriptIndex);
	return lines.join("\n");
}
function formatScriptResult(url, scriptIndex, output) {
	const lines = [];
	lines.push(`URL: ${url} — script ${scriptIndex}`);
	if (output.truncated) {
		const next = output.offset + output.returned_length;
		lines.push(`Offset: ${output.offset} / ${output.total_length} chars — truncated, call again with offset=${next}`);
	} else lines.push(`Length: ${output.total_length} chars`);
	lines.push("", "---", "", output.content);
	return lines.join("\n");
}
function formatBinaryResult(output) {
	return [
		`BINARY FILE: ${output.file_path}`,
		`Content-Type: ${output.content_type}`,
		`URL: ${output.url}`
	].join("\n");
}
function formatRedirectResult(output) {
	return [`REDIRECT ${output.status_code}: ${output.original_url} → ${output.redirect_url}`, output.message].join("\n");
}
function registerWebFetchTool(pi, config) {
	const cache = new WebFetchCache(config.cache);
	pi.on("session_shutdown", async () => {
		cache.clear();
	});
	pi.registerTool({
		name: "webfetch",
		label: "Web Fetch",
		description: [
			"Fetch content from a URL and return it as Markdown text.",
			"Handles HTML extraction via Mozilla Readability and pagination for large pages.",
			"Inline scripts are listed in an index at the end — use the `script` parameter to read a specific one.",
			"Non-text content (images, PDFs, etc.) is saved to a local file and the path is returned.",
			"Cross-domain redirects are reported back so you can decide whether to follow them."
		].join(" "),
		promptSnippet: "Fetch and read web page content from a URL",
		promptGuidelines: [
			"Use webfetch to retrieve content from URLs instead of suggesting the user open a browser.",
			"For paginated results, increment `offset` by `returned_length` and call webfetch again until `truncated` is false.",
			"If the page has inline scripts listed at the end, use `script=N` to read one if it might contain relevant data.",
			"If webfetch returns a redirect result, call it again with the `redirect_url`."
		],
		parameters: Type.Object({
			url: Type.String({ description: "The URL to fetch." }),
			script: Type.Optional(Type.Number({ description: "Index of an inline script to read (from the script index at the end of a previous response). Supports the same `offset` and `max_length` pagination as normal page content." })),
			offset: Type.Optional(Type.Number({ description: "Starting character position for pagination. Defaults to 0." })),
			max_length: Type.Optional(Type.Number({ description: `Maximum characters to return in this call. Defaults to ${config.maxPageLength}.` }))
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { url, script: scriptIndex, offset = 0, max_length } = params;
			const maxLength = max_length ?? config.maxPageLength;
			let normalizedUrl;
			try {
				normalizedUrl = normalizeUrl(url);
			} catch {
				throw new Error(`Invalid URL: ${url}`);
			}
			const optimization = applyFetchOptimizations(normalizedUrl, config);
			normalizedUrl = optimization.url;
			const cacheKey = optimization.cacheKey;
			const tempDir = getBinaryTempDir();
			let entry = cache.get(cacheKey);
			if (!entry) {
				onUpdate?.({
					content: [{
						type: "text",
						text: `Fetching ${normalizedUrl}…`
					}],
					details: {}
				});
				const optimized = await fetchWithOptimizations(normalizedUrl, config, signal);
				if (optimized) {
					entry = {
						markdown: optimized.markdown,
						scripts: optimized.scripts,
						url: optimized.url
					};
					cache.set(cacheKey, entry, optimized.ttlMs);
				}
				if (!entry) {
					const result = await fetchUrl(normalizedUrl, tempDir, signal);
					if (result.type === "redirect") {
						const output = {
							redirect: true,
							original_url: result.originalUrl,
							redirect_url: result.redirectUrl,
							status_code: result.statusCode,
							message: "This URL redirects to a different domain. Call webfetch again with `redirect_url` to fetch the content."
						};
						return {
							content: [{
								type: "text",
								text: formatRedirectResult(output)
							}],
							details: output
						};
					}
					if (result.type === "binary") {
						const output = {
							file_path: result.filePath,
							content_type: result.contentType,
							url: result.url
						};
						return {
							content: [{
								type: "text",
								text: formatBinaryResult(output)
							}],
							details: output
						};
					}
					onUpdate?.({
						content: [{
							type: "text",
							text: "Processing content…"
						}],
						details: {}
					});
					if (result.contentType === "text/html") {
						const processed = await processHtmlWithOptimizations({
							url: normalizedUrl,
							html: result.content,
							config,
							defaultProcess: () => processHtml(result.content, normalizedUrl)
						});
						entry = {
							markdown: processed.markdown,
							scripts: processed.scripts,
							url: result.url
						};
					} else entry = {
						markdown: processPlainText(result.content),
						scripts: [],
						url: result.url
					};
					cache.set(cacheKey, entry);
				}
			}
			if (scriptIndex !== void 0) {
				const script = entry.scripts.find((s) => s.index === scriptIndex);
				if (!script) throw new Error(`Script ${scriptIndex} not found. Available indices: ${entry.scripts.map((s) => s.index).join(", ") || "none"}`);
				const total = script.content.length;
				const slice = script.content.slice(offset, offset + maxLength);
				const output = {
					content: slice,
					truncated: offset + maxLength < total,
					total_length: total,
					offset,
					returned_length: slice.length,
					url: entry.url
				};
				return {
					content: [{
						type: "text",
						text: formatScriptResult(entry.url, scriptIndex, output)
					}],
					details: output
				};
			}
			const totalLength = entry.markdown.length;
			const slice = entry.markdown.slice(offset, offset + maxLength);
			const output = {
				content: slice,
				truncated: offset + maxLength < totalLength,
				total_length: totalLength,
				offset,
				returned_length: slice.length,
				url: entry.url
			};
			return {
				content: [{
					type: "text",
					text: formatTextResult(output, entry.scripts)
				}],
				details: output
			};
		},
		renderCall(args, theme, context) {
			const text = context.lastComponent ?? new Text("", 0, 0);
			let line = theme.fg("toolTitle", theme.bold("webfetch "));
			line += theme.fg("accent", args.url ?? "");
			if (args.script !== void 0) line += theme.fg("muted", ` · script=${args.script}`);
			if (args.offset) line += theme.fg("dim", ` · offset=${args.offset}`);
			text.setText(line);
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = context.lastComponent ?? new Text("", 0, 0);
			if (options.isPartial) {
				text.setText(theme.fg("muted", "Fetching…"));
				return text;
			}
			if (context.isError || !result.details) {
				const raw = result.content.find((c) => c.type === "text")?.text ?? "";
				text.setText(theme.fg("error", raw));
				return text;
			}
			const details = result.details;
			if ("redirect" in details) {
				text.setText(theme.fg("warning", `↪ REDIRECT ${details.status_code}: `) + theme.fg("accent", details.redirect_url));
				return text;
			}
			if ("file_path" in details) {
				text.setText(theme.fg("success", "✓ ") + theme.fg("muted", details.content_type) + theme.fg("dim", ` → ${details.file_path}`));
				return text;
			}
			const allLines = details.content.split("\n");
			const maxLines = options.expanded ? allLines.length : 10;
			const displayLines = allLines.slice(0, maxLines);
			const remaining = allLines.length - maxLines;
			const header = theme.fg("dim", details.url) + (details.truncated ? theme.fg("muted", ` · ${details.returned_length.toLocaleString()} / ${details.total_length.toLocaleString()} chars`) : theme.fg("muted", ` · ${details.total_length.toLocaleString()} chars`));
			let body = "\n" + displayLines.map((l) => theme.fg("toolOutput", l)).join("\n");
			if (remaining > 0) body += theme.fg("muted", `\n… (${remaining} more lines, `) + keyHint("app.tools.expand", "to expand") + theme.fg("muted", ")");
			text.setText(header + body);
			return text;
		}
	});
}
//#endregion
//#region src/index.ts
/**
* WebFetch extension for pi coding agent.
*
* Registers the `webfetch` tool which fetches URLs and returns Markdown content.
*
* Features:
* - URL normalization (lowercase, http→https, strip default ports)
* - Same-domain redirect following; cross-domain redirects returned to LLM
* - Mozilla Readability for HTML → Markdown extraction
* - Inline script index — use `script=N` to read a specific inline script
* - LRU memory cache (50 MB, 15 min default TTL) with optimizer-specific cache keys/TTLs
* - Built-in fetch optimizations (enabled by default), including X/Twitter and Reddit extraction
* - Pagination via offset/max_length parameters
*/
function src_default(pi) {
	registerWebFetchTool(pi, loadWebFetchConfig(readMergedPiSettings()));
}
//#endregion
export { DEFAULT_CONFIG, src_default as default, loadWebFetchConfig, mergeConfig, registerWebFetchTool };
