import assert from "node:assert/strict";
import {
  appendFile,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);

function loadEditorModule() {
  const filePath = "src/main/pi/SessionFileEditor.ts";
  const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: nodeRequire,
    Buffer,
    TextDecoder,
    AggregateError,
    process,
    setTimeout,
    clearTimeout,
    console,
  }, { filename: filePath });
  return module.exports;
}

const { SessionFileEditor } = loadEditorModule();

function header(overrides = {}) {
  return { type: "session", version: 3, id: "session-header", ...overrides };
}

function message(id, parentId, role, content, overrides = {}) {
  return {
    type: "message",
    id,
    parentId,
    message: { role, content },
    ...overrides,
  };
}

function encode(entries, { eol = "\n", trailing = true, leading = "" } = {}) {
  return `${leading}${entries.map((entry) => JSON.stringify(entry)).join(eol)}${trailing ? eol : ""}`;
}

function fileRef(path, overrides = {}) {
  return {
    protocolPath: path,
    hostPath: path,
    environment: "native",
    ...overrides,
  };
}

function target(overrides = {}) {
  return {
    entryId: "a1",
    role: "assistant",
    text: "answer",
    activeLeafId: "a1",
    ...overrides,
  };
}

function basicEntries(content = "answer") {
  return [
    header(),
    message("u1", null, "user", "hello"),
    message("a1", "u1", "assistant", content),
  ];
}

