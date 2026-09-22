/**
 * 本地复刻 react-markdown 的 defaultUrlTransform（迁移 streamdown 后不再依赖 react-markdown 包）：
 * 无协议/相对链接原样返回；非白名单协议清空（javascript:/data: 等危险协议被拦截）。
 * 白名单与 react-markdown 一致：http/https/irc/ircs/mailto/xmpp。
 */
const SAFE_PROTOCOL = /^(https?|ircs?|mailto|xmpp)$/i;

export function defaultUrlTransform(value: string): string {
	const colon = value.indexOf(":");
	const questionMark = value.indexOf("?");
	const numberSign = value.indexOf("#");
	const slash = value.indexOf("/");

	if (
		// 无协议：相对链接
		colon === -1 ||
		// 首个冒号在 ?/#// 之后：不是协议（如 ./a:b.ts、path?x=1:2）
		(slash !== -1 && colon > slash) ||
		(questionMark !== -1 && colon > questionMark) ||
		(numberSign !== -1 && colon > numberSign) ||
		// 是协议且在安全白名单内
		SAFE_PROTOCOL.test(value.slice(0, colon))
	) {
		return value;
	}
	return "";
}

/**
 * Markdown 内的链接默认会在 Electron 窗口内导航,这里拦截点击统一用系统浏览器打开。
 * 支持文件路径链接（file:// 协议）点击打开文件。
 */
export function markdownUrlTransform(url: string): string {
	// react-markdown 默认会清空 file:// 协议；这里只放行本地文件链接，普通外链仍使用默认安全过滤。
	return url.startsWith("file://") ? url : defaultUrlTransform(url);
}

/**
 * 裸文件路径识别正则（修复误判/特殊字符问题）：
 * - 排除空白 + ASCII 标点 + 全角标点/符号（，。；：！？、（）【】《》「」『』“”‘’·…—～￥×÷→←↑↓⇒／）
 * - 排除全角区（\u{FF00}-\u{FFEF}）、连字符/破折号区（\u{2010}-\u{2027}）、
 *   一般标点区（\u{2030}-\u{205E}）——避免 "src/a.ts，" 把全角逗号吞进路径
 * - 目录段与扩展名支持 Unicode 字母（中文/日文文件名）
 */
export const FILE_PATH_RE =
	/(?:file:\/\/|[A-Za-z]:[\\/]|(?:\.\.?[\\/]|[\\/])|(?:[\p{L}_][\p{L}\p{N}_.-]*[\\/])+)[^\s<>"'`|?*\[\](){}，。；：！？、（）【】《》「」『』“”‘’·…—～￥×÷→←↑↓⇒／\u{FF00}-\u{FFEF}\u{2010}-\u{2027}\u{2030}-\u{205E}]+\.[\p{L}\p{N}]+/gu;

/**
 * mdast 插件：把裸文件路径转成 file:// 链接。
 * 只处理 type === "text" 的叶子节点，天然跳过 code / inlineCode / link 内的文本。
 */
export const remarkLinkifyPaths = () => {
	return (tree: any) => {
		const visit = (node: any) => {
			if (!node || typeof node !== "object") return;
			const type: string = node.type;
			if (type === "code" || type === "inlineCode") return;
			if (type === "link") {
				// Capture the mdast destination before HTML URL encoding. File URLs must
				// still go through platform validation, not this raw-path escape hatch.
				if (typeof node.url === "string" && isLocalPathRef(node.url)) {
					node.data = { ...node.data, hProperties: { ...node.data?.hProperties, "data-local-path": node.url } };
				}
				return;
			}
			if (type === "text" && typeof node.value === "string") {
				const text: string = node.value;
				FILE_PATH_RE.lastIndex = 0;
				const segs: any[] = [];
				let last = 0;
				let m: RegExpExecArray | null;
				let touched = false;
				while ((m = FILE_PATH_RE.exec(text)) !== null) {
					const start = m.index;
					const end = start + m[0].length;
					if (start > last) segs.push({ type: "text", value: text.slice(last, start) });
					const rawPath = m[0];
					let linkUrl: string;
					if (rawPath.startsWith("file://")) {
						linkUrl = rawPath;
					} else if (/^[A-Za-z]:[\\/]/.test(rawPath)) {
						// Windows 盘符路径：如 R:\Temp\example.png -> file:///R:/Temp/example.png
						const normalized = rawPath.replace(/\\/g, "/");
						const drive = normalized.slice(0, 2);
						const rest = normalized.slice(2);
						const encodedRest = rest.split("/").map(encodeURIComponent).join("/");
						linkUrl = `file:///${drive}${encodedRest}`;
					} else if (rawPath.startsWith("/")) {
						// POSIX 绝对路径
						const encoded = rawPath.split("/").map(encodeURIComponent).join("/");
						linkUrl = `file://${encoded}`;
					} else {
						// 相对路径：保持相对形式，不带 file:// 避免被误认为 UNC 主机
						linkUrl = rawPath;
					}
					segs.push({
						type: "link",
						url: linkUrl,
						children: [{ type: "text", value: rawPath }],
						data: {
							hProperties: {
								// A file URI is not a disk path; keep its decoder/security checks.
								...(isLocalPathRef(rawPath) ? { "data-local-path": rawPath } : {}),
							},
						},
					});
					last = end;
					touched = true;
				}
				if (touched) {
					if (last < text.length) segs.push({ type: "text", value: text.slice(last) });
					node.__segs = segs;
				}
				return;
			}
			const children: any[] | undefined = node.children;
			if (Array.isArray(children)) {
				const next: any[] = [];
				for (const child of children) {
					visit(child);
					if (child && (child as any).__segs) {
						const segs = (child as any).__segs;
						delete (child as any).__segs;
						next.push(...segs);
					} else {
						next.push(child);
					}
				}
				node.children = next;
			}
		};
		visit(tree);
	};
};

/**
 * 判断是否为本地文件路径引用（无协议的相对/绝对路径）：
 * markdown 链接 [text](docs/guide.md) 的 href 无协议，此前被当作外链交给系统浏览器
 * 打开（打开方式错误/无法打开）——这里识别为本地路径，点击走 onOpenFile。
 */
export function isLocalPathRef(url: string): boolean {
	if (!url) return false;
	// Windows 盘符路径（D:\x 或 D:/x）→ 本地路径（先于协议判断，避免 D: 被当协议）
	if (/^[a-zA-Z]:[\\/]/.test(url)) return true;
	// 有协议（http/https/ftp/mailto/file/data/javascript 等）→ 外链
	if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return false;
	// 锚点 / 协议相对 URL → 不拦截（保持默认行为）
	if (url.startsWith("#") || url.startsWith("//")) return false;
	return true;
}
