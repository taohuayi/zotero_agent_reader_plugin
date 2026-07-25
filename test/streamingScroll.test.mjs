import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/modules/streamingScroll.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false,
});
const streamingScroll = await import(
  "data:text/javascript;base64," +
    Buffer.from(bundle.outputFiles[0].text).toString("base64")
);

function makeViewport({ scrollTop, scrollHeight, clientHeight }) {
  let currentScrollTop = scrollTop;

  return {
    scrollHeight,
    clientHeight,
    get scrollTop() {
      return currentScrollTop;
    },
    set scrollTop(next) {
      const maxScrollTop = Math.max(0, this.scrollHeight - this.clientHeight);
      currentScrollTop = Math.max(0, Math.min(Number(next) || 0, maxScrollTop));
    },
  };
}

test("bottom detection uses a small tolerance and handles short content", () => {
  assert.equal(
    streamingScroll.isAtScrollBottom(
      makeViewport({ scrollTop: 400, scrollHeight: 500, clientHeight: 100 }),
    ),
    true,
  );
  assert.equal(
    streamingScroll.isAtScrollBottom(
      makeViewport({ scrollTop: 398, scrollHeight: 500, clientHeight: 100 }),
    ),
    true,
  );
  assert.equal(
    streamingScroll.isAtScrollBottom(
      makeViewport({ scrollTop: 397, scrollHeight: 500, clientHeight: 100 }),
    ),
    false,
  );
  assert.equal(
    streamingScroll.isAtScrollBottom(
      makeViewport({ scrollTop: 0, scrollHeight: 80, clientHeight: 100 }),
    ),
    true,
  );
});

test("a viewport at the bottom follows growing streamed content", () => {
  const viewport = makeViewport({
    scrollTop: 400,
    scrollHeight: 500,
    clientHeight: 100,
  });

  streamingScroll.preserveStreamingScroll(viewport, () => {
    viewport.scrollHeight = 650;
  });

  assert.equal(viewport.scrollTop, 550);
});

test("a newly inserted assistant row establishes follow mode before its first token", () => {
  const viewport = makeViewport({
    scrollTop: 400,
    scrollHeight: 500,
    clientHeight: 100,
  });

  viewport.scrollHeight = 550;
  streamingScroll.scrollToBottom(viewport);
  assert.equal(viewport.scrollTop, 450);

  streamingScroll.preserveStreamingScroll(viewport, () => {
    viewport.scrollHeight = 650;
  });

  assert.equal(viewport.scrollTop, 550);
});

test("streaming preserves the reader's position after they scroll up", () => {
  const viewport = makeViewport({
    scrollTop: 250,
    scrollHeight: 500,
    clientHeight: 100,
  });

  streamingScroll.preserveStreamingScroll(viewport, () => {
    viewport.scrollHeight = 650;
    viewport.scrollTop = 550;
  });

  assert.equal(viewport.scrollTop, 250);
});

test("successive updates preserve the reader's latest upward or downward position", () => {
  const viewport = makeViewport({
    scrollTop: 250,
    scrollHeight: 600,
    clientHeight: 100,
  });

  streamingScroll.preserveStreamingScroll(viewport, () => {
    viewport.scrollHeight = 650;
  });
  assert.equal(viewport.scrollTop, 250);

  viewport.scrollTop = 140;
  streamingScroll.preserveStreamingScroll(viewport, () => {
    viewport.scrollHeight = 700;
  });
  assert.equal(viewport.scrollTop, 140);

  viewport.scrollTop = 320;
  streamingScroll.preserveStreamingScroll(viewport, () => {
    viewport.scrollHeight = 750;
  });
  assert.equal(viewport.scrollTop, 320);
});

test("following resumes after the reader returns to the bottom", () => {
  const viewport = makeViewport({
    scrollTop: 250,
    scrollHeight: 600,
    clientHeight: 100,
  });

  streamingScroll.preserveStreamingScroll(viewport, () => {
    viewport.scrollHeight = 650;
  });
  assert.equal(viewport.scrollTop, 250);

  viewport.scrollTop = 550;
  streamingScroll.preserveStreamingScroll(viewport, () => {
    viewport.scrollHeight = 700;
  });
  assert.equal(viewport.scrollTop, 600);
});

test("scroll state is restored even if rendering throws", () => {
  const viewport = makeViewport({
    scrollTop: 250,
    scrollHeight: 600,
    clientHeight: 100,
  });

  assert.throws(
    () =>
      streamingScroll.preserveStreamingScroll(viewport, () => {
        viewport.scrollHeight = 700;
        viewport.scrollTop = 600;
        throw new Error("render failed");
      }),
    /render failed/,
  );
  assert.equal(viewport.scrollTop, 250);
});
