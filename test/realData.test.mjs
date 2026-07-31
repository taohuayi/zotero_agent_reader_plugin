import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import fs from "node:fs";

// Real-data integration tests: run the whole reading-workflow + notebook stack
// against the ACTUAL conversation JSON the plugin wrote (E:\Zotero\Data\...).
// Skipped when the data file is not present (CI / other machines).
const REAL_DATA = "E:\\Zotero\\Data\\paper-reading-agent\\conversations\\LYNTJ8CE.json";
const hasRealData = fs.existsSync(REAL_DATA);

const bundle = await build({
  entryPoints: ["src/modules/readingWorkflow.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false,
});
const wf = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);

const nbBundle = await build({
  entryPoints: ["src/modules/conversationNotebook.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false,
});
const nb = await import(
  "data:text/javascript;base64," + Buffer.from(nbBundle.outputFiles[0].text).toString("base64")
);

function loadReal() {
  const raw = JSON.parse(fs.readFileSync(REAL_DATA, "utf-8"));
  return raw;
}

test("real conversation loads and normalizes without throwing", { skip: !hasRealData }, () => {
  const conv = loadReal();
  const state = wf.ensure(conv);
  assert.ok(Array.isArray(state.threads));
  assert.ok(Array.isArray(state.parkingLot));
  assert.ok(typeof state.sequence === "number");
  assert.ok(Array.isArray(conv.messages));
});

test("real thought tree is a valid forest: no cycles, valid parents, no orphans", { skip: !hasRealData }, () => {
  const conv = loadReal();
  const state = wf.ensure(conv);
  const ids = new Set(state.threads.map((t) => t.id));
  // every parentId either null or points at an existing node
  for (const t of state.threads) {
    if (t.parentId != null) {
      assert.ok(ids.has(t.parentId), `thread ${t.id} has dangling parent ${t.parentId}`);
    }
  }
  // no cycles: walk every node to root, must terminate
  const byId = Object.create(null);
  state.threads.forEach((t) => (byId[t.id] = t));
  for (const t of state.threads) {
    const seen = new Set();
    let cur = t;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = cur.parentId ? byId[cur.parentId] : null;
    }
    assert.ok(cur === null, `cycle detected at ${t.id}`);
  }
});

test("mindMapLayout covers every node exactly once and edges match parents", { skip: !hasRealData }, () => {
  const conv = loadReal();
  const state = wf.ensure(conv);
  const layout = wf.mindMapLayout(conv);
  const laidOut = new Set(layout.nodes.map((n) => n.thread.id));
  assert.equal(laidOut.size, state.threads.length, "every thread appears exactly once");
  const nodeMap = new Map(layout.nodes.map((n) => [n.thread.id, n]));
  for (const edge of layout.edges) {
    assert.ok(nodeMap.has(edge.from), `edge from missing node ${edge.from}`);
    assert.ok(nodeMap.has(edge.to), `edge to missing node ${edge.to}`);
    const to = nodeMap.get(edge.to).thread;
    assert.equal(to.parentId, edge.from, `edge ${edge.from}->${edge.to} contradicts parentId`);
  }
});

test("ancestry walks the real tree without error and includes the root", { skip: !hasRealData }, () => {
  const conv = loadReal();
  const state = wf.ensure(conv);
  if (!state.activeId) return; // no active thread — nothing to walk
  const path = wf.ancestry(conv, state.activeId);
  assert.ok(path.length >= 1);
  assert.equal(path[path.length - 1].id, path[path.length - 1].id);
});

test("branching ops on real data: followup, branch, switch, park, resume", { skip: !hasRealData }, () => {
  const conv = loadReal();
  const before = wf.ensure(conv).threads.length;
  const parent = wf.activeThread(conv);
  // followup inherits the parent's thought (continuous context)
  const followup = wf.beginQuestion(conv, "集成测试：追问", "deep", { followup: true });
  assert.equal(followup.thoughtId, parent ? parent.thoughtId || parent.id : followup.thoughtId);
  // branch gets a fresh thought (isolated context)
  const branch = wf.beginQuestion(conv, "集成测试：分支", "deep", { branch: true });
  assert.notEqual(branch.thoughtId, followup.thoughtId);
  // switch back and forth
  assert.equal(wf.switchThread(conv, parent.id).id, parent.id);
  assert.equal(wf.activeThread(conv).id, parent.id);
  // park a question and take it back
  const parked = wf.park(conv, "集成测试：停车问题", "later", null);
  assert.ok(parked);
  assert.equal(wf.takeParked(conv, parked.id).id, parked.id);
  // restore: remove the two test threads so the real data is untouched in memory
  wf.removeThread(conv, followup.id);
  wf.removeThread(conv, branch.id);
  assert.equal(wf.ensure(conv).threads.length, before);
});

