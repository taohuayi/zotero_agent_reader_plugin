import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/modules/chatService.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false,
  plugins: [
    {
      name: "chat-service-stubs",
      setup(buildApi) {
        buildApi.onResolve({ filter: /^\.\/store$/ }, () => ({
          path: "store",
          namespace: "pra-test",
        }));
        buildApi.onResolve({ filter: /^\.\/backends$/ }, () => ({
          path: "backends",
          namespace: "pra-test",
        }));
        buildApi.onResolve({ filter: /^\.\/pdfTextIndex$/ }, () => ({
          path: "pdfTextIndex",
          namespace: "pra-test",
        }));
        buildApi.onLoad({ filter: /^store$/, namespace: "pra-test" }, () => ({
          loader: "js",
          contents: `
              export async function save(conv) {
                globalThis.__praSaveCount += 1;
                if (globalThis.__praSaveFailureAt === globalThis.__praSaveCount) {
                  throw new Error("simulated disk failure");
                }
                globalThis.__praSaves.push(JSON.parse(JSON.stringify(conv)));
              }
              export function getSessionHandle(_conv, backend, thoughtId) {
                globalThis.__praHandleReads.push({ backend, thoughtId });
                return globalThis.__praResumeHandle || null;
              }
              export function setSessionHandle(_conv, backend, id, thoughtId) {
                globalThis.__praHandleWrites.push({ backend, id, thoughtId });
                return true;
              }
            `,
        }));
        buildApi.onLoad(
          { filter: /^backends$/, namespace: "pra-test" },
          () => ({
            loader: "js",
            contents:
              "export function getBackend() { return globalThis.__praBackend; }",
          }),
        );
        buildApi.onLoad(
          { filter: /^pdfTextIndex$/, namespace: "pra-test" },
          () => ({
            loader: "js",
            contents: `
              export async function loadPdfTextIndexPages(path) {
                globalThis.__praLoadCalls.push(path);
                return globalThis.__praLoadedPages;
              }
            `,
          }),
        );
      },
    },
  ],
});
const source = bundle.outputFiles[0].text;
const chatService = await import(
  "data:text/javascript;base64," + Buffer.from(source).toString("base64")
);

globalThis.PathUtils = { parent: () => "/papers" };

test("backend reminder is added without changing the stored user text", () => {
  assert.equal(chatService.buildBackendPrompt("hello", {}), "hello");
  const prompt = chatService.buildBackendPrompt("hello", {
    pageTextPath: "/work/paper-physical-pages.txt",
  });
  assert.match(prompt, /^hello\n\n/);
  assert.match(prompt, /<<<PRA_PHYSICAL_PDF_PAGE:N>>>/);
  assert.match(prompt, /never count form-feeds/);
});

test("continuous dialogue contract is appended to the backend prompt only", () => {
  const prompt = chatService.buildBackendPrompt(
    "what does this mean?",
    {},
    { readingMode: "deep", followup: true },
  );
  assert.match(prompt, /^what does this mean\?/);
  assert.match(prompt, /CONTINUOUS DEEP DIALOGUE/);
  assert.match(prompt, /Continue from this branch/);
});

