// @ts-nocheck
/*
 * store.ts — crash-resistant per-item conversation persistence.
 *
 * One JSON file is kept per Zotero attachment key:
 *   { item_key, session_ids, thought_session_ids, messages, reading }
 *
 * Saves for the same key are serialized. Each save is written to a sibling
 * temporary file and parsed back before it can replace the live file. The
 * previous live file is copied to `.bak`, and the validated temporary file is
 * then moved over the live path.
 *
 * A corrupt live file is never silently treated as a new blank conversation.
 * load() first tries the backup. If recovery is impossible, it returns a fresh
 * in-memory object carrying a non-enumerable __storeNotice and save() refuses to
 * overwrite the damaged files unless an explicit recovery override is supplied.
 */

var SAVE_QUEUES = Object.create(null);

export function convDir() {
  return PathUtils.join(
    Zotero.DataDirectory.dir,
    "paper-reading-agent",
    "conversations",
  );
}

export function convPath(key) {
  return PathUtils.join(convDir(), String(key) + ".json");
}

export function backupPath(key) {
  return convPath(key) + ".bak";
}

export function tempPath(key) {
  return convPath(key) + ".tmp";
}

function freshConversation(key) {
  return {
    item_key: key,
    session_ids: {},
    thought_session_ids: {},
    messages: [],
    reading: {
      mode: "deep",
      sequence: 0,
      activeId: null,
      threads: [],
      parkingLot: [],
    },
  };
}

function errorText(error) {
  return String(error && error.message ? error.message : error);
}

function attachStoreNotice(conv, notice) {
  try {
    Object.defineProperty(conv, "__storeNotice", {
      value: notice,
      configurable: true,
      enumerable: false,
      writable: true,
    });
  } catch (e) {
    // Parsed conversation objects are extensible in normal operation. If an
    // unusual caller freezes one, recovery still succeeds; only the UI notice
    // is unavailable.
  }
  return conv;
}

function clearStoreNotice(conv) {
  try {
    delete conv.__storeNotice;
  } catch (e) {}
}

