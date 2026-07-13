// @ts-nocheck
/*
 * store.ts — per-item conversation persistence (Zotero / privileged chrome only).
 *
 * One JSON file per Zotero attachment key under the plugin data dir, mirroring
 * the standalone app's conversations/messages model:
 *   { item_key, session_ids: { codex, claude, … }, messages: [{ role, content }] }
 *
 * session_ids holds a per-backend opaque resume handle (a codex thread id is
 * meaningless to claude and vice versa, so they are namespaced by backend id).
 * The legacy flat `codex_session_id` field is migrated on load.
 */

function convDir() {
  return PathUtils.join(
    Zotero.DataDirectory.dir,
    "paper-reading-agent",
    "conversations",
  );
}
function convPath(key) {
  return PathUtils.join(convDir(), key + ".json");
}

export async function load(key) {
  var fresh = { item_key: key, session_ids: {}, messages: [] };
  try {
    var p = convPath(key);
    if (!(await IOUtils.exists(p))) return fresh;
    var text = await IOUtils.readUTF8(p);
    var obj = JSON.parse(text);
    if (!obj.messages) obj.messages = [];
    if (!obj.session_ids) obj.session_ids = {};
    // migrate the legacy flat codex handle into the namespaced map
    if (obj.codex_session_id && !obj.session_ids.codex) {
      obj.session_ids.codex = obj.codex_session_id;
    }
    delete obj.codex_session_id;
    obj.item_key = key;
    return obj;
  } catch (e) {
    return fresh;
  }
}

// Per-backend resume handle accessors. Returns null when none is stored yet.
export function getSessionHandle(conv, backend) {
  if (!conv) return null;
  if (!conv.session_ids) conv.session_ids = {};
  return conv.session_ids[backend || "codex"] || null;
}

// Store a resume handle for a backend; returns true if it changed (so the caller
// can persist only when needed — claude re-emits the same id every resume turn).
export function setSessionHandle(conv, backend, id) {
  if (!conv) return false;
  if (!conv.session_ids) conv.session_ids = {};
  var k = backend || "codex";
  if (conv.session_ids[k] === id) return false;
  conv.session_ids[k] = id;
  return true;
}

export async function save(conv) {
  try {
    await IOUtils.makeDirectory(convDir(), {
      ignoreExisting: true,
      createAncestors: true,
    });
    await IOUtils.writeUTF8(convPath(conv.item_key), JSON.stringify(conv));
  } catch (e) {
    Zotero.debug("[PaperReadingAgent] store.save failed: " + e);
  }
}