function scenario(terminalEvent, runtimeInfo) {
  const quote =
    "the proposed estimator consistently recovers the correct graph from observational samples";
  const answer = `Claim [p.5 "${quote}"]`;
  const pages = ["one", "two", "three", "four", "five", quote];
  const updates = [];
  const statuses = [];
  const events = [];
  const prompts = [];
  const runtimeUpdates = [];
  globalThis.__praSaves = [];
  globalThis.__praSaveCount = 0;
  globalThis.__praSaveFailureAt = 0;
  globalThis.__praLoadCalls = [];
  globalThis.__praHandleReads = [];
  globalThis.__praHandleWrites = [];
  globalThis.__praResumeHandle = null;
  globalThis.__praLoadedPages = pages;
  globalThis.__praBackend = {
    id: "codex",
    async runTurn(_opts, _workdir, _handle, backendPrompt, onEvent) {
      prompts.push(backendPrompt);
      if (runtimeInfo) onEvent(runtimeInfo);
      onEvent({ kind: "delta", text: answer });
      onEvent(terminalEvent);
      return { exitCode: terminalEvent.kind === "error" ? 1 : 0 };
    },
  };
  const conv = { item_key: "ITEM", session_ids: {}, messages: [] };
  const ui = {
    onUser() {},
    onAssistantStart() {},
    onAssistantUpdate(text) {
      updates.push(text);
      events.push("update:" + text);
    },
    onRuntimeInfo(message, event) {
      runtimeUpdates.push({
        message: JSON.parse(JSON.stringify(message)),
        event: JSON.parse(JSON.stringify(event)),
      });
    },
    onStatus(text) {
      statuses.push(text);
      events.push("status:" + text);
    },
    onDone() {
      events.push("done");
    },
    onError(message) {
      events.push("error:" + message);
    },
  };
  return {
    quote,
    answer,
    pages,
    updates,
    statuses,
    events,
    prompts,
    runtimeUpdates,
    conv,
    ui,
  };
}

test("verifies, corrects, renders, and persists citations before done", async () => {
  const s = scenario({ kind: "done" });
  await chatService.runTurn(
    { backend: "fake" },
    {
      workdir: "/work",
      pdfPath: "/papers/test.pdf",
      pageTextPath: "/work/paper-physical-pages.txt",
    },
    s.conv,
    "question",
    null,
    s.ui,
    {},
  );

  const corrected = `Claim [p.6 "${s.quote}"]`;
  assert.deepEqual(s.updates, [s.answer, corrected]);
  assert.equal(s.conv.messages[0].content, "question");
  assert.match(s.prompts[0], /paper-physical-pages\.txt/);
  assert.match(s.prompts[0], /SAME page as the verbatim quote/);
  assert.deepEqual(globalThis.__praLoadCalls, [
    "/work/paper-physical-pages.txt",
  ]);
  assert.ok(s.statuses.includes("verifying citations…"));
  assert.equal(s.conv.messages[1].content, corrected);
  assert.equal(s.conv.messages[1].citations[0].status, "corrected");
  assert.equal(s.conv.messages[1].citations[0].reportedPage, 5);
  assert.equal(s.conv.messages[1].citations[0].resolvedPage, 6);
  assert.equal(globalThis.__praSaves.at(-1).messages[1].content, corrected);
  assert.ok(s.events.indexOf("update:" + corrected) < s.events.indexOf("done"));
});

test("also persists a corrected partial answer before reporting an error", async () => {
  const s = scenario({ kind: "error", message: "cancelled" });
  await chatService.runTurn(
    { backend: "fake" },
    { workdir: "/work", pageTextPages: s.pages },
    s.conv,
    "question",
    null,
    s.ui,
    {},
  );

  const corrected = `Claim [p.6 "${s.quote}"]`;
  assert.equal(s.conv.messages[1].content, corrected);
  assert.equal(globalThis.__praSaves.at(-1).messages[1].content, corrected);
  assert.equal(s.events.at(-1), "error:cancelled");
});

test("persists requested backend and actual runtime model on the response", async () => {
  const s = scenario(
    { kind: "done" },
    {
      kind: "runtime_info",
      backend: "codex",
      model: "gpt-5.6-codex",
      modelProvider: "openai",
      reasoningEffort: "high",
      source: "thread-settings",
    },
  );
  await chatService.runTurn(
    { backend: "codex", model: "gpt-5.6-codex" },
    { workdir: "/work", pageTextPages: s.pages },
    s.conv,
    "question",
    null,
    s.ui,
    {},
  );

  const response = s.conv.messages[1];
  assert.equal(response.backend, "codex");
  assert.equal(response.requestedModel, "gpt-5.6-codex");
  assert.equal(response.model, "gpt-5.6-codex");
  assert.equal(response.modelProvider, "openai");
  assert.equal(response.reasoningEffort, "high");
  assert.equal(response.modelSource, "thread-settings");
  assert.equal(s.runtimeUpdates.length, 1);
  assert.equal(globalThis.__praSaves.at(-1).messages[1].model, "gpt-5.6-codex");
});

