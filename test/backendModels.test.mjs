import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

async function bundleModule(entryPoint) {
  const bundle = await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    write: false,
    plugins: [
      {
        name: "codex-env-stub",
        setup(buildApi) {
          buildApi.onResolve({ filter: /^\.\/codexEnv$/ }, () => ({
            path: "codexEnv",
            namespace: "pra-test",
          }));
          buildApi.onLoad(
            { filter: /^codexEnv$/, namespace: "pra-test" },
            () => ({
              loader: "js",
              contents: `
                export async function resolveCodex() { throw new Error("not used"); }
                export async function resolveClaude() { throw new Error("not used"); }
              `,
            }),
          );
        },
      },
    ],
  });
  return import(
    "data:text/javascript;base64," +
      Buffer.from(bundle.outputFiles[0].text).toString("base64")
  );
}

const claude = await bundleModule("src/modules/claudeDriver.ts");
const appServer = await bundleModule("src/modules/appServer.ts");

test("Claude sends an explicit model per turn and leaves default blank", () => {
  const selected = claude.buildArgv("/work", null, "hello", {
    claudeModel: "opus",
    webSearch: false,
  });
  assert.deepEqual(
    selected.slice(
      selected.indexOf("--model"),
      selected.indexOf("--model") + 2,
    ),
    ["--model", "opus"],
  );

  const defaulted = claude.buildArgv("/work", null, "hello", {
    webSearch: false,
  });
  assert.equal(defaulted.includes("--model"), false);
});

test("Claude assistant metadata reports model without duplicating answer text", () => {
  assert.deepEqual(
    claude.mapLine({
      type: "assistant",
      message: {
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "duplicate full answer" }],
      },
    }),
    [
      {
        kind: "runtime_info",
        backend: "claude",
        model: "claude-opus-4-8",
        source: "assistant-message",
      },
    ],
  );
  assert.deepEqual(
    claude.mapLine({ type: "assistant", message: { model: "<synthetic>" } }),
    [],
  );
});

test("Claude init can report both session and concrete model", () => {
  assert.deepEqual(
    claude.mapLine({
      type: "system",
      subtype: "init",
      session_id: "session-1",
      model: "claude-sonnet-5-0",
    }),
    [
      { kind: "thread_started", sessionId: "session-1" },
      {
        kind: "runtime_info",
        backend: "claude",
        model: "claude-sonnet-5-0",
        source: "system-init",
      },
    ],
  );
});

test("Codex turn params switch or clear model per turn and preserve effort rules", () => {
  const input = [{ type: "text", text: "hello" }];
  assert.deepEqual(
    appServer.buildTurnParams(
      "thread-1",
      input,
      { model: "gpt-selected", reasoningEffort: "high" },
      "gpt-selected",
    ),
    {
      threadId: "thread-1",
      input,
      model: "gpt-selected",
      effort: "high",
    },
  );
  assert.deepEqual(appServer.buildTurnParams("thread-1", input, {}, null), {
    threadId: "thread-1",
    input,
    model: null,
  });
  assert.equal(
    appServer.buildTurnParams(
      "thread-1",
      input,
      { reasoningEffort: "minimal", webSearch: true },
      "gpt-default",
    ).effort,
    "low",
  );
  assert.equal(
    appServer.buildTurnParams(
      "thread-1",
      input,
      { reasoningEffort: "minimal", webSearch: false },
      "gpt-default",
    ).effort,
    "minimal",
  );
});

function addDirs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--add-dir") out.push(argv[i + 1]);
  }
  return out;
}

test("Claude is granted every directory it must read, minimally", () => {
  const argv = claude.buildArgv("/work", null, "hi", {
    webSearch: false,
    addDir: "/storage/ABCD", // the PDF's directory…
    addDirs: ["/data/library", "/storage"], // …lives under the storage grant
    images: ["/work/images/a.png", "/tmp/shot.png"],
  });
  // --add-dir is recursive: /storage subsumes /storage/ABCD, /work subsumes
  // /work/images. Only /tmp is genuinely new.
  assert.deepEqual(addDirs(argv), [
    "/work",
    "/data/library",
    "/storage",
    "/tmp",
  ]);
});

test("a directory named twice is granted once", () => {
  const argv = claude.buildArgv("/work", null, "hi", {
    webSearch: false,
    addDir: "/work",
    addDirs: ["/work", "/data/library", "/data/library"],
    images: ["/work/a.png"],
  });
  assert.deepEqual(addDirs(argv), ["/work", "/data/library"]);
});

test("a sibling with a shared prefix is not mistaken for a child", () => {
  const argv = claude.buildArgv("/work", null, "hi", {
    webSearch: false,
    addDirs: ["/workshop", "/work-2"],
  });
  assert.deepEqual(addDirs(argv), ["/work", "/workshop", "/work-2"]);
});

test("library search needs rg, and Bash stays scoped to read-only commands", () => {
  const argv = claude.buildArgv("/work", null, "hi", { webSearch: false });
  const allowed = argv.slice(
    argv.indexOf("--allowedTools") + 1,
    argv.indexOf("--disallowedTools"),
  );
  assert.ok(allowed.includes("Bash(rg:*)"));
  assert.ok(allowed.includes("Bash(pdftotext:*)"));
  // no unscoped Bash — the agent must not be able to route a write through it
  assert.ok(!allowed.includes("Bash"));
  const denied = argv.slice(argv.indexOf("--disallowedTools") + 1, -2);
  assert.ok(denied.includes("Write"));
});
