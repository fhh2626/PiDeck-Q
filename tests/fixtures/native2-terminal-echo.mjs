process.stdout.write("READY\n");
try {
	if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);
} catch {}
process.stdin.on("data", (chunk) => {
	process.stdout.write(`OUT:${chunk}`);
});