test("visible line ids stay distinct while the backend resumes by thought id", async () => {
  const s = scenario({ kind: "done" });
  globalThis.__praResumeHandle = "resume-root-thought";
  let receivedHandle = null;
  globalThis.__praBackend = {
    id: "codex",
    async runTurn(_opts, _workdir, handle, _prompt, onEvent) {
      receivedHandle = handle;
      onEvent({ kind: "thread_started", sessionId: "continued-session" });
      onEvent({ kind: "delta", text: "continued answer" });
      onEvent({ kind: "done" });
      return { exitCode: 0 };
    },
  };

  await chatService.runTurn(
    { backend: "codex" },
    { workdir: "/work" },
    s.conv,
    "follow-up question",
    null,
    s.ui,
    {},
    {
      readingMode: "deep",
      questionId: "q2",
      lineId: "q2",
      thoughtId: "q1",
      followup: true,
    },
  );

  assert.equal(receivedHandle, "resume-root-thought");
  assert.deepEqual(globalThis.__praHandleReads, [
    { backend: "codex", thoughtId: "q1" },
  ]);
  assert.deepEqual(globalThis.__praHandleWrites, [
    {
      backend: "codex",
      id: "continued-session",
      thoughtId: "q1",
    },
  ]);
  assert.deepEqual(
    s.conv.messages.map((message) => [message.lineId, message.thoughtId]),
    [
      ["q2", "q1"],
      ["q2", "q1"],
    ],
  );
});

test("an initial persistence failure is visible and prevents backend execution", async () => {
  const s = scenario({ kind: "done" });
  let backendRuns = 0;
  globalThis.__praSaveFailureAt = 1;
  globalThis.__praBackend = {
    id: "codex",
    async runTurn() {
      backendRuns += 1;
      return { exitCode: 0 };
    },
  };

  await assert.rejects(
    chatService.runTurn(
      { backend: "codex" },
      { workdir: "/work" },
      s.conv,
      "must remain local",
      null,
      s.ui,
      {},
      { lineId: "q1", thoughtId: "q1" },
    ),
    /simulated disk failure/,
  );

  assert.equal(backendRuns, 0);
  assert.match(s.events.at(-1), /^error:保存失败（发送前）/);
});

test("an intermediate persistence failure is caught and reported through status", async () => {
  const s = scenario({ kind: "done" });
  // First save is required before sending; the thread_started save is second.
  globalThis.__praSaveFailureAt = 2;
  globalThis.__praBackend = {
    id: "codex",
    async runTurn(_opts, _workdir, _handle, _prompt, onEvent) {
      onEvent({ kind: "thread_started", sessionId: "session-1" });
      onEvent({ kind: "delta", text: "answer" });
      onEvent({ kind: "done" });
      return { exitCode: 0 };
    },
  };

  await chatService.runTurn(
    { backend: "codex" },
    { workdir: "/work" },
    s.conv,
    "question",
    null,
    s.ui,
    {},
    { lineId: "q1", thoughtId: "q1" },
  );
  await Promise.resolve();

  assert.ok(
    s.statuses.some((status) => status.startsWith("保存失败（记录会话）")),
  );
  assert.equal(s.events.at(-1), "done");
});

test("a final persistence failure reports an error instead of false completion", async () => {
  const s = scenario({ kind: "done" });
  globalThis.__praSaveFailureAt = 2;

  await assert.rejects(
    chatService.runTurn(
      { backend: "codex" },
      { workdir: "/work", pageTextPages: s.pages },
      s.conv,
      "question",
      null,
      s.ui,
      {},
      { lineId: "q1", thoughtId: "q1" },
    ),
    /simulated disk failure/,
  );

  assert.match(s.events.at(-1), /^error:保存失败（完成回答）/);
  assert.equal(s.events.includes("done"), false);
});
