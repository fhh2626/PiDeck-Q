import { join } from "node:path";

export function resolveBackgroundsDir(userDataDir: string): string {
	return join(userDataDir, "backgrounds");
}
