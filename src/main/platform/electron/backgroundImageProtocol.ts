import { protocol } from "electron";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

const MIME_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".avif": "image/avif",
};

export function registerBackgroundImageProtocol(backgroundDirectory: string): void {
	protocol.handle("pideck-bg", async (request) => {
		try {
			const url = new URL(request.url);
			// 路径格式：pideck-bg://image/bg-12345.png
			const filename = url.pathname.replace(/^\/+/, "").replace(/^image\//, "");
			if (!/^bg-[a-zA-Z0-9.]+$/.test(filename)) {
				return new Response("Forbidden", { status: 403 });
			}
			const filePath = resolve(backgroundDirectory, filename);
			// 防路径穿越：解析后必须仍在 backgroundsDir 目录下
			const root = resolve(backgroundDirectory);
			if (!filePath.startsWith(root + sep) && filePath !== root) {
				return new Response("Forbidden", { status: 403 });
			}
			const ext = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")).toLowerCase() : "";
			const mime = MIME_TYPES[ext] ?? "application/octet-stream";
			const data = await readFile(filePath);
			return new Response(data, {
				status: 200,
				headers: {
					"Content-Type": mime,
					"Cache-Control": "public, max-age=86400",
				},
			});
		} catch {
			return new Response("Not Found", { status: 404 });
		}
	});
}
