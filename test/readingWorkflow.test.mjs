import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/modules/readingWorkflow.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false,
});
const workflow = await import(
  "data:text/javascript;base64," +
    Buffer.from(bundle.outputFiles[0].text).toString("base64")
);

test("initializes a reading state and parks categorized questions", () => {
  const conv = {};
  const state = workflow.ensure(conv);
  assert.equal(state.mode, "deep");
  assert.deepEqual(state.parkingLot, []);

  const later = workflow.park(conv, "Does this block the proof?", "later");
  const branch = workflow.park(
    conv,
    "Is this related to Fourier analysis?",
    "branch",
  );
  assert.equal(later.category, "later");
  assert.equal(branch.category, "branch");
  assert.equal(state.parkingLot.length, 2);
  assert.equal(workflow.takeParked(conv, later.id).question, later.question);
  assert.equal(state.parkingLot.length, 1);
});

test("each follow-up creates a causal line node while retaining one backend thought", () => {
  const conv = { messages: [] };
  const current = workflow.beginQuestion(conv, "Why introduce this variable?");
  workflow.finishAnswer(conv, {
    content:
      'It creates a second equation so the unknown expressions can be eliminated. [p.7 "substituting the reciprocal yields the companion equation"]',
    lineId: current.id,
  });
  assert.equal(workflow.activeThread(conv).id, current.id);
  assert.equal(workflow.activeThread(conv).anchor.page, 7);
  assert.match(workflow.activeThread(conv).summary, /second equation/);

  const followup = workflow.beginQuestion(conv, "expand", "deep", {
    followup: true,
    originExcerpt: "the unknown expressions can be eliminated",
    originRole: "assistant",
  });
  assert.notEqual(followup.id, current.id);
  assert.equal(followup.lineId, followup.id);
  assert.equal(followup.parentId, current.id);
  assert.equal(followup.thoughtId, current.thoughtId);
  assert.equal(
    followup.originExcerpt,
    "the unknown expressions can be eliminated",
  );
  assert.equal(followup.originRole, "assistant");
  assert.equal(workflow.activeThread(conv).id, followup.id);
  assert.equal(workflow.thoughtIdForLine(conv, followup.id), current.id);
  assert.equal(current.status, "paused");
});

test("branches preserve ancestry while transcripts remain isolated", () => {
  const conv = { messages: [] };
  const root = workflow.beginQuestion(conv, "How was this substitution found?");
  conv.messages.push({ role: "user", content: "root", thoughtId: root.id });
  workflow.finishAnswer(conv, { content: "Try squaring first." });

  const branch = workflow.beginQuestion(
    conv,
    "Is this really a hyperbolic function?",
    "deep",
    {
      branch: true,
      originExcerpt:
        "From a higher viewpoint, this expression is a hyperbolic function.",
      originRole: "assistant",
    },
  );
  conv.messages.push({ role: "user", content: "branch", thoughtId: branch.id });

  assert.equal(branch.parentId, root.id);
  assert.equal(root.thoughtId, root.id);
  assert.equal(branch.thoughtId, branch.id);
  assert.equal(
    branch.originExcerpt,
    "From a higher viewpoint, this expression is a hyperbolic function.",
  );
  assert.equal(branch.originRole, "assistant");
  assert.deepEqual(
    workflow.ancestry(conv, branch.id).map((thread) => thread.id),
    [root.id, branch.id],
  );
  assert.deepEqual(
    workflow.messagesForActive(conv).map((message) => message.content),
    ["branch"],
  );
  assert.match(workflow.branchContext(conv, branch.id), /Try squaring first/);
  assert.match(
    workflow.branchContext(conv, branch.id),
    /Prompted by this exact earlier passage/,
  );

  workflow.switchThread(conv, root.id);
  assert.deepEqual(
    workflow.messagesForActive(conv).map((message) => message.content),
    ["root"],
  );
});

test("legacy node ids migrate into explicit line and thought ids without losing messages", () => {
  const conv = {
    messages: [
      { role: "user", content: "legacy question", thoughtId: "q1" },
      { role: "assistant", content: "legacy answer", thoughtId: "q1" },
    ],
    reading: {
      mode: "deep",
      sequence: 1,
      activeId: "q1",
      parkingLot: [],
      threads: [{ id: "q1", parentId: null, title: "legacy" }],
    },
  };

  workflow.ensure(conv);

  assert.equal(conv.reading.threads[0].lineId, "q1");
  assert.equal(conv.reading.threads[0].thoughtId, "q1");
  assert.deepEqual(
    conv.messages.map((message) => [message.lineId, message.thoughtId]),
    [
      ["q1", "q1"],
      ["q1", "q1"],
    ],
  );
  assert.equal(workflow.messagesForActive(conv).length, 2);
});

test("messages attach to visible line ids even when follow-ups share a thought id", () => {
  const conv = { messages: [] };
  const root = workflow.beginQuestion(conv, "root");
  const followup = workflow.beginQuestion(conv, "follow-up", "deep", {
    followup: true,
  });
  conv.messages.push(
    {
      role: "user",
      content: "root message",
      lineId: root.id,
      thoughtId: root.thoughtId,
    },
    {
      role: "user",
      content: "follow-up message",
      lineId: followup.id,
      thoughtId: followup.thoughtId,
    },
  );

  assert.equal(root.thoughtId, followup.thoughtId);
  assert.deepEqual(
    workflow.messagesForActive(conv).map((message) => message.content),
    ["follow-up message"],
  );
  workflow.switchThread(conv, root.id);
  assert.deepEqual(
    workflow.messagesForActive(conv).map((message) => message.content),
    ["root message"],
  );
});

