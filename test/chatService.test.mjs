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
                globalThis.__praSaves.push(JSON.parse(JSON.stringify(conv)));
              }
              export function getSessionHandle() { return null; }
              export function setSessionHandle() { return false; }
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

function scenario(terminalEvent) {
  const quote =
    "the proposed estimator consistently recovers the correct graph from observational samples";
  const answer = `Claim [p.5 "${quote}"]`;
  const pages = ["one", "two", "three", "four", "five", quote];
  const updates = [];
  const statuses = [];
  const events = [];
  const prompts = [];
  globalThis.__praSaves = [];
  globalThis.__praLoadCalls = [];
  globalThis.__praLoadedPages = pages;
  globalThis.__praBackend = {
    id: "fake",
    async runTurn(_opts, _workdir, _handle, backendPrompt, onEvent) {
      prompts.push(backendPrompt);
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
  return { quote, answer, pages, updates, statuses, events, prompts, conv, ui };
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
