import { createInterface } from "node:readline";

process.stdout._handle?.setBlocking?.(true);
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	const message = JSON.parse(line);
	process.stdout.write(`${JSON.stringify({
		id: message.id,
		type: "response",
		command: message.type,
		success: true,
		data: message.type === "prompt"
			? { text: message.message }
			: message.type === "abort"
				? { aborted: true }
				: { thinkingLevel: "off" },
	})}\n`);
});