function parseLines(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function byOriginalOrId(entries, id) {
  return entries.find((entry) => entry.id === id || entry.originalEntryId === id);
}

async function withTempSession(entries, options, run) {
  const directory = await mkdtemp(join(tmpdir(), "pideck-session-editor-"));
  const path = join(directory, "session.jsonl");
  const original = typeof entries === "string" || Buffer.isBuffer(entries)
    ? entries
    : encode(entries, options);
  try {
    await writeFile(path, original);
    return await run({ directory, path, original: Buffer.from(original) });
  } finally {
    // Windows 病毒扫描器/索引器可能在原子替换后短暂持有目录项；内建重试避免并行套件偶发 ENOTEMPTY。
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

async function expectCode(promise, code) {
  let observed;
  await assert.rejects(promise, (error) => {
    observed = error;
    return error?.code === code;
  });
  return observed;
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("edit preserves CRLF, trailing newline, untouched bytes, unicode and string content", async () => {
  await withTempSession(basicEntries("旧答案"), { eol: "\r\n", trailing: true, leading: "\r\n" }, async ({ path }) => {
    const before = await readFile(path, "utf8");
    const untouched = before.split("\r\n")[2];
    let markerSeen = false;
    const editor = new SessionFileEditor();
    const result = await editor.editMessage({
      file: fileRef(path),
      target: target({ text: "旧答案" }),
      newText: "新答案",
      reload: async () => {
        markerSeen = (await readFile(path, "utf8")).includes("_reloadMarker");
      },
    });

    const after = await readFile(path, "utf8");
    assert.equal(markerSeen, true);
    assert.equal(after.includes("_reloadMarker"), false);
    assert.equal(after.startsWith("\r\n"), true);
    assert.equal(after.endsWith("\r\n"), true);
    assert.equal(after.split("\r\n")[2], untouched);
    assert.equal(byOriginalOrId(parseLines(after), "a1").message.content, "新答案");
    assert.equal(result.targetEntryId, "a1");
    assert.deepEqual([...result.changedEntryIds], ["a1"]);
    assert.equal((await readFile(result.backupPath, "utf8")), before);
  });
});
test("edit keeps non-text blocks and collapses multiple text blocks to the replacement", async () => {
  const content = [
    { type: "thinking", thinking: "reason" },
    { type: "text", text: "first" },
    { type: "image", data: "image-data" },
    { type: "text", text: "second" },
  ];
  await withTempSession(basicEntries(content), {}, async ({ path }) => {
    const editor = new SessionFileEditor();
    await editor.editMessage({
      file: fileRef(path),
      target: target({ text: "firstsecond" }),
      newText: "replacement",
      reload: async () => undefined,
    });
    const edited = byOriginalOrId(parseLines(await readFile(path, "utf8")), "a1");
    assert.deepEqual(
      edited.message.content.map((block) => block.type),
      ["thinking", "text", "image"],
    );
    assert.equal(edited.message.content[1].text, "replacement");
    assert.equal(edited.message.content[0].thinking, "reason");
    assert.equal(edited.message.content[2].data, "image-data");
  });
});

test("edit appends a text block when the message has only non-text blocks", async () => {
  await withTempSession(basicEntries([{ type: "thinking", thinking: "reason" }]), {}, async ({ path }) => {
    const editor = new SessionFileEditor();
    await editor.editMessage({
      file: fileRef(path),
      target: target({ text: "" }),
      newText: "visible",
      reload: async () => undefined,
    });
    const edited = byOriginalOrId(parseLines(await readFile(path, "utf8")), "a1");
    assert.deepEqual(edited.message.content.map((block) => block.type), ["thinking", "text"]);
    assert.equal(edited.message.content[1].text, "visible");
  });
});

test("locator supports legacy message IDs and unique active-branch text fallback", async () => {
  await withTempSession(basicEntries(), {}, async ({ path }) => {
    const editor = new SessionFileEditor();
    await editor.editMessage({
      file: fileRef(path),
      target: target({
        entryId: undefined,
        legacyMessageId: "agent-1-history-a1",
        legacyAgentId: "agent-1",
      }),
      newText: "legacy",
      reload: async () => undefined,
    });
    await editor.editMessage({
      file: fileRef(path),
      target: target({ entryId: undefined, text: "legacy" }),
      newText: "fallback",
      reload: async () => undefined,
    });
    assert.equal(
      byOriginalOrId(parseLines(await readFile(path, "utf8")), "a1").message.content,
      "fallback",
    );
  });
});

test("locator fails closed for duplicate text, stale leaf, off-branch ID and role mismatch", async () => {
  const entries = [
    header(),
    message("u1", null, "user", "same"),
    message("a1", "u1", "assistant", "one"),
    message("u2", "a1", "user", "same"),
    message("a2", "u2", "assistant", "two"),
    message("u-other", null, "user", "other"),
    message("a-other", "u-other", "assistant", "other-answer"),
  ];
  await withTempSession(entries, {}, async ({ path, original }) => {
    const editor = new SessionFileEditor();
    await expectCode(editor.editMessage({
      file: fileRef(path),
      target: target({ entryId: undefined, role: "user", text: "same", activeLeafId: "a2" }),
      newText: "ambiguous",
      reload: async () => undefined,
    }), "SESSION_ENTRY_AMBIGUOUS");
    await expectCode(editor.editMessage({
      file: fileRef(path),
      target: target({ entryId: "a2", text: "two", activeLeafId: "missing-leaf" }),
      newText: "stale",
      reload: async () => undefined,
    }), "SESSION_ENTRY_NOT_FOUND");
    await expectCode(editor.editMessage({
      file: fileRef(path),
      target: target({ entryId: "a1", text: "one", activeLeafId: "a-other" }),
      newText: "wrong-branch",
      reload: async () => undefined,
    }), "SESSION_ENTRY_NOT_FOUND");
    await expectCode(editor.editMessage({
      file: fileRef(path),
      target: target({ entryId: "u-other", role: "assistant", text: "other", activeLeafId: "a-other" }),
      newText: "wrong-role",
      reload: async () => undefined,
    }), "SESSION_ENTRY_ROLE_INVALID");
    assert.equal((await readFile(path)).equals(original), true);
    assert.equal((await readdir(join(path, ".."))).some((name) => name.endsWith(".edit-backup")), false);
  });
});

test("parser rejects empty, invalid UTF-8, malformed JSON, duplicate IDs, headers, dangling parents and cycles", async (t) => {
  const cases = [
    ["empty", "", "SESSION_FILE_EMPTY"],
    ["invalid UTF-8", Buffer.from([0xff, 0xfe]), "SESSION_FILE_INVALID_JSONL"],
    ["malformed JSON", `${JSON.stringify(header())}\n{bad}\n`, "SESSION_FILE_INVALID_JSONL"],
    ["duplicate ID", encode([header(), message("u1", null, "user", "a"), message("u1", null, "user", "b")]), "SESSION_FILE_INVALID_JSONL"],
    ["missing header", encode([message("u1", null, "user", "a")]), "SESSION_FILE_INVALID_JSONL"],
    ["duplicate header", encode([header(), header({ id: "header-2" }), message("u1", null, "user", "a")]), "SESSION_FILE_INVALID_JSONL"],
    ["dangling parent", encode([header(), message("u1", "missing", "user", "a")]), "SESSION_FILE_INVALID_JSONL"],
    ["cycle", encode([header(), message("u1", "a1", "user", "a"), message("a1", "u1", "assistant", "b")]), "SESSION_FILE_INVALID_JSONL"],
  ];
  for (const [name, bytes, code] of cases) {
    await t.test(name, async () => {
      await withTempSession(bytes, {}, async ({ path, original }) => {
        const editor = new SessionFileEditor();
        await expectCode(editor.editMessage({
          file: fileRef(path),
          target: target(),
          newText: "blocked",
          reload: async () => undefined,
        }), code);
        assert.equal((await readFile(path)).equals(original), true);
      });
    });
  }
});

/**
 * 复刻 pi SessionManager._buildIndex + buildSessionPath 的活动分支投影。
 * tombstone 若没有 id/parentId，leaf 会落在删除记录上，get_messages 整页变空。
 */
function piActiveMessageTexts(entries) {
  const byId = new Map();
  let leafId;
  for (const entry of entries) {
    if (entry.type === "session") continue;
    byId.set(entry.id, entry);
    leafId = entry.id;
  }
  let leaf = leafId ? byId.get(leafId) : undefined;
  if (!leaf) {
    leaf = [...entries].reverse().find((entry) => entry.type !== "session");
  }
  const path = [];
  let current = leaf;
  while (current) {
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message?.content);
}

test("deleting the current leaf must not empty pi's remaining active branch", async () => {
  const entries = [
    header(),
    message("u1", null, "user", "keep me"),
    message("a1", "u1", "assistant", "keep answer"),
    message("u2", "a1", "user", "delete leaf"),
    message("a2", "u2", "assistant", "leaf answer"),
  ];
  await withTempSession(entries, {}, async ({ path }) => {
    const editor = new SessionFileEditor({ now: () => 123 });
    await editor.deleteMessage({
      file: fileRef(path),
      target: target({ entryId: "a2", role: "assistant", text: "leaf answer", activeLeafId: "a2" }),
      reload: async () => undefined,
    });
    const next = parseLines(await readFile(path, "utf8"));
    const tombstone = byOriginalOrId(next, "a2");
    assert.equal(tombstone.type, "deleted");
    // pi _buildIndex 用 entry.id 当 leaf；没有 id 时 leaf 落在 tombstone 上，整页变空。
    assert.equal(tombstone.id, "a2");
    assert.equal(tombstone.parentId, "u2");
    assert.deepEqual(piActiveMessageTexts(next), ["keep me", "keep answer", "delete leaf"]);
  });
});

test("resending the latest user turn must keep earlier turns visible to pi", async () => {
  const entries = [
    header(),
    message("u1", null, "user", "first"),
    message("a1", "u1", "assistant", "first answer"),
    message("u2", "a1", "user", "resend me"),
    message("a2", "u2", "assistant", "second answer"),
  ];
  await withTempSession(entries, {}, async ({ path }) => {
    const editor = new SessionFileEditor({ now: () => 123 });
    await editor.truncateForResend({
      file: fileRef(path),
      target: target({ entryId: "u2", role: "user", text: "resend me", activeLeafId: "a2" }),
      reload: async () => undefined,
    });
    const next = parseLines(await readFile(path, "utf8"));
    assert.deepEqual(piActiveMessageTexts(next), ["first", "first answer"]);
  });
});

test("deleting an assistant answer also tombstones that turn's thinking and tools", async () => {
  // 一轮常态：user → thinking-only → toolResult → 最终回答 → 下一轮 user → 回答
  // 只墓碑最终回答时，思考/工具会改挂到下一轮，分组后就会串台。
  const entries = [
    header(),
    message("u1", null, "user", "first question"),
    message("think1", "u1", "assistant", [{ type: "thinking", thinking: "plan A" }]),
    message("tool1", "think1", "toolResult", "ok"),
    message("a1", "tool1", "assistant", "answer one"),
    message("u2", "a1", "user", "second question"),
    message("a2", "u2", "assistant", "answer two"),
  ];
  await withTempSession(entries, {}, async ({ path }) => {
    const editor = new SessionFileEditor({ now: () => 123 });
    await editor.deleteMessage({
      file: fileRef(path),
      target: target({ entryId: "a1", role: "assistant", text: "answer one", activeLeafId: "a2" }),
      reload: async () => undefined,
    });
    const next = parseLines(await readFile(path, "utf8"));
    assert.equal(byOriginalOrId(next, "a1").type, "deleted");
    assert.equal(byOriginalOrId(next, "think1").type, "deleted");
    assert.equal(byOriginalOrId(next, "tool1").type, "deleted");
    assert.equal(byOriginalOrId(next, "u2").parentId, "u1");
    assert.deepEqual(piActiveMessageTexts(next), ["first question", "second question", "answer two"]);
  });
});

test("delete tombstones the target, reparents direct children and leaves grandchildren and siblings intact", async () => {
  const entries = [
    header(),
    message("u1", null, "user", "delete me"),
    message("a1", "u1", "assistant", "child one"),
    message("a2", "u1", "assistant", "child two"),
    message("u2", "a1", "user", "grandchild"),
    message("sibling", null, "assistant", "sibling"),
  ];
  await withTempSession(entries, {}, async ({ path }) => {
    const editor = new SessionFileEditor({ now: () => 123 });
    const result = await editor.deleteMessage({
      file: fileRef(path),
      target: target({ entryId: "u1", role: "user", text: "delete me", activeLeafId: "u2" }),
      reload: async () => undefined,
    });
    const next = parseLines(await readFile(path, "utf8"));
    assert.equal(byOriginalOrId(next, "u1").type, "deleted");
    assert.equal(byOriginalOrId(next, "a1").parentId, null);
    assert.equal(byOriginalOrId(next, "a2").parentId, null);
    assert.equal(byOriginalOrId(next, "u2").parentId, "a1");
    assert.equal(byOriginalOrId(next, "sibling").parentId, null);
    assert.deepEqual(new Set(result.changedEntryIds), new Set(["u1", "a1", "a2"]));
  });
});

test("resend tombstones the user root and all descendants while preserving sibling branches", async () => {
  const entries = [
    header(),
    message("root", null, "user", "root"),
    message("u1", "root", "user", "resend"),
    message("a1", "u1", "assistant", "answer"),
    message("u2", "a1", "user", "follow-up"),
    message("a2", "u2", "assistant", "follow-answer"),
    message("u-sibling", "root", "user", "sibling"),
    message("a-sibling", "u-sibling", "assistant", "sibling-answer"),
  ];
  await withTempSession(entries, {}, async ({ path }) => {
    const editor = new SessionFileEditor({ now: () => 123 });
    const result = await editor.truncateForResend({
      file: fileRef(path),
      target: target({ entryId: "u1", role: "user", text: "resend", activeLeafId: "a2" }),
      reload: async () => undefined,
    });
    const next = parseLines(await readFile(path, "utf8"));
    for (const id of ["u1", "a1", "u2", "a2"]) {
      assert.equal(byOriginalOrId(next, id).type, "deleted");
      assert.equal(byOriginalOrId(next, id).reason, "resend-truncate");
    }
    assert.equal(byOriginalOrId(next, "u-sibling").type, "message");
    assert.equal(byOriginalOrId(next, "a-sibling").type, "message");
    assert.deepEqual(new Set(result.changedEntryIds), new Set(["u1", "a1", "u2", "a2"]));
  });
});

test("resend rejects assistant roots before backup or write", async () => {
  await withTempSession(basicEntries(), {}, async ({ path, original, directory }) => {
    const editor = new SessionFileEditor();
    await expectCode(editor.truncateForResend({
      file: fileRef(path),
      target: target(),
      reload: async () => undefined,
    }), "SESSION_ENTRY_ROLE_INVALID");
    assert.equal((await readFile(path)).equals(original), true);
    assert.equal((await readdir(directory)).some((name) => name.endsWith(".edit-backup")), false);
  });
});

test("backup creation is mandatory and failure leaves the session byte-for-byte unchanged", async () => {
  await withTempSession(basicEntries(), {}, async ({ path, original }) => {
    const editor = new SessionFileEditor({
      fs: {
        open: async (candidate, flags) => {
          if (candidate.endsWith(".edit-backup")) {
            const error = new Error("backup denied");
            error.code = "EACCES";
            throw error;
          }
          return open(candidate, flags);
        },
      },
    });
    await expectCode(editor.editMessage({
      file: fileRef(path),
      target: target(),
      newText: "must-not-write",
      reload: async () => undefined,
    }), "SESSION_BACKUP_FAILED");
    assert.equal((await readFile(path)).equals(original), true);
  });
});

test("backup pruning retains the current exact backup even when its UUID sorts first", async () => {
  await withTempSession(basicEntries(), {}, async ({ path, original, directory }) => {
    const stamp = "0000000000123";
    for (const suffix of ["100-old", "200-old", "300-old"]) {
      await writeFile(join(directory, `${basename(path)}.${stamp}-${suffix}.edit-backup`), `old-${suffix}`);
    }
    const uuids = ["000-current", "temp", "marker", "cleanup"];
    const editor = new SessionFileEditor({
      now: () => 123,
      randomUUID: () => uuids.shift() ?? `later-${Math.random()}`,
    });
    const result = await editor.editMessage({
      file: fileRef(path),
      target: target(),
      newText: "changed",
      reload: async () => undefined,
    });
    const backups = (await readdir(directory)).filter((name) => name.endsWith(".edit-backup"));
    assert.equal(backups.length, 3);
    assert.equal(backups.includes(basename(result.backupPath)), true);
    assert.equal((await readFile(result.backupPath)).equals(original), true);
  });
});

test("temp open, write, sync and rename failures preserve the original and clean temporary files", async (t) => {
  for (const fault of ["open", "write", "sync", "rename"]) {
    await t.test(fault, async () => {
      await withTempSession(basicEntries(), {}, async ({ path, original, directory }) => {
        const editor = new SessionFileEditor({
          fs: {
            open: async (candidate, flags) => {
              if (!candidate.endsWith(".tmp")) return open(candidate, flags);
              if (fault === "open") throw new Error("temp open failed");
              const handle = await open(candidate, flags);
              return {
                writeFile: async (data) => {
                  if (fault === "write") throw new Error("temp write failed");
                  await handle.writeFile(data);
                },
                sync: async () => {
                  if (fault === "sync") throw new Error("temp sync failed");
                  await handle.sync();
                },
                close: () => handle.close(),
              };
            },
            rename: async (from, to) => {
              if (fault === "rename" && from.endsWith(".tmp")) throw new Error("rename failed");
              await rename(from, to);
            },
          },
          sleep: async () => undefined,
        });
        await expectCode(editor.editMessage({
          file: fileRef(path),
          target: target(),
          newText: "blocked",
          reload: async () => undefined,
        }), "SESSION_ATOMIC_WRITE_FAILED");
        assert.equal((await readFile(path)).equals(original), true);
        assert.equal((await readdir(directory)).some((name) => name.endsWith(".tmp")), false);
      });
    });
  }
});

test("EPERM rename retries succeed when the expected file stays unchanged", async () => {
  await withTempSession(basicEntries(), {}, async ({ path }) => {
    let attempts = 0;
    const editor = new SessionFileEditor({
      fs: {
        rename: async (from, to) => {
          attempts += 1;
          if (attempts <= 2) {
            const error = new Error("busy");
            error.code = "EPERM";
            throw error;
          }
          await rename(from, to);
        },
      },
      sleep: async () => undefined,
    });
    await editor.editMessage({
      file: fileRef(path),
      target: target(),
      newText: "retried",
      reload: async () => undefined,
    });
    assert.equal(attempts >= 5, true);
    assert.equal(byOriginalOrId(parseLines(await readFile(path, "utf8")), "a1").message.content, "retried");
  });
});

test("rename retry rechecks expected bytes and refuses a Pi append between attempts", async () => {
  await withTempSession(basicEntries(), {}, async ({ path, original, directory }) => {
    let attempts = 0;
    const externalLine = `${JSON.stringify({ type: "custom", note: "external" })}\n`;
    const editor = new SessionFileEditor({
      fs: {
        rename: async (from, to) => {
          attempts += 1;
          if (attempts === 1) {
            await appendFile(to, externalLine);
            const error = new Error("busy");
            error.code = "EPERM";
            throw error;
          }
          await rename(from, to);
        },
      },
      sleep: async () => undefined,
    });
    await expectCode(editor.editMessage({
      file: fileRef(path),
      target: target(),
      newText: "must-not-commit",
      reload: async () => undefined,
    }), "SESSION_FILE_CHANGED");
    const current = await readFile(path);
    assert.equal(current.equals(Buffer.concat([original, Buffer.from(externalLine)])), true);
    assert.equal((await readdir(directory)).some((name) => name.endsWith(".tmp")), false);
  });
});

test("temp fsync completion is followed by a final expected-byte check", async () => {
  await withTempSession(basicEntries(), {}, async ({ path, original }) => {
    const externalLine = `${JSON.stringify({ type: "custom", note: "after-sync" })}\n`;
    let changed = false;
    const editor = new SessionFileEditor({
      fs: {
        open: async (candidate, flags) => {
          const handle = await open(candidate, flags);
          if (!candidate.endsWith(".tmp")) return handle;
          return {
            writeFile: (data) => handle.writeFile(data),
            sync: async () => {
              await handle.sync();
              if (!changed) {
                changed = true;
                await appendFile(path, externalLine);
              }
            },
            close: () => handle.close(),
          };
        },
      },
    });
    await expectCode(editor.editMessage({
      file: fileRef(path),
      target: target(),
      newText: "must-not-commit",
      reload: async () => undefined,
    }), "SESSION_FILE_CHANGED");
    assert.equal((await readFile(path)).equals(Buffer.concat([original, Buffer.from(externalLine)])), true);
  });
});

test("module-level physical locking serializes two editor instances and native/WSL aliases", async () => {
  await withTempSession(basicEntries(), {}, async ({ path }) => {
    const firstEntered = deferred();
    const releaseFirst = deferred();
    let secondEntered = false;
    const first = new SessionFileEditor();
    const second = new SessionFileEditor();
    const firstPromise = first.editMessage({
      file: fileRef(path),
      target: target(),
      newText: "first",
      reload: async () => {
        firstEntered.resolve();
        await releaseFirst.promise;
      },
    });
    await firstEntered.promise;
    const secondPromise = second.editMessage({
      file: fileRef(path, {
        protocolPath: "/mnt/c/alias/session.jsonl",
        environment: "wsl",
        wslDistro: "Ubuntu",
      }),
      target: target({ text: "first" }),
      newText: "second",
      reload: async () => {
        secondEntered = true;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(secondEntered, false);
    releaseFirst.resolve();
    await Promise.all([firstPromise, secondPromise]);
    assert.equal(secondEntered, true);
    assert.equal(byOriginalOrId(parseLines(await readFile(path, "utf8")), "a1").message.content, "second");
  });
});

test("different physical files can mutate concurrently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pideck-session-editor-parallel-"));
  const firstPath = join(directory, "first.jsonl");
  const secondPath = join(directory, "second.jsonl");
  try {
    await Promise.all([
      writeFile(firstPath, encode(basicEntries())),
      writeFile(secondPath, encode(basicEntries())),
    ]);
    const bothEntered = deferred();
    const release = deferred();
    let entered = 0;
    const reload = async () => {
      entered += 1;
      if (entered === 2) bothEntered.resolve();
      await release.promise;
    };
    const first = new SessionFileEditor().editMessage({
      file: fileRef(firstPath), target: target(), newText: "first", reload,
    });
    const second = new SessionFileEditor().editMessage({
      file: fileRef(secondPath), target: target(), newText: "second", reload,
    });
    await bothEntered.promise;
    assert.equal(entered, 2);
    release.resolve();
    await Promise.all([first, second]);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("public reload exposes its own marker and removes a moved marker without dropping header updates", async () => {
  await withTempSession(basicEntries(), {}, async ({ path }) => {
    const editor = new SessionFileEditor();
    await editor.reload({
      file: fileRef(path),
      reload: async () => {
        const lines = (await readFile(path, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
        const session = lines.shift();
        assert.equal(typeof session._reloadMarker, "string");
        session.updatedByPi = true;
        lines.push(session);
        await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
      },
    });
    const next = parseLines(await readFile(path, "utf8"));
    const session = next.find((entry) => entry.type === "session");
    assert.equal(session.updatedByPi, true);
    assert.equal("_reloadMarker" in session, false);
    assert.equal(next.at(-1).type, "session");
  });
});

test("foreign markers are rejected before backup, mutation or callback", async () => {
  const entries = basicEntries();
  entries[0]._reloadMarker = "foreign";
  await withTempSession(entries, {}, async ({ path, original, directory }) => {
    let called = false;
    const editor = new SessionFileEditor();
    await expectCode(editor.editMessage({
      file: fileRef(path),
      target: target(),
      newText: "blocked",
      reload: async () => { called = true; },
    }), "SESSION_MARKER_CONFLICT");
    assert.equal(called, false);
    assert.equal((await readFile(path)).equals(original), true);
    assert.equal((await readdir(directory)).some((name) => name.endsWith(".edit-backup")), false);
  });
});

test("reload failure restores the exact transaction backup and reloads the restored runtime", async () => {
  await withTempSession(basicEntries(), { eol: "\r\n", trailing: true }, async ({ path, original }) => {
    let calls = 0;
    const editor = new SessionFileEditor();
    const error = await expectCode(editor.editMessage({
      file: fileRef(path),
      target: target(),
      newText: "rolled-back",
      reload: async () => {
        calls += 1;
        if (calls === 1) throw new Error("primary reload failed");
      },
    }), "SESSION_RELOAD_FAILED");
    assert.equal(calls, 2);
    assert.equal((await readFile(path)).equals(original), true);
    assert.equal((await readFile(error.backupPath)).equals(original), true);
    assert.equal((await readFile(path, "utf8")).includes("_reloadMarker"), false);
  });
});

test("reload-time external data causes rollback conflict and is never overwritten", async () => {
  await withTempSession(basicEntries(), {}, async ({ path, original }) => {
    const externalLine = `${JSON.stringify({ type: "custom", note: "reload-external" })}\n`;
    const editor = new SessionFileEditor();
    const error = await expectCode(editor.editMessage({
      file: fileRef(path),
      target: target(),
      newText: "edited-before-conflict",
      reload: async () => {
        await appendFile(path, externalLine);
        throw new Error("reload failed after external append");
      },
    }), "SESSION_ROLLBACK_CONFLICT");
    const current = await readFile(path, "utf8");
    assert.equal(current.includes("edited-before-conflict"), true);
    assert.equal(current.includes("reload-external"), true);
    assert.equal(current.includes("_reloadMarker"), false);
    assert.equal((await readFile(error.backupPath)).equals(original), true);
    assert.match(error.details.originalError, /reload failed/);
  });
});

test("a second reload failure reports rollback-reload failure after restoring the file", async () => {
  await withTempSession(basicEntries(), {}, async ({ path, original }) => {
    let calls = 0;
    const editor = new SessionFileEditor();
    const error = await expectCode(editor.deleteMessage({
      file: fileRef(path),
      target: target(),
      reload: async () => {
        calls += 1;
        throw new Error(`reload failure ${calls}`);
      },
    }), "SESSION_ROLLBACK_RELOAD_FAILED");
    assert.equal(calls, 2);
    assert.equal((await readFile(path)).equals(original), true);
    assert.equal((await readFile(error.backupPath)).equals(original), true);
    assert.equal((await readFile(path, "utf8")).includes("_reloadMarker"), false);
  });
});
