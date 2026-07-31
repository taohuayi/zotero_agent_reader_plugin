import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/modules/store.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
});
const store = await import(
  "data:text/javascript;base64," +
    Buffer.from(bundle.outputFiles[0].text).toString("base64")
);

function conversation(key, content = "hello") {
  return {
    item_key: key,
    session_ids: {},
    thought_session_ids: {},
    messages: [{ role: "user", content }],
    reading: {
      mode: "deep",
      sequence: 1,
      activeId: "q1",
      threads: [{ id: "q1", parentId: null }],
      parkingLot: [],
    },
  };
}

function memoryIO(initial = {}) {
  const files = new Map(Object.entries(initial));
  const log = [];
  let activeWrites = 0;
  let maxActiveWrites = 0;
  let corruptTemporaryWrites = false;

  return {
    files,
    log,
    get maxActiveWrites() {
      return maxActiveWrites;
    },
    set corruptTemporaryWrites(value) {
      corruptTemporaryWrites = value;
    },
    async exists(path) {
      return files.has(path);
    },
    async readUTF8(path) {
      log.push(["read", path]);
      if (!files.has(path)) throw new Error("ENOENT: " + path);
      return files.get(path);
    },
    async makeDirectory(path) {
      log.push(["mkdir", path]);
    },
    async writeUTF8(path, value) {
      log.push(["write", path]);
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      await new Promise((resolve) => setTimeout(resolve, 4));
      files.set(
        path,
        corruptTemporaryWrites && path.endsWith(".tmp") ? "{broken" : value,
      );
      activeWrites -= 1;
      return value.length;
    },
    async copy(source, destination) {
      log.push(["copy", source, destination]);
      if (!files.has(source)) throw new Error("ENOENT: " + source);
      files.set(destination, files.get(source));
    },
    async move(source, destination) {
      log.push(["move", source, destination]);
      if (!files.has(source)) throw new Error("ENOENT: " + source);
      files.set(destination, files.get(source));
      files.delete(source);
    },
    async remove(path) {
      log.push(["remove", path]);
      files.delete(path);
    },
  };
}

function installGlobals(io) {
  globalThis.PathUtils = {
    join(...parts) {
      return parts.join("/");
    },
  };
  globalThis.Zotero = {
    DataDirectory: { dir: "data" },
    debug() {},
  };
  globalThis.IOUtils = io;
}

test("save validates a temporary file, backs up live data, and replaces atomically", async () => {
  const key = "ABC";
  const main = "data/paper-reading-agent/conversations/ABC.json";
  const backup = main + ".bak";
  const temporary = main + ".tmp";
  const old = JSON.stringify(conversation(key, "old"));
  const io = memoryIO({ [main]: old });
  installGlobals(io);

  await store.save(conversation(key, "new"));

  assert.equal(JSON.parse(io.files.get(main)).messages[0].content, "new");
  assert.equal(io.files.get(backup), old);
  assert.equal(io.files.has(temporary), false);
  assert.deepEqual(
    io.log
      .filter(([action]) => ["write", "read", "copy", "move"].includes(action))
      .map(([action, path]) => [action, path]),
    [
      ["write", temporary],
      ["read", temporary],
      ["copy", main],
      ["move", temporary],
    ],
  );
});

test("save calls for one key are serialized and retain caller order", async () => {
  const key = "SERIAL";
  const main = "data/paper-reading-agent/conversations/SERIAL.json";
  const backup = main + ".bak";
  const io = memoryIO();
  installGlobals(io);

  const conv = conversation(key, "first");
  const first = store.save(conv);
  conv.messages[0].content = "second";
  const second = store.save(conv);
  await Promise.all([first, second]);

  assert.equal(io.maxActiveWrites, 1);
  assert.equal(JSON.parse(io.files.get(main)).messages[0].content, "second");
  assert.equal(JSON.parse(io.files.get(backup)).messages[0].content, "first");
});

test("an invalid temporary write never replaces live data", async () => {
  const key = "VERIFY";
  const main = "data/paper-reading-agent/conversations/VERIFY.json";
  const old = JSON.stringify(conversation(key, "safe"));
  const io = memoryIO({ [main]: old });
  io.corruptTemporaryWrites = true;
  installGlobals(io);

  await assert.rejects(store.save(conversation(key, "unsafe")), /JSON/);

  assert.equal(io.files.get(main), old);
  assert.equal(io.files.has(main + ".bak"), false);
  assert.equal(io.files.has(main + ".tmp"), false);
});

test("load recovers from backup and attaches a non-persistent notice", async () => {
  const key = "RECOVER";
  const main = "data/paper-reading-agent/conversations/RECOVER.json";
  const backup = main + ".bak";
  const io = memoryIO({
    [main]: "{not-json",
    [backup]: JSON.stringify(conversation(key, "from backup")),
  });
  installGlobals(io);

  const loaded = await store.load(key);

  assert.equal(loaded.messages[0].content, "from backup");
  assert.equal(loaded.__storeNotice.type, "recovered");
  assert.equal(loaded.__storeNotice.source, "backup");
  assert.equal(
    Object.prototype.propertyIsEnumerable.call(loaded, "__storeNotice"),
    false,
  );
  assert.equal(JSON.stringify(loaded).includes("__storeNotice"), false);
});

test("saving recovered data preserves the good backup", async () => {
  const key = "PRESERVE";
  const main = "data/paper-reading-agent/conversations/PRESERVE.json";
  const backup = main + ".bak";
  const validBackup = JSON.stringify(conversation(key, "from backup"));
  const io = memoryIO({
    [main]: "{damaged",
    [backup]: validBackup,
  });
  installGlobals(io);

  const loaded = await store.load(key);
  loaded.messages.push({ role: "user", content: "continued" });
  await store.save(loaded);

  assert.equal(io.files.get(backup), validBackup);
  assert.equal(JSON.parse(io.files.get(main)).messages.length, 2);
  assert.equal(loaded.__storeNotice, undefined);
});

test("when primary and backup both fail, load blocks accidental blank overwrite", async () => {
  const key = "BROKEN";
  const main = "data/paper-reading-agent/conversations/BROKEN.json";
  const backup = main + ".bak";
  const io = memoryIO({
    [main]: "{broken-main",
    [backup]: "{broken-backup",
  });
  installGlobals(io);

  const loaded = await store.load(key);

  assert.deepEqual(loaded.messages, []);
  assert.equal(loaded.__storeNotice.type, "error");
  assert.equal(loaded.__storeNotice.blocksSave, true);
  await assert.rejects(store.save(loaded), /Refusing to overwrite/);
  assert.equal(io.files.get(main), "{broken-main");
  assert.equal(io.files.get(backup), "{broken-backup");
});

test("missing primary and backup is a clean first-use conversation", async () => {
  const io = memoryIO();
  installGlobals(io);

  const loaded = await store.load("NEW");

  assert.deepEqual(loaded.messages, []);
  assert.equal(loaded.item_key, "NEW");
  assert.equal(loaded.__storeNotice, undefined);
});