function isObjectMap(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeConversation(value, key) {
  if (!isObjectMap(value)) {
    throw new Error("Conversation JSON must contain an object.");
  }

  if (value.messages == null) value.messages = [];
  if (!Array.isArray(value.messages)) {
    throw new Error("Conversation messages must be an array.");
  }

  if (value.session_ids == null) value.session_ids = {};
  if (!isObjectMap(value.session_ids)) {
    throw new Error("Conversation session_ids must be an object.");
  }

  if (value.thought_session_ids == null) value.thought_session_ids = {};
  if (!isObjectMap(value.thought_session_ids)) {
    throw new Error("Conversation thought_session_ids must be an object.");
  }

  if (value.reading == null) {
    value.reading = freshConversation(key).reading;
  } else {
    if (!isObjectMap(value.reading)) {
      throw new Error("Conversation reading state must be an object.");
    }
    if (value.reading.threads == null) value.reading.threads = [];
    if (!Array.isArray(value.reading.threads)) {
      throw new Error("Conversation reading threads must be an array.");
    }
    if (value.reading.parkingLot == null) value.reading.parkingLot = [];
    if (!Array.isArray(value.reading.parkingLot)) {
      throw new Error("Conversation parking lot must be an array.");
    }
  }

  // Migrate the legacy flat codex handle into the namespaced map.
  if (value.codex_session_id && !value.session_ids.codex) {
    value.session_ids.codex = value.codex_session_id;
  }
  delete value.codex_session_id;
  value.item_key = key;
  return value;
}

export function parseConversationJSON(text, key) {
  return normalizeConversation(JSON.parse(text), key);
}

async function readConversation(path, key) {
  var text = await IOUtils.readUTF8(path);
  return parseConversationJSON(text, key);
}

async function pathExists(path) {
  return await IOUtils.exists(path);
}

export async function load(key) {
  var main = convPath(key);
  var backup = backupPath(key);
  var mainExists = false;
  var backupExists = false;
  var mainError = null;
  var backupError = null;

  try {
    mainExists = await pathExists(main);
    if (mainExists) return await readConversation(main, key);
  } catch (e) {
    mainError = e;
  }

  try {
    backupExists = await pathExists(backup);
    if (backupExists) {
      var recovered = await readConversation(backup, key);
      return attachStoreNotice(recovered, {
        type: "recovered",
        source: "backup",
        mainPath: main,
        backupPath: backup,
        mainError: mainError
          ? errorText(mainError)
          : mainExists
            ? "The primary conversation could not be loaded."
            : "The primary conversation file is missing.",
      });
    }
  } catch (e) {
    backupError = e;
  }

  // No main file and no backup is the normal first-use case.
  if (!mainExists && !backupExists && !mainError && !backupError) {
    return freshConversation(key);
  }

  var fresh = freshConversation(key);
  return attachStoreNotice(fresh, {
    type: "error",
    source: "none",
    blocksSave: true,
    mainPath: main,
    backupPath: backup,
    mainError: mainError
      ? errorText(mainError)
      : mainExists
        ? "The primary conversation could not be loaded."
        : "The primary conversation file is missing.",
    backupError: backupError
      ? errorText(backupError)
      : backupExists
        ? "The backup conversation could not be loaded."
        : "No backup conversation is available.",
  });
}

// Per-backend resume handle accessors. Returns null when none is stored yet.
export function getSessionHandle(conv, backend, thoughtId) {
  if (!conv) return null;
  if (thoughtId) {
    if (!conv.thought_session_ids) conv.thought_session_ids = {};
    var thoughtHandles = conv.thought_session_ids[thoughtId];
    return (thoughtHandles && thoughtHandles[backend || "codex"]) || null;
  }
  if (!conv.session_ids) conv.session_ids = {};
  return conv.session_ids[backend || "codex"] || null;
}

// Store a resume handle for a backend; returns true if it changed (so the caller
// can persist only when needed — claude re-emits the same id every resume turn).
export function setSessionHandle(conv, backend, id, thoughtId) {
  if (!conv) return false;
  if (thoughtId) {
    if (!conv.thought_session_ids) conv.thought_session_ids = {};
    if (!conv.thought_session_ids[thoughtId])
      conv.thought_session_ids[thoughtId] = {};
    var thoughtHandles = conv.thought_session_ids[thoughtId];
    var thoughtBackend = backend || "codex";
    if (thoughtHandles[thoughtBackend] === id) return false;
    thoughtHandles[thoughtBackend] = id;
    return true;
  }
  if (!conv.session_ids) conv.session_ids = {};
  var k = backend || "codex";
  if (conv.session_ids[k] === id) return false;
  conv.session_ids[k] = id;
  return true;
}

function serializeConversation(conv, key) {
  var serialized = JSON.stringify(conv);
  // Validate the snapshot before it enters the queue. This both catches cyclic
  // values and guarantees that two rapid save() calls retain caller order.
  var parsed = parseConversationJSON(serialized, key);
  if (parsed.item_key !== key) {
    throw new Error("Conversation item_key changed during serialization.");
  }
  return serialized;
}

async function removeTemp(path) {
  try {
    if (await pathExists(path)) {
      await IOUtils.remove(path, { ignoreAbsent: true });
    }
  } catch (e) {}
}

async function saveSerialized(key, serialized, skipDamagedMainBackup) {
  var directory = convDir();
  var main = convPath(key);
  var backup = backupPath(key);
  var temporary = tempPath(key);

  await IOUtils.makeDirectory(directory, {
    ignoreExisting: true,
    createAncestors: true,
  });

  try {
    await IOUtils.writeUTF8(temporary, serialized, { flush: true });

    // Do not trust a successful write alone: read the exact bytes back and
    // parse/validate them before replacing either the live file or its backup.
    var verifiedText = await IOUtils.readUTF8(temporary);
    parseConversationJSON(verifiedText, key);

    if ((await pathExists(main)) && !skipDamagedMainBackup) {
      await IOUtils.copy(main, backup, { noOverwrite: false });
    }

    // The temporary file is in the same directory, so the final move is the
    // single replacement step. A failure leaves the old live file and backup.
    await IOUtils.move(temporary, main, { noOverwrite: false });
  } catch (e) {
    await removeTemp(temporary);
    throw e;
  }
}

function enqueueSave(key, task) {
  var previous = SAVE_QUEUES[key] || Promise.resolve();
  var operation = previous.catch(function () {}).then(task);
  SAVE_QUEUES[key] = operation;

  function cleanup() {
    if (SAVE_QUEUES[key] === operation) delete SAVE_QUEUES[key];
  }
  // Attach both handlers so queue cleanup cannot create an unhandled rejected
  // promise when a fire-and-forget caller ignores save()'s result.
  operation.then(cleanup, cleanup);
  return operation;
}

export function save(conv, options) {
  options = options || {};
  if (!conv || !conv.item_key) {
    return Promise.reject(
      new Error("Cannot save a conversation without item_key."),
    );
  }

  var key = String(conv.item_key);
  var notice = conv.__storeNotice;
  if (
    notice &&
    notice.type === "error" &&
    notice.blocksSave &&
    !options.allowRecoveryOverwrite
  ) {
    return Promise.reject(
      new Error(
        "Refusing to overwrite a conversation that failed to load. " +
          "Recover or export the damaged files first.",
      ),
    );
  }

  var serialized;
  try {
    serialized = serializeConversation(conv, key);
  } catch (e) {
    return Promise.reject(e);
  }

  // A recovered object came from the valid .bak because the live file was
  // damaged or missing. Do not copy that damaged live file over the good backup.
  var skipDamagedMainBackup = !!(notice && notice.type === "recovered");
  var operation = enqueueSave(key, function () {
    return saveSerialized(key, serialized, skipDamagedMainBackup);
  });
  return operation.then(function () {
    clearStoreNotice(conv);
  });
}
