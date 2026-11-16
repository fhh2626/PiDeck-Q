import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	rmdirSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { httpRequest, resolveBackendExecutable, startBackendSession } from "./helpers/native2BackendHarness.mjs";

const executable = resolveBackendExecutable();

// The Node filesystem domain is the behavioural oracle: the C++ backend must return
// the same tree, the same bytes and the same error text for the same inputs.
const { FileSystemService } = loadTsCommonJs(resolve("src/main/fs/FileSystemService.ts"));
const { registerFilesIpc } = loadTsCommonJs(resolve("src/main/ipc/filesIpc.ts"));
const { assertAuthorizedFilePath, UnauthorizedFilePathError } = loadTsCommonJs(
	resolve("src/main/fs/authorizedPaths.ts"),
);

const PROJECT_ID = "files";
// Isolated projects for the cases that mutate a tree a shared fixture must keep clean.
const LIST_LINK_PROJECT_ID = "files-list-link";
const NESTED_LINK_PROJECT_ID = "files-nested-link";
const READONLY_PROJECT_ID = "files-readonly";
const INNER_FAILURE_PROJECT_ID = "files-inner-failure";
const COPY_EXTERNAL_LINK_PROJECT_ID = "files-copy-external-link";
const COPY_EXTERNAL_SELF_PROJECT_ID = "files-copy-external-self";

function writeTree(root) {
	mkdirSync(join(root, "src"), { recursive: true });
	mkdirSync(join(root, "empty"), { recursive: true });
	writeFileSync(join(root, "readme.md"), "# readme\n");
	writeFileSync(join(root, "src", "index.ts"), "export const value = 1;\n");
	writeFileSync(join(root, "binary.bin"), Buffer.from([0x00, 0xff, 0x10, 0x7f]));
	writeFileSync(join(root, ".hidden"), "hidden\n");
}

/** Normalize the wire form: absolute Windows paths use forward slashes. */
function normalize(value) {
	return normalizePaths(JSON.parse(JSON.stringify(value ?? null)));
}

function normalizePaths(value) {
	if (typeof value === "string") {
		return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\") ? value.replaceAll("\\", "/") : value;
	}
	if (Array.isArray(value)) return value.map(normalizePaths);
	if (value && typeof value === "object") {
		const result = {};
		for (const [key, entry] of Object.entries(value)) result[key] = normalizePaths(entry);
		return result;
	}
	return value;
}

async function expectReject(promise) {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("expected the oracle to reject");
}

/** Run the Node move channel against its own tree as the permission-behavior oracle. */
function oracleMoveHandler(root) {
	const handlers = new Map();
	registerFilesIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, {
		fileSystemService: {}, projectStore: {}, settingsStore: { get: () => ({ wslEnabled: false }) },
		appLogger: { info() {}, error() {} }, dialogs: {}, platformShell: {},
		getAuthorizedRoots: () => [root], mainCopy: (key) => key,
	});
	return handlers.get("files:move");
}

/** Restore permissions even when a move fails and leaves both source and copied tree. */
function restoreReadonlyTree(root) {
	for (const directory of [root, join(root, "ro-dir"), join(root, "target"), join(root, "target", "ro-dir")]) {
		if (existsSync(directory)) chmodSync(directory, 0o755);
	}
	for (const file of ["ro.txt", "ro-dir/inner.txt", "target/ro.txt", "target/ro-dir/inner.txt"]) {
		const path = join(root, file);
		if (existsSync(path)) chmodSync(path, 0o644);
	}
}