test("orders a thought map as a parent-first outline, not flat chronology", () => {
  const conv = {
    reading: {
      mode: "deep",
      sequence: 5,
      activeId: "root",
      parkingLot: [],
      threads: [
        { id: "root", parentId: null, title: "root" },
        { id: "a", parentId: "root", title: "branch A" },
        { id: "b", parentId: "root", title: "branch B" },
        // Chronologically late, but intellectually belongs directly below A.
        { id: "a1", parentId: "a", title: "detail A1" },
        { id: "orphan", parentId: "missing", title: "orphan" },
      ],
    },
  };
  assert.deepEqual(
    workflow.orderedThreads(conv).map((thread) => thread.id),
    ["root", "a", "a1", "b", "orphan"],
  );
});

test("lays out unary reasoning as a route and real branches as separate lanes", () => {
  const conv = {
    reading: {
      mode: "deep",
      sequence: 6,
      activeId: "root",
      parkingLot: [],
      threads: [
        { id: "root", parentId: null, title: "root" },
        { id: "main", parentId: "root", title: "main" },
        { id: "a", parentId: "main", title: "A" },
        { id: "a1", parentId: "a", title: "A1" },
        { id: "b", parentId: "main", title: "B" },
        { id: "c", parentId: "main", title: "C" },
      ],
    },
  };
  const layout = workflow.mindMapLayout(conv);
  const p = new Map(layout.nodes.map((node) => [node.thread.id, node]));
  assert.equal(p.get("root").column, 0);
  assert.equal(p.get("main").column, 1);
  assert.equal(p.get("a").column, 2);
  assert.equal(p.get("a1").column, 3);
  assert.equal(p.get("a").row, p.get("a1").row);
  assert.notEqual(p.get("a").row, p.get("b").row);
  assert.equal(layout.edges.length, 5);
});

test("continuous mode asks for an authentic, contextual discovery process", () => {
  const instruction = workflow.responseInstruction("deep", true);
  assert.match(instruction, /CONTINUOUS DEEP DIALOGUE/);
  assert.match(instruction, /authentic discovery process/);
  assert.match(instruction, /Continue from this branch/);
  assert.doesNotMatch(instruction, /no more than 3 sentences/);
});

// ── manual editing / restructuring ──

function treeConv() {
  return {
    messages: [],
    reading: {
      mode: "deep",
      sequence: 6,
      activeId: "root",
      parkingLot: [],
      threads: [
        { id: "root", parentId: null, title: "root", rootQuestion: "root q" },
        { id: "main", parentId: "root", title: "main", rootQuestion: "main q" },
        { id: "a", parentId: "main", title: "A", rootQuestion: "a q" },
        { id: "a1", parentId: "a", title: "A1", rootQuestion: "a1 q" },
        { id: "b", parentId: "main", title: "B", rootQuestion: "b q" },
      ],
    },
  };
}

test("updateThreadTitle rewrites the title but keeps rootQuestion verbatim", () => {
  const conv = treeConv();
  assert.equal(workflow.updateThreadTitle(conv, "a", "  新标题  "), true);
  const t = workflow.ensure(conv).threads.find((x) => x.id === "a");
  assert.equal(t.title, "新标题");
  assert.equal(t.rootQuestion, "a q");
  assert.equal(workflow.updateThreadTitle(conv, "a", "   "), false); // empty rejected
  assert.equal(workflow.updateThreadTitle(conv, "nope", "x"), false); // unknown id
});

test("updateThreadSummary edits derived text only", () => {
  const conv = treeConv();
  assert.equal(workflow.updateThreadSummary(conv, "b", "新摘要"), true);
  assert.equal(workflow.ensure(conv).threads.find((x) => x.id === "b").summary, "新摘要");
});

test("reparentThread moves a node, refuses cycles and unknown parents", () => {
  const conv = treeConv();
  assert.equal(workflow.reparentThread(conv, "a1", "b"), true);
  assert.equal(workflow.ensure(conv).threads.find((x) => x.id === "a1").parentId, "b");
  // cycle: moving main under its own descendant a1 would loop
  assert.equal(workflow.reparentThread(conv, "main", "a1"), false);
  assert.equal(workflow.reparentThread(conv, "main", "nope"), false);
  // promote to root
  assert.equal(workflow.reparentThread(conv, "main", null), true);
  assert.equal(workflow.ensure(conv).threads.find((x) => x.id === "main").parentId, null);
});

test("isDescendant detects ancestor chains", () => {
  const conv = treeConv();
  assert.equal(workflow.isDescendant(conv, "root", "a1"), true);
  assert.equal(workflow.isDescendant(conv, "a", "a1"), true);
  assert.equal(workflow.isDescendant(conv, "a1", "a"), false);
  assert.equal(workflow.isDescendant(conv, "a", "b"), false);
});

test("removeThread deletes the whole subtree, messages stay", () => {
  const conv = treeConv();
  conv.messages.push({ role: "user", content: "hi", thoughtId: "a" });
  assert.equal(workflow.removeThread(conv, "a"), true);
  const ids = workflow.ensure(conv).threads.map((x) => x.id);
  assert.ok(!ids.includes("a"));
  assert.ok(!ids.includes("a1"));
  assert.ok(ids.includes("main"));
  assert.ok(ids.includes("b"));
  assert.equal(conv.messages.length, 1); // messages preserved
  assert.equal(workflow.removeThread(conv, "nope"), false);
});

test("insertThread creates a fresh isolated thought under a parent", () => {
  const conv = treeConv();
  const created = workflow.insertThread(conv, " 新问题 ", "main");
  assert.ok(created);
  assert.equal(created.parentId, "main");
  assert.equal(created.thoughtId, created.id); // new thought = isolated session
  assert.equal(workflow.ensure(conv).activeId, created.id);
  assert.equal(workflow.insertThread(conv, "   ", "main"), null); // blank rejected
});

