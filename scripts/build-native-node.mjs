import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const npmCli = process.env.npm_execpath
	?? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
await new Promise((resolve, reject) => {
	const child = spawn(process.execPath, [npmCli, "rebuild", "node-pty"], {
		stdio: "inherit",
		env: {
			...process.env,
			npm_config_runtime: "node",
			npm_config_target: "24.19.0",
		},
	});
	child.once("error", reject);
	child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`node-pty rebuild failed (${code})`)));
});

await rm("out/native-node", { recursive: true, force: true });
await mkdir("out/native-node", { recursive: true });

await build({
	entryPoints: ["src/native-node/index.ts"],
	outfile: "out/native-node/index.cjs",
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node24",
	packages: "external",
	external: ["node-pty", "sql.js", "sql.js/*", "undici"],
	logLevel: "info",
});
