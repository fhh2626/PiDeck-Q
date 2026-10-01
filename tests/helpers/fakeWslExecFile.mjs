import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/**
 * 用宿主临时目录模拟 WSL 文件系统的 execFile mock。
 * Linux 路径 /a/b 映射到 <hostRoot>/a/b。只实现 SessionScanner 用到的少量命令，
 * 未实现的命令直接报错，避免测试在“假装成功”的 mock 上通过。
 */
export function createFakeWslExecFile(hostRoot) {
	const calls = [];
	const host = (linuxPath) => join(hostRoot, linuxPath);
	/** 递归收集目录下所有 *.jsonl，返回 Linux 风格绝对路径。 */
	const findJsonl = (linuxDir) => {
		const base = host(linuxDir);
		if (!existsSync(base) || !statSync(base).isDirectory()) return [];
		const found = [];
		const walk = (current) => {
			for (const entry of readdirSync(current, { withFileTypes: true })) {
				const absolute = join(current, entry.name);
				if (entry.isDirectory()) walk(absolute);
				else if (entry.name.endsWith(".jsonl")) {
					found.push(`/${relative(hostRoot, absolute).split(/[\\/]/).join("/")}`);
				}
			}
		};
		walk(base);
		return found;
	};
	const run = (argv) => {
		const [cmd, ...rest] = argv;
		if (cmd === "test") {
			const [flag, path] = rest;
			const p = host(path);
			const ok = flag === "-e" ? existsSync(p)
				: flag === "-f" ? existsSync(p) && statSync(p).isFile()
				: flag === "-d" ? existsSync(p) && statSync(p).isDirectory()
				: false;
			if (!ok) throw Object.assign(new Error("test failed"), { code: 1 });
			return "";
		}
		if (cmd === "stat") {
			// `stat -c "%Y %s" <path>`：mtime 秒 + 字节大小
			const path = rest[rest.length - 1];
			const info = statSync(host(path));
			return `${Math.floor(info.mtimeMs / 1000)} ${info.size}`;
		}
		if (cmd === "mkdir" && rest[0] === "-p") {
			mkdirSync(host(rest[1]), { recursive: true });
			return "";
		}
		if (cmd === "mv") {
			const flags = rest.filter((a) => a.startsWith("-"));
			const [src, dst] = rest.filter((a) => !a.startsWith("-"));
			// 不带 -T 时目标是已有目录会把源移进去嵌套一层；生产代码必须带 -T。
			if (!flags.includes("-T")) throw new Error("fake wsl: mv without -T is not allowed");
			// GNU mv -n 跳过时不报错，由调用方事后确认源已离开；mock 保持同样语义。
			if (flags.includes("-n") && existsSync(host(dst))) return "";
			// 与真实 mv 一致：目标父目录不存在时失败（不能替调用方建目录）。
			if (!existsSync(dirname(host(dst)))) throw Object.assign(new Error("mv: No such file or directory"), { code: 1 });
			renameSync(host(src), host(dst));
			return "";
		}
		if (cmd === "rm") {
			rmSync(host(rest[rest.length - 1]), { recursive: rest.includes("-rf"), force: true });
			return "";
		}
		if (cmd === "cat") return readFileSync(host(rest[0]), "utf8");
		if (cmd === "find") {
			// 只支持 `find <dir> -name "*.jsonl" -type f [-not -path <glob> ...]`
			const dir = rest[0];
			const patterns = [];
			for (let i = 0; i < rest.length; i++) {
				if (rest[i] === "-not" && rest[i + 1] === "-path") {
					patterns.push(rest[i + 2]);
					i += 2;
				}
			}
			// 把 shell glob 翻译成正则：`*` 匹配任意字符（含 /）。
			const exclusions = patterns.map((pattern) => {
				const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
				return new RegExp(`^${escaped}$`);
			});
			return findJsonl(dir)
				.filter((file) => !exclusions.some((rule) => rule.test(file)))
				.join("\n");
		}
		throw new Error(`fake wsl: unsupported command ${cmd}`);
	};
	const execFile = (_command, args, options, callback) => {
		const cb = typeof options === "function" ? options : callback;
		const argv = args.slice(4); // 去掉 -d <distro> -u <user>
		calls.push(argv);
		// dd of=<path>：内容从 stdin 写入，进程在 stdin 结束后才“退出”。
		if (argv[0] === "dd") {
			const target = argv.find((a) => a.startsWith("of="))?.slice(3);
			return {
				stdin: {
					end: (data) => {
						try {
							mkdirSync(dirname(host(target)), { recursive: true });
							writeFileSync(host(target), String(data ?? ""));
							queueMicrotask(() => cb(null, "", ""));
						} catch (error) {
							queueMicrotask(() => cb(error, "", ""));
						}
					},
				},
			};
		}
		try {
			const stdout = run(argv);
			queueMicrotask(() => cb(null, stdout, ""));
		} catch (error) {
			queueMicrotask(() => cb(error, "", ""));
		}
		return { stdin: null };
	};
	return { execFile, calls, host };
}