if (executable) {
	describe("native2 files domain parity", () => {
		let root;
		let projectPath;
		let session;
		let oracle;
		const trashCalls = [];

		before(async () => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-files-"));
			projectPath = join(root, "project");
			writeTree(projectPath);
			oracle = new FileSystemService(async (targetPath) => {
				trashCalls.push(targetPath);
			});
		});

		after(() => {
			if (root) rmSync(root, { recursive: true, force: true });
		});

		// One backend per test keeps the trash recorder and the file mutations isolated.
		const start = async (t) => {
			session = await startBackendSession(t, {
				projects: [{ id: PROJECT_ID, path: projectPath }],
				// Pin the copy language so the localized main-process strings are stable.
				settings: { language: "en-US" },
			});
			return session;
		};

		test("files:list matches the Node tree for the same project", async (t) => {
			const { invoke } = await start(t);
			const expected = normalize(await oracle.listTree(projectPath));
			const actual = await invoke("files:list", [PROJECT_ID]);
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			assert.deepEqual(normalize(actual.payload.result), expected);
			assert.ok(actual.payload.result.length > 0);
		});

		test("files:list keeps the filesystem's fractional millisecond timestamps", async (t) => {
			const precisionProject = join(root, "precision-project");
			mkdirSync(precisionProject);
			const filePath = join(precisionProject, "precise.txt");
			writeFileSync(filePath, "timestamp precision\n");
			utimesSync(filePath, 1_767_225_600.123456, 1_767_225_600.123456);
			const metadata = statSync(filePath);
			const session = await startBackendSession(t, {
				projects: [{ id: "file-precision", path: precisionProject }],
			});
			const actual = await session.invoke("files:list", ["file-precision"]);
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			assert.equal(actual.payload.result.length, 1);
			assert.equal(actual.payload.result[0].mtimeMs, metadata.mtimeMs);
			assert.equal(actual.payload.result[0].ctimeMs, metadata.ctimeMs);
		});

		test("files:list rejects an unknown project id", async (t) => {
			const { invoke } = await start(t);
			const actual = await invoke("files:list", ["missing"]);
			assert.equal(actual.payload.ok, false);
			assert.equal(actual.payload.error.message, "Project not found: missing");
		});

		test("files:read-content matches the Node read, its ENOENT fallback and the size guard", async (t) => {
			const { invoke } = await start(t);
			const target = join(projectPath, "readme.md");
			const actual = await invoke("files:read-content", [target]);
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			assert.equal(actual.payload.result, readFileSync(target, "utf8"));

			const missing = await invoke("files:read-content", [join(projectPath, "nope.txt")]);
			assert.equal(missing.payload.ok, true);
			assert.equal(missing.payload.result, "");

			const tooLarge = await invoke("files:read-content", [target, 4]);
			assert.equal(tooLarge.payload.ok, false);
			const size = readFileSync(target).length;
			assert.equal(tooLarge.payload.error.message, `FILE_TOO_LARGE:${size}:4`);
		});

		test("files:read-base64 matches the Node encoder byte for byte", async (t) => {
			const { invoke } = await start(t);
			const target = join(projectPath, "binary.bin");
			const actual = await invoke("files:read-base64", [target]);
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			assert.equal(actual.payload.result, readFileSync(target).toString("base64"));

			const capped = await invoke("files:read-base64", [target, 2]);
			assert.equal(capped.payload.ok, false);
			assert.match(capped.payload.error.message, /FILE_TOO_LARGE:4:2/);
		});

		test("files:write-content writes the exact bytes the Node writer would", async (t) => {
			const { invoke } = await start(t);
			const target = join(projectPath, "written.txt");
			const actual = await invoke("files:write-content", [target, "line one\nline two\n"]);
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			assert.equal(actual.payload.result, null);
			assert.equal(readFileSync(target, "utf8"), "line one\nline two\n");
		});

		test("files:create makes files and directories and refuses an existing entry", async (t) => {
			const { invoke } = await start(t);
			const created = await invoke("files:create", [projectPath, "created.txt", "file"]);
			assert.equal(created.payload.ok, true, JSON.stringify(created.payload));
			assert.equal(normalize(created.payload.result), normalize(join(projectPath, "created.txt")));
			assert.ok(existsSync(join(projectPath, "created.txt")));

			const folder = await invoke("files:create", [projectPath, "created-dir", "directory"]);
			assert.equal(folder.payload.ok, true);
			assert.ok(existsSync(join(projectPath, "created-dir")));

			const duplicate = await invoke("files:create", [projectPath, "created.txt", "file"]);
			assert.equal(duplicate.payload.ok, false);
			assert.match(duplicate.payload.error.message, /already exists|EEXIST/i);
		});

		test("files:rename renames an entry and reports the localized target-exists message", async (t) => {
			const { invoke } = await start(t);
			const source = join(projectPath, "readme.md");
			const renamed = await invoke("files:rename", [source, "readme-renamed.md"]);
			assert.equal(renamed.payload.ok, true, JSON.stringify(renamed.payload));
			assert.equal(normalize(renamed.payload.result), normalize(join(projectPath, "readme-renamed.md")));
			assert.ok(existsSync(join(projectPath, "readme-renamed.md")));
			assert.ok(!existsSync(source));

			writeFileSync(join(projectPath, "occupied.md"), "occupied\n");
			const conflict = await invoke("files:rename", [join(projectPath, "readme-renamed.md"), "occupied.md"]);
			assert.equal(conflict.payload.ok, false);
			assert.equal(conflict.payload.error.message, "A file or folder with that name already exists. Nothing was renamed.");
			assert.equal(readFileSync(join(projectPath, "occupied.md"), "utf8"), "occupied\n");
		});

		test("files:copy auto-renames instead of overwriting and refuses a directory into itself", async (t) => {
			const { invoke } = await start(t);
			const source = join(projectPath, "src", "index.ts");
			const first = await invoke("files:copy", [[source], join(projectPath, "empty")]);
			assert.equal(first.payload.ok, true, JSON.stringify(first.payload));
			assert.equal(normalize(first.payload.result[0]), normalize(join(projectPath, "empty", "index.ts")));

			const second = await invoke("files:copy", [[source], join(projectPath, "empty")]);
			assert.equal(second.payload.ok, true, JSON.stringify(second.payload));
			assert.equal(normalize(second.payload.result[0]), normalize(join(projectPath, "empty", "index (1).ts")));
			assert.equal(readFileSync(join(projectPath, "empty", "index (1).ts"), "utf8"), "export const value = 1;\n");

			const selfCopy = await invoke("files:copy", [[join(projectPath, "src")], join(projectPath, "src")]);
			assert.equal(selfCopy.payload.ok, false);
			assert.equal(selfCopy.payload.error.message, "Cannot copy a directory into itself");
		});

		test("files:copy streams a multi-block file byte for byte", async (t) => {
			// The copy now streams in bounded blocks (fsops::copyFileContents) so a failed
			// write can be detected; a payload that spans several blocks plus a partial tail
			// must still arrive complete.
			const { invoke } = await start(t);
			const payload = Buffer.alloc(2 * 1024 * 1024 + 7);
			for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 31) % 251;
			const source = join(projectPath, "big.bin");
			writeFileSync(source, payload);

			const copied = await invoke("files:copy", [[source], join(projectPath, "empty")]);
			assert.equal(copied.payload.ok, true, JSON.stringify(copied.payload));
			assert.equal(normalize(copied.payload.result[0]), normalize(join(projectPath, "empty", "big.bin")));
			const written = readFileSync(join(projectPath, "empty", "big.bin"));
			assert.equal(written.length, payload.length, "the whole file must be copied");
			assert.ok(written.equals(payload), "the copied bytes must match the source");
			assert.ok(existsSync(source), "copy never removes the source");
		});

		test("files:move copies then removes and refuses to overwrite a destination", async (t) => {
			const { invoke } = await start(t);
			const source = join(projectPath, "written.txt");
			const moved = await invoke("files:move", [[source], join(projectPath, "empty")]);
			assert.equal(moved.payload.ok, true, JSON.stringify(moved.payload));
			assert.equal(normalize(moved.payload.result[0]), normalize(join(projectPath, "empty", "written.txt")));
			assert.ok(!existsSync(source));

			// Re-create the source name at the destination root so the move collides.
			writeFileSync(join(projectPath, "written.txt"), "collide\n");
			const conflict = await invoke("files:move", [[join(projectPath, "empty", "written.txt")], join(projectPath)]);
			assert.equal(conflict.payload.ok, false);
			assert.match(conflict.payload.error.message, /Destination already exists/);
			assert.equal(readFileSync(join(projectPath, "written.txt"), "utf8"), "collide\n");
		});

		test("files:move moves an absolute directory junction as a link and never traverses it", async (t) => {
			// The referent lives outside the project: copying the link must not read, copy or
			// delete anything behind it. Windows junctions need no privilege, so this stays
			// testable on a machine without Developer Mode.
			const referent = join(root, "junction-referent");
			mkdirSync(referent, { recursive: true });
			writeFileSync(join(referent, "keep.txt"), "keep\n");
			const source = join(projectPath, "moved-junction");
			try {
				symlinkSync(referent, source, "junction");
			} catch (error) {
				t.skip(`junction creation is not permitted on this machine (${error.code})`);
				return;
			}
			const destinationDir = join(projectPath, "junction-target");
			mkdirSync(destinationDir, { recursive: true });
			const { invoke } = await start(t);
			const moved = await invoke("files:move", [[source], destinationDir]);
			assert.equal(moved.payload.ok, true, JSON.stringify(moved.payload));
			const destination = join(destinationDir, "moved-junction");
			assert.equal(normalize(moved.payload.result[0]), normalize(destination));
			// The entry stays a link that resolves to the same directory...
			assert.ok(lstatSync(destination).isSymbolicLink(), "the moved entry must still be a link");
			assert.ok(statSync(destination).isDirectory(), "the moved link must resolve to its directory");
			assert.equal(normalize(readlinkSync(destination)), normalize(referent));
			// ...the source link is gone, and the referent is untouched (no traversal).
			assert.ok(!existsSync(source));
			assert.equal(readFileSync(join(referent, "keep.txt"), "utf8"), "keep\n");
		});

		test("files:copy advances past a dangling link instead of failing the whole copy", async (t) => {
			// A dangling link is an existing entry (lstat), so the free-name loop must skip
			// that candidate: only a top-level collision is retried, everything else aborts.
			const targetDir = join(projectPath, "free-name-diverted");
			mkdirSync(targetDir, { recursive: true });
			writeFileSync(join(targetDir, "index.ts"), "occupied\n");
			const goneDir = join(root, "gone-copy-dir");
			mkdirSync(goneDir, { recursive: true });
			const dangling = join(targetDir, "index (1).ts");
			try {
				symlinkSync(goneDir, dangling, "junction");
				rmdirSync(goneDir);
			} catch (error) {
				t.skip(`junction creation is not permitted on this machine (${error.code})`);
				return;
			}
			assert.ok(lstatSync(dangling).isSymbolicLink(), "the fixture entry must be a link");
			assert.throws(() => statSync(dangling), "the fixture link must be dangling");

			const { invoke } = await start(t);
			const copied = await invoke("files:copy", [[join(projectPath, "src", "index.ts")], targetDir]);
			assert.equal(copied.payload.ok, true, JSON.stringify(copied.payload));
			assert.equal(normalize(copied.payload.result[0]), normalize(join(targetDir, "index (2).ts")));
			assert.equal(readFileSync(join(targetDir, "index.ts"), "utf8"), "occupied\n");
			assert.equal(readFileSync(join(targetDir, "index (2).ts"), "utf8"), "export const value = 1;\n");
			// The dangling link is a pre-existing entry: never clobbered, never removed.
			assert.ok(lstatSync(dangling).isSymbolicLink());
		});

		test("files:copy and files:move preserve the source file and directory times", async (t) => {
			// Node copies the bytes and then restores atime/mtime, so a copied tree keeps the
			// source timestamps instead of the copy time.
			const stamp = new Date("2020-02-02T02:02:02.000Z");
			const stampMs = stamp.getTime();
			const sourceFile = join(projectPath, "stamped.txt");
			writeFileSync(sourceFile, "stamped\n");
			utimesSync(sourceFile, stamp, stamp);
			const sourceDir = join(projectPath, "stamped-dir");
			mkdirSync(sourceDir, { recursive: true });
			const innerFile = join(sourceDir, "inner.txt");
			writeFileSync(innerFile, "inner\n");
			utimesSync(innerFile, stamp, stamp);
			utimesSync(sourceDir, stamp, stamp);

			const { invoke } = await start(t);
			const copyTarget = join(projectPath, "stamp-copy");
			mkdirSync(copyTarget, { recursive: true });
			const copiedFile = await invoke("files:copy", [[sourceFile], copyTarget]);
			assert.equal(copiedFile.payload.ok, true, JSON.stringify(copiedFile.payload));
			assert.equal(statSync(join(copyTarget, "stamped.txt")).mtimeMs, stampMs, "copied file mtime");

			const copiedDir = await invoke("files:copy", [[sourceDir], copyTarget]);
			assert.equal(copiedDir.payload.ok, true, JSON.stringify(copiedDir.payload));
			assert.equal(statSync(join(copyTarget, "stamped-dir")).mtimeMs, stampMs, "copied directory mtime");
			assert.equal(statSync(join(copyTarget, "stamped-dir", "inner.txt")).mtimeMs, stampMs, "copied nested mtime");

			const moveTarget = join(projectPath, "stamp-move");
			mkdirSync(moveTarget, { recursive: true });
			const movedDir = await invoke("files:move", [[sourceDir], moveTarget]);
			assert.equal(movedDir.payload.ok, true, JSON.stringify(movedDir.payload));
			assert.equal(statSync(join(moveTarget, "stamped-dir")).mtimeMs, stampMs, "moved directory mtime");
			assert.equal(statSync(join(moveTarget, "stamped-dir", "inner.txt")).mtimeMs, stampMs, "moved nested mtime");
		});

		test("files:delete moves the entry to the recycle bin instead of unlinking it", async (t) => {
			const { invoke, trashCalls: recorded } = await start(t);
			const target = join(projectPath, "binary.bin");
			const actual = await invoke("files:delete", [target]);
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			assert.equal(actual.payload.result, null);
			assert.deepEqual(normalize(recorded), [normalize(target)]);
			// The fake host only records the call, so the file must still exist: a hard
			// unlink would be a contract violation.
			assert.ok(existsSync(target));
		});

		test("every file channel rejects a path outside the authorized roots", async (t) => {
			const { invoke } = await start(t);
			const outside = join(root, "outside.txt");
			writeFileSync(outside, "outside\n");
			const oracleMessage = await expectReject(
				assertAuthorizedFilePath(outside, [projectPath], "read", "read"),
			);
			assert.ok(oracleMessage.includes("not authorized"));

			for (const [channel, args] of [
				["files:read-content", [outside]],
				["files:read-base64", [outside]],
				["files:write-content", [outside, "x"]],
				["files:delete", [outside]],
				["files:create", [root, "escape.txt", "file"]],
				["files:rename", [outside, "renamed.txt"]],
				["files:copy", [[outside], projectPath]],
				["files:move", [[outside], projectPath]],
			]) {
				const actual = await invoke(channel, args);
				assert.equal(actual.payload.ok, false, `${channel} must reject ${outside}`);
				assert.match(actual.payload.error.message, /not authorized/i, `${channel}: ${actual.payload.error.message}`);
			}
		});

		test("a symlink leaf is never read or written, matching the Node guard", async (t) => {
			const outside = join(root, "secret.txt");
			writeFileSync(outside, "secret\n");
			const link = join(projectPath, "link.txt");
			try {
				symlinkSync(outside, link, "file");
			} catch {
				t.skip("symlink creation requires Developer Mode or elevation on this machine");
				return;
			}
			const oracleMessage = await expectReject(
				assertAuthorizedFilePath(link, [projectPath], "read", "read"),
			);
			assert.ok(oracleMessage.includes("not authorized"));

			const { invoke } = await start(t);
			const read = await invoke("files:read-content", [link]);
			assert.equal(read.payload.ok, false);
			assert.match(read.payload.error.message, /not authorized/i);
			assert.equal(readFileSync(outside, "utf8"), "secret\n");
		});

		test("a directory junction cannot redirect a read outside the project", async (t) => {
			const outsideDir = join(root, "outside-dir");
			mkdirSync(outsideDir, { recursive: true });
			writeFileSync(join(outsideDir, "escape.txt"), "escaped\n");
			const junction = join(projectPath, "junction");
			try {
				// Junctions do not require the symlink privilege, so this escape attempt is
				// testable on every Windows machine.
				symlinkSync(outsideDir, junction, "junction");
			} catch {
				t.skip("junction creation is not permitted on this machine");
				return;
			}
			const target = join(junction, "escape.txt");
			const oracleMessage = await expectReject(
				assertAuthorizedFilePath(target, [projectPath], "read", "read"),
			);
			assert.ok(oracleMessage.includes("not authorized"));

			const { invoke } = await start(t);
			const read = await invoke("files:read-content", [target]);
			assert.equal(read.payload.ok, false);
			assert.match(read.payload.error.message, /not authorized/i);
			const write = await invoke("files:write-content", [target, "overwritten\n"]);
			assert.equal(write.payload.ok, false);
			assert.match(write.payload.error.message, /not authorized/i);
			assert.equal(readFileSync(join(outsideDir, "escape.txt"), "utf8"), "escaped\n");
		});

		test("files:read-base64-external fails closed without a live capability", async (t) => {
			const { invoke } = await start(t);
			const actual = await invoke("files:read-base64-external", ["forged", join(root, "outside.txt"), 1024]);
			assert.equal(actual.payload.ok, false);
			assert.equal(
				actual.payload.error.message,
				"The external file capability is missing, expired, or does not include this path.",
			);
		});

		test("files:read-base64-external redeems a host-issued clipboard capability", async (t) => {
			const outside = join(root, "clipboard.txt");
			writeFileSync(outside, "clipboard payload\n");
			// The clipboard is a trusted OS boundary: the host reports the paths and the
			// backend issues a capability the renderer redeems instead of a raw path.
			const { invoke, baseUrl, token } = await startBackendSession(t, {
				projects: [{ id: PROJECT_ID, path: projectPath }],
				settings: { language: "en-US" },
				hostHandlers: {
					"clipboard.metadataSnapshot": () => ({
						result: { text: "", html: "", filePaths: [outside], hasImage: false, sequence: 11 },
					}),
				},
			});
			const bootstrap = JSON.parse(
				(await httpRequest(`${baseUrl}__pideck/bootstrap`, { headers: { "x-pideck-token": token } })).body,
			);
			const capabilityId = bootstrap.clipboard.externalFileCapabilityId;
			assert.equal(typeof capabilityId, "string");
			assert.deepEqual(normalize(bootstrap.clipboard.filePaths), [normalize(outside)]);

			const read = await invoke("files:read-base64-external", [capabilityId, outside, 1024]);
			assert.equal(read.payload.ok, true, JSON.stringify(read.payload));
			assert.equal(read.payload.result, Buffer.from("clipboard payload\n").toString("base64"));

			// A clipboard capability stays reusable for the same sequence.
			const again = await invoke("files:read-base64-external", [capabilityId, outside, 1024]);
			assert.equal(again.payload.ok, true, JSON.stringify(again.payload));

			// The renderer path is only a selector: a path outside the capability fails.
			const other = join(root, "other.txt");
			writeFileSync(other, "other\n");
			const denied = await invoke("files:read-base64-external", [capabilityId, other, 1024]);
			assert.equal(denied.payload.ok, false);
			assert.equal(
				denied.payload.error.message,
				"The external file capability is missing, expired, or does not include this path.",
			);
		});

		test("files:list skips a directory junction exactly like the Node dirent tree", async (t) => {
			// The oracle builds its tree from `readdir(withFileTypes)`, where a Windows junction
			// is neither a directory nor a file (Node reports it as a link), so it never appears
			// and its referent is never walked. Qt reports a junction as a plain directory
			// (`QFileInfo::isSymLink()` is false), so a `isSymLink()`-only filter listed the
			// junction as a directory and recursed into content that lives outside the project.
			const listProject = join(root, "list-link-project");
			const outsideDir = join(root, "list-link-outside");
			mkdirSync(join(listProject, "src"), { recursive: true });
			mkdirSync(join(outsideDir, "deep"), { recursive: true });
			writeFileSync(join(listProject, "readme.md"), "# readme\n");
			writeFileSync(join(listProject, "src", "index.ts"), "export const value = 1;\n");
			writeFileSync(join(outsideDir, "escape.txt"), "escaped\n");
			writeFileSync(join(outsideDir, "deep", "deeper.txt"), "deeper\n");
			try {
				// Junctions need no privilege, so this case runs on every Windows machine.
				symlinkSync(outsideDir, join(listProject, "linked"), "junction");
			} catch (error) {
				t.skip(`junction creation is not permitted on this machine (${error.code})`);
				return;
			}
			const session = await startBackendSession(t, {
				projects: [{ id: LIST_LINK_PROJECT_ID, path: listProject }],
				settings: { language: "en-US" },
			});
			const expected = normalize(await oracle.listTree(listProject));
			const actual = await session.invoke("files:list", [LIST_LINK_PROJECT_ID]);
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			assert.deepEqual(normalize(actual.payload.result), expected);
			assert.equal(
				JSON.stringify(actual.payload.result).includes("escape.txt"),
				false,
				`the referent must not be listed through the junction: ${JSON.stringify(actual.payload.result)}`,
			);
		});

		test("files:move preserves a directory link nested inside the moved directory", async (t) => {
			// Oracle parity: `fs.rm(recursive, force)` lstats every entry, so the junction is
			// unlinked *as a link* and the directory it points at keeps its whole content.
			// `QDir::removeRecursively()` classifies a junction as a directory (Qt reports
			// `isSymLink() == false` for it) and deleted the referent's content file by file —
			// irreversible data loss on a path outside the project, reported as a success.
			const moveProject = join(root, "nested-link-project");
			const referent = join(root, "nested-link-outside");
			mkdirSync(join(moveProject, "source", "nested"), { recursive: true });
			mkdirSync(join(moveProject, "target"), { recursive: true });
			mkdirSync(join(referent, "inner"), { recursive: true });
			writeFileSync(join(moveProject, "source", "nested", "copy.txt"), "copy\n");
			writeFileSync(join(referent, "keep.txt"), "keep\n");
			writeFileSync(join(referent, "inner", "deep.txt"), "deep\n");
			try {
				symlinkSync(referent, join(moveProject, "source", "linked"), "junction");
			} catch (error) {
				t.skip(`junction creation is not permitted on this machine (${error.code})`);
				return;
			}
			const session = await startBackendSession(t, {
				projects: [{ id: NESTED_LINK_PROJECT_ID, path: moveProject }],
				settings: { language: "en-US" },
			});
			const moved = await session.invoke("files:move", [
				[join(moveProject, "source")],
				join(moveProject, "target"),
			]);
			assert.equal(moved.payload.ok, true, JSON.stringify(moved.payload));
			// The referent is untouched: every file behind the link still exists.
			assert.equal(readFileSync(join(referent, "keep.txt"), "utf8"), "keep\n");
			assert.equal(readFileSync(join(referent, "inner", "deep.txt"), "utf8"), "deep\n");
			// The moved copy is a link to the same referent, the rest of the tree moved, and the
			// source tree (including the link itself) is gone.
			const destination = join(moveProject, "target", "source");
			assert.ok(lstatSync(join(destination, "linked")).isSymbolicLink(), "the copied entry must still be a link");
			assert.equal(normalize(readlinkSync(join(destination, "linked"))), normalize(referent));
			assert.equal(readFileSync(join(destination, "nested", "copy.txt"), "utf8"), "copy\n");
			assert.ok(!existsSync(join(moveProject, "source")), "the source tree must be removed");
		});

		test("files:move removes a read-only source instead of failing after the copy", {
			skip: process.platform !== "win32" && "Windows read-only attribute retry",
		}, async (t) => {
			// Oracle parity: `fs.rm(recursive, force)` runs rimraf's `fixWinEPERM`, which clears
			// the read-only attribute and retries. A bare `DeleteFileW`/`RemoveDirectoryW` fails
			// with ERROR_ACCESS_DENIED, so the move threw *after* the destination copy existed and
			// left both a source and a stray read-only copy behind.
			const readonlyProject = join(root, "readonly-project");
			t.after(() => restoreReadonlyTree(readonlyProject));
			mkdirSync(join(readonlyProject, "target"), { recursive: true });
			const sourceFile = join(readonlyProject, "ro.txt");
			writeFileSync(sourceFile, "x\n");
			chmodSync(sourceFile, 0o444);
			const sourceDir = join(readonlyProject, "ro-dir");
			mkdirSync(sourceDir, { recursive: true });
			writeFileSync(join(sourceDir, "inner.txt"), "inner\n");
			chmodSync(join(sourceDir, "inner.txt"), 0o444);
			chmodSync(sourceDir, 0o555);
			const session = await startBackendSession(t, {
				projects: [{ id: READONLY_PROJECT_ID, path: readonlyProject }],
				settings: { language: "en-US" },
			});
			const targetDir = join(readonlyProject, "target");
			const movedFile = await session.invoke("files:move", [[sourceFile], targetDir]);
			assert.equal(movedFile.payload.ok, true, JSON.stringify(movedFile.payload));
			assert.ok(!existsSync(sourceFile), "the read-only source file must be gone");
			assert.equal(readFileSync(join(targetDir, "ro.txt"), "utf8"), "x\n");
			const movedDir = await session.invoke("files:move", [[sourceDir], targetDir]);
			assert.equal(movedDir.payload.ok, true, JSON.stringify(movedDir.payload));
			assert.ok(!existsSync(sourceDir), "the read-only source directory must be gone");
			assert.equal(readFileSync(join(targetDir, "ro-dir", "inner.txt"), "utf8"), "inner\n");
		});

		test("files:move matches the Node channel for POSIX read-only entries", {
			skip: process.platform === "win32" && "POSIX directory permissions",
		}, async (t) => {
			const createReadonlyTree = (name) => {
				const directory = join(root, name);
				mkdirSync(join(directory, "target"), { recursive: true });
				mkdirSync(join(directory, "ro-dir"));
				writeFileSync(join(directory, "ro.txt"), "x\n");
				writeFileSync(join(directory, "ro-dir", "inner.txt"), "inner\n");
				chmodSync(join(directory, "ro.txt"), 0o444);
				chmodSync(join(directory, "ro-dir", "inner.txt"), 0o444);
				chmodSync(join(directory, "ro-dir"), 0o555);
				t.after(() => restoreReadonlyTree(directory));
				return directory;
			};
			const nativeRoot = createReadonlyTree("readonly-posix-native");
			const oracleRoot = createReadonlyTree("readonly-posix-oracle");
			const move = oracleMoveHandler(oracleRoot);
			const session = await startBackendSession(t, {
				projects: [{ id: READONLY_PROJECT_ID, path: nativeRoot }],
				settings: { language: "en-US" },
			});
			for (const name of ["ro.txt", "ro-dir"]) {
				let oracleError;
				try {
					await move([join(oracleRoot, name)], join(oracleRoot, "target"));
				} catch (error) {
					assert.ok(["EACCES", "EPERM"].includes(error.code), error.message);
					oracleError = error;
				}
				const actual = await session.invoke("files:move", [[join(nativeRoot, name)], join(nativeRoot, "target")]);
				assert.equal(actual.payload.ok, !oracleError, JSON.stringify(actual.payload));
				for (const relative of [name, `target/${name}`]) {
					const expectedPath = join(oracleRoot, relative);
					const actualPath = join(nativeRoot, relative);
					assert.equal(existsSync(actualPath), existsSync(expectedPath), relative);
					if (existsSync(expectedPath)) {
						const suffix = name === "ro-dir" ? "inner.txt" : "";
						assert.equal(readFileSync(join(actualPath, suffix), "utf8"), readFileSync(join(expectedPath, suffix), "utf8"));
					}
				}
			}
		});

		test("files:copy reports an inner-entry failure instead of retrying a partial directory", async (t) => {
			// Oracle parity: `copyToFreeName` retries only when the *candidate* path is an EEXIST
			// collision; a child that cannot be reproduced inside the freshly created candidate
			// throws, and the partial copy stays (the oracle never cleans it up). The old loop
			// re-read "the candidate exists" as a name collision, so one inner failure produced up
			// to 1000 orphan partial copies and answered COPY_NAME_EXHAUSTED, hiding the cause.
			const copyProject = join(root, "inner-failure-project");
			const goneReferent = join(root, "inner-failure-gone");
			mkdirSync(join(copyProject, "target"), { recursive: true });
			mkdirSync(join(copyProject, "source"), { recursive: true });
			mkdirSync(goneReferent, { recursive: true });
			writeFileSync(join(copyProject, "source", "keep.txt"), "keep\n");
			try {
				// A dangling link: re-creating it needs the file-symlink privilege, so the child copy
				// fails deterministically on a machine without Developer Mode/elevation.
				symlinkSync(goneReferent, join(copyProject, "source", "broken"), "junction");
				rmdirSync(goneReferent);
			} catch (error) {
				t.skip(`junction creation is not permitted on this machine (${error.code})`);
				return;
			}
			const session = await startBackendSession(t, {
				projects: [{ id: INNER_FAILURE_PROJECT_ID, path: copyProject }],
				settings: { language: "en-US" },
			});
			const copied = await session.invoke("files:copy", [
				[join(copyProject, "source")],
				join(copyProject, "target"),
			]);
			if (copied.payload.ok) {
				// A machine that may create file symlinks reproduces the dangling link, so the child
				// never fails and there is no retry to observe.
				t.skip("file symlinks are permitted here: the dangling link copies successfully");
				return;
			}
			const message = String(copied.payload.error?.message ?? "");
			assert.equal(
				message.includes("COPY_NAME_EXHAUSTED"),
				false,
				`an inner failure must not be reported as a name collision: ${message}`,
			);
			const partials = readdirSync(join(copyProject, "target")).filter((name) => name.startsWith("source"));
			assert.deepEqual(
				partials,
				["source"],
				`exactly the one partial copy the failed attempt created: ${JSON.stringify(partials)}`,
			);
			assert.equal(readFileSync(join(copyProject, "source", "keep.txt"), "utf8"), "keep\n");
		});

		test("files:copy-external only copies paths the capability vouches for", async (t) => {
			const outside = join(root, "copy-source.txt");
			writeFileSync(outside, "copy payload\n");
			const { invoke, baseUrl, token } = await startBackendSession(t, {
				projects: [{ id: PROJECT_ID, path: projectPath }],
				settings: { language: "en-US" },
				hostHandlers: {
					"clipboard.metadataSnapshot": () => ({
						result: { text: "", html: "", filePaths: [outside], hasImage: false, sequence: 12 },
					}),
				},
			});
			const bootstrap = JSON.parse(
				(await httpRequest(`${baseUrl}__pideck/bootstrap`, { headers: { "x-pideck-token": token } })).body,
			);
			const capabilityId = bootstrap.clipboard.externalFileCapabilityId;
			const copied = await invoke("files:copy-external", [capabilityId, projectPath]);
			assert.equal(copied.payload.ok, true, JSON.stringify(copied.payload));
			assert.equal(normalize(copied.payload.result[0]), normalize(join(projectPath, "copy-source.txt")));
			assert.equal(readFileSync(join(projectPath, "copy-source.txt"), "utf8"), "copy payload\n");

			// A forged capability must not become an arbitrary-file copy primitive.
			const forged = await invoke("files:copy-external", ["forged", projectPath]);
			assert.equal(forged.payload.ok, false);
			assert.equal(
				forged.payload.error.message,
				"The external file capability is missing, expired, or does not include this path.",
			);
		});

		test("files:copy-external copies a junction as a link even when its own path encloses the target", async (t) => {
			// The self-copy guard never rejects this case: it compares the clipboard source against a
			// target that the authorization layer already realpath-resolved (`pathpolicy::assertAuthorized`
			// returns the canonical existing path), so `loop` is compared with `<project>/storage/inner`.
			// Neither `samePath` nor `isPathInside` can see an enclosure there, even though
			// `QFileInfo::isDir()` does follow the junction and therefore does treat the source as a
			// directory. The oracle answers the same way: it lstats the source (a link is never a
			// directory) and resolves the target, so the copy is allowed on both sides.
			const linkProject = join(root, "copy-external-link-project");
			mkdirSync(join(linkProject, "storage", "inner"), { recursive: true });
			mkdirSync(join(linkProject, "storage", "payload"), { recursive: true });
			writeFileSync(join(linkProject, "storage", "payload", "keep.txt"), "keep\n");
			const linkPath = join(linkProject, "loop");
			try {
				// Unprivileged junction inside the project, so no authorization rule can answer for
				// the call and only the self-copy guard is under test.
				symlinkSync(join(linkProject, "storage"), linkPath, "junction");
			} catch (error) {
				t.skip(`junction creation is not permitted on this machine (${error.code})`);
				return;
			}
			// Lexically below the junction, so a lexical comparison would call this a self-copy;
			// physically `storage/inner`, which stays inside the project.
			const targetPath = join(linkProject, "loop", "inner");
			const { invoke, baseUrl, token } = await startBackendSession(t, {
				projects: [{ id: COPY_EXTERNAL_LINK_PROJECT_ID, path: linkProject }],
				settings: { language: "en-US" },
				hostHandlers: {
					"clipboard.metadataSnapshot": () => ({
						result: { text: "", html: "", filePaths: [linkPath], hasImage: false, sequence: 21 },
					}),
				},
			});
			const bootstrap = JSON.parse(
				(await httpRequest(`${baseUrl}__pideck/bootstrap`, { headers: { "x-pideck-token": token } })).body,
			);
			const capabilityId = bootstrap.clipboard.externalFileCapabilityId;
			const copied = await invoke("files:copy-external", [capabilityId, targetPath]);
			assert.equal(copied.payload.ok, true, JSON.stringify(copied.payload));
			// The authorization layer resolves the target, so the copy lands in the physical directory.
			assert.equal(normalize(copied.payload.result[0]), normalize(join(linkProject, "storage", "inner", "loop")));
			// The copied entry is the link itself, never the referent's contents.
			assert.ok(
				lstatSync(join(linkProject, "storage", "inner", "loop")).isSymbolicLink(),
				"the copied entry must still be a link",
			);
			assert.equal(readFileSync(join(linkProject, "storage", "payload", "keep.txt"), "utf8"), "keep\n");
		});

		test("files:copy-external still refuses a real directory copied into itself", async (t) => {
			// The link-aware guard must not weaken the recursion protection it exists for.
			const selfProject = join(root, "copy-external-self-project");
			mkdirSync(join(selfProject, "tree", "inner"), { recursive: true });
			writeFileSync(join(selfProject, "tree", "inner", "keep.txt"), "keep\n");
			const treePath = join(selfProject, "tree");
			const { invoke, baseUrl, token } = await startBackendSession(t, {
				projects: [{ id: COPY_EXTERNAL_SELF_PROJECT_ID, path: selfProject }],
				settings: { language: "en-US" },
				hostHandlers: {
					"clipboard.metadataSnapshot": () => ({
						result: { text: "", html: "", filePaths: [treePath], hasImage: false, sequence: 22 },
					}),
				},
			});
			const bootstrap = JSON.parse(
				(await httpRequest(`${baseUrl}__pideck/bootstrap`, { headers: { "x-pideck-token": token } })).body,
			);
			const denied = await invoke("files:copy-external", [
				bootstrap.clipboard.externalFileCapabilityId,
				join(treePath, "inner"),
			]);
			assert.equal(denied.payload.ok, false, JSON.stringify(denied.payload));
			assert.equal(denied.payload.error.message, "Cannot copy a directory into itself");
			assert.equal(readFileSync(join(treePath, "inner", "keep.txt"), "utf8"), "keep\n");
		});
	});
} else {
	test("native2 files domain parity", { skip: "PiDeckBackend.exe is not built (run: xmake build PiDeckBackend)" }, () => {});
}
