import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

// Bundle chatgptDriver.ts to plain ESM (same pattern as the other driver
// tests). The pure functions (buildMessages / mapSSE / consumeSSE) run under
// Node; Zotero-only APIs (PathUtils/IOUtils/fetch) are only referenced inside
// functions that the tests never call.
const bundle = await build({
  entryPoints: ["src/modules/chatgptDriver.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false,
});
const mod = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].contents).toString("base64")
);

test("buildMessages: system + filtered history + current prompt", () => {
  const history = [
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1" },
    { role: "system", content: "should be dropped from history" },
    { role: "user", content: "" }, // empty — dropped
    { role: "user", content: "q2" },
  ];
  const messages = mod.buildMessages("SYS", history, "q3");
  assert.equal(messages.length, 5);
  assert.deepEqual(messages[0], { role: "system", content: "SYS" });
  assert.deepEqual(messages[1], { role: "user", content: "q1" });
  assert.deepEqual(messages[2], { role: "assistant", content: "a1" });
  assert.deepEqual(messages[3], { role: "user", content: "q2" });
  assert.deepEqual(messages[4], { role: "user", content: "q3" });
});

test("buildMessages: no system, no history", () => {
  const messages = mod.buildMessages("", null, "hello");
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], { role: "user", content: "hello" });
});

test("mapSSE: streaming delta chunks", () => {
  const evs = mod.mapSSE({
    choices: [{ delta: { content: "Hel" }, finish_reason: null }],
  });
  assert.deepEqual(evs, [{ kind: "delta", text: "Hel" }]);
});

test("mapSSE: finish_reason emits done", () => {
  const evs = mod.mapSSE({
    choices: [{ delta: { content: "" }, finish_reason: "stop" }],
  });
  assert.deepEqual(evs, [{ kind: "done" }]);
});

test("mapSSE: non-streaming completion", () => {
  const evs = mod.mapSSE({
    choices: [{ message: { content: "full answer" }, finish_reason: "stop" }],
  });
  assert.deepEqual(evs, [
    { kind: "delta", text: "full answer" },
    { kind: "done" },
  ]);
});

test("mapSSE: role-only chunk (empty content) must NOT emit done", () => {
  // The first streaming chunk often carries only {"delta":{"role":"assistant"}}.
  // Emitting done here would make runTurn break before any text arrives.
  const evs = mod.mapSSE({
    choices: [{ delta: { role: "assistant", content: "" }, finish_reason: null }],
  });
  assert.deepEqual(evs, []);
});

test("mapSSE: error envelope maps to friendly error", () => {
  const evs = mod.mapSSE({ error: { message: "rate limit exceeded" } });
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, "error");
  assert.match(evs[0].message, /rate limit/i);
});

test("mapSSE: 403 is described as token rejected", () => {
  const evs = mod.mapSSE({ error: { message: "HTTP 403 Forbidden" } });
  assert.equal(evs[0].kind, "error");
  assert.match(evs[0].message, /403/);
});

test("consumeSSE: parses multiple data lines and keeps partial tail", () => {
  const chunk =
    'data: {"choices":[{"delta":{"content":"a"}}]}\n' +
    'data: {"choices":[{"delta":{"content":"b"},"finish_reason":"stop"}]}\n' +
    'data: [DO';
  const res = mod.consumeSSE("", chunk);
  assert.equal(res.events.length, 3);
  assert.deepEqual(res.events[0], { kind: "delta", text: "a" });
  assert.deepEqual(res.events[1], { kind: "delta", text: "b" });
  assert.equal(res.events[2].kind, "done");
  assert.equal(res.buffer, "data: [DO");
});

test("consumeSSE: [DONE] marker ends the stream", () => {
  const res = mod.consumeSSE("", "data: [DONE]\n");
  assert.deepEqual(res.events, [{ kind: "done" }]);
});

test("consumeSSE: ignores non-data lines and empty payloads", () => {
  const chunk = ': keepalive\n\ndata: {"choices":[{"delta":{"content":"x"}}]}\n';
  const res = mod.consumeSSE("", chunk);
  assert.equal(res.events.length, 1);
  assert.equal(res.events[0].kind, "delta");
});

test("consumeSSE: chunk split across reads accumulates correctly", () => {
  let buf = "";
  let events = [];
  const r1 = mod.consumeSSE(buf, 'data: {"choices":[{"delta":{"content":"foo');
  buf = r1.buffer;
  events = events.concat(r1.events);
  const r2 = mod.consumeSSE(buf, '"}}]}\n');
  buf = r2.buffer;
  events = events.concat(r2.events);
  assert.deepEqual(events, [{ kind: "delta", text: "foo" }]);
  assert.equal(buf, "");
});

test("endpointOf: default and override", () => {
  assert.equal(mod.endpointOf({}), "http://127.0.0.1:5005/v1");
  assert.equal(mod.endpointOf({ chatgptEndpoint: "http://x:1234/v1/" }), "http://x:1234/v1");
  assert.equal(mod.endpointOf({ chatgptEndpoint: "http://x:1234/v1" }), "http://x:1234/v1");
});
