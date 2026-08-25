import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8"));

test("native package exposes a complete reproducible build chain", () => {
	assert.equal(packageJson.version, "0.1.5");
	assert.equal(packageLock.packages[""].version, packageJson.version);
	for (const script of ["build:renderer", "build:node", "build:native", "test", "typecheck", "dist:win"]) {
		assert.equal(typeof packageJson.scripts?.[script], "string", `missing npm script: ${script}`);
	}
	assert.equal(packageJson.main, undefined);
	const packageNames = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies });
	assert.deepEqual(packageNames.filter((name) => name.includes("electron")), []);
});