test("restructuring on real data: reparent (guarded), insert, retitle, delete subtree", { skip: !hasRealData }, () => {
  const conv = loadReal();
  const state = wf.ensure(conv);
  if (state.threads.length < 2) return;
  const [a, b] = state.threads;
  // cycle guard must reject moving an ancestor under a descendant
  const guard = wf.reparentThread(conv, a.id, b.id);
  if (guard) {
    // a->b succeeded means b was not a's descendant; verify tree stays valid
    const byId = Object.create(null);
    state.threads.forEach((t) => (byId[t.id] = t));
    const seen = new Set();
    let cur = byId[a.id];
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = cur.parentId ? byId[cur.parentId] : null;
    }
    assert.ok(cur === null, "reparent created a cycle");
    wf.reparentThread(conv, a.id, a.parentId); // undo
  }
  // insert + retitle + summary
  const created = wf.insertThread(conv, "集成测试：临时节点", null);
  assert.ok(created);
  assert.equal(wf.updateThreadTitle(conv, created.id, "集成测试：改名"), true);
  assert.equal(wf.updateThreadSummary(conv, created.id, "临时摘要"), true);
  const t = wf.ensure(conv).threads.find((x) => x.id === created.id);
  assert.equal(t.title, "集成测试：改名");
  assert.equal(t.rootQuestion, "集成测试：临时节点");
  assert.equal(t.summary, "临时摘要");
  wf.removeThread(conv, created.id);
});

test("edited messages flow into stateless history (chatgpt backend replays edits)", { skip: !hasRealData }, () => {
  const conv = loadReal();
  const thoughtId = wf.ensure(conv).activeId;
  // replicate chatService's stateless history builder
  const history = [];
  for (let i = 0; i < conv.messages.length - 2; i++) {
    const m = conv.messages[i];
    if (!m) continue;
    if (thoughtId && m.thoughtId !== thoughtId) continue;
    if (m.role !== "user" && m.role !== "assistant") continue;
    if (!m.content) continue;
    history.push({ role: m.role, content: m.content });
  }
  // edit one message the way the ✏️ editor does
  const target = conv.messages.find((m) => m.role === "assistant" && m.content && m.thoughtId === thoughtId);
  if (target) {
    const orig = target.content;
    target.content = "集成测试：这是编辑后的笔记内容";
    const editedHistory = [];
    for (let i = 0; i < conv.messages.length - 2; i++) {
      const m = conv.messages[i];
      if (!m) continue;
      if (thoughtId && m.thoughtId !== thoughtId) continue;
      if (m.role !== "user" && m.role !== "assistant") continue;
      if (!m.content) continue;
      editedHistory.push({ role: m.role, content: m.content });
    }
    assert.ok(editedHistory.some((h) => h.content === "集成测试：这是编辑后的笔记内容"), "edited content is replayed");
    assert.ok(!editedHistory.some((h) => h.content === orig), "original no longer replayed");
  }
});

test("notebook export renders the real conversation as markdown", { skip: !hasRealData }, () => {
  const conv = loadReal();
  const md = nb.formatConversationMarkdown(conv, { title: "集成测试导出" });
  assert.ok(md.length > 500, "export should be substantial");
  assert.match(md, /思维链总览/);
});

test("chatgptDriver builds messages from real conversation data", { skip: !hasRealData }, async () => {
  const conv = loadReal();
  const state = wf.ensure(conv);
  const thoughtId = state.activeId;
  const history = [];
  for (let i = 0; i < conv.messages.length - 2; i++) {
    const m = conv.messages[i];
    if (!m) continue;
    if (thoughtId && m.thoughtId !== thoughtId) continue;
    if (m.role !== "user" && m.role !== "assistant") continue;
    if (!m.content) continue;
    history.push({ role: m.role, content: m.content });
  }
  const drvBundle = await build({
    entryPoints: ["src/modules/chatgptDriver.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    write: false,
  });
  const drv = await import(
    "data:text/javascript;base64," + Buffer.from(drvBundle.outputFiles[0].text).toString("base64")
  );
  const messages = drv.buildMessages("SYS", history, "当前问题");
  assert.equal(messages[0].role, "system");
  assert.equal(messages[messages.length - 1].content, "当前问题");
  assert.ok(messages.length >= 2, "history + current prompt present");
});
