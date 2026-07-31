import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/modules/composerDraft.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false,
});
const drafts = await import(
  "data:text/javascript;base64," +
    Buffer.from(bundle.outputFiles[0].text).toString("base64")
);

test("a missing draft is compatible with existing conversation data", () => {
  const conv = {
    item_key: "PAPER1",
    messages: [{ role: "user", content: "kept" }],
    reading: { threads: [] },
  };
  assert.equal(drafts.getComposerDraft(conv), null);
  assert.equal(drafts.clearComposerDraft(conv), false);
  assert.deepEqual(conv.messages, [{ role: "user", content: "kept" }]);
});

test("draft text and its branch context survive JSON persistence", () => {
  const conv = { item_key: "PAPER1", messages: [] };
  assert.equal(
    drafts.setComposerDraft(
      conv,
      "  为什么这里要取倒数？\n",
      {
        lineId: "q7",
        branchNext: true,
        branchOrigin: "想到倒数的原因，是倒数恰好等于共轭式。",
        branchOriginRole: "assistant",
        nextAnchor: { page: "11", quote: "exact quote" },
      },
      "2026-07-31T01:02:03.000Z",
    ),
    true,
  );

  const restored = JSON.parse(JSON.stringify(conv));
  assert.deepEqual(drafts.getComposerDraft(restored), {
    version: 2,
    text: "  为什么这里要取倒数？\n",
    lineId: "q7",
    branchNext: true,
    branchOrigin: "想到倒数的原因，是倒数恰好等于共轭式。",
    branchOriginRole: "assistant",
    nextAnchor: { page: 11, quote: "exact quote" },
    updatedAt: "2026-07-31T01:02:03.000Z",
  });
  assert.deepEqual(restored.messages, []);
});

test("setting the same draft does not rewrite its timestamp", () => {
  const conv = {};
  drafts.setComposerDraft(
    conv,
    "unfinished",
    { lineId: "q2" },
    "2026-07-31T01:00:00.000Z",
  );
  assert.equal(
    drafts.setComposerDraft(
      conv,
      "unfinished",
      { lineId: "q2" },
      "2026-07-31T02:00:00.000Z",
    ),
    false,
  );
  assert.equal(conv.composerDraft.updatedAt, "2026-07-31T01:00:00.000Z");
});

test("an accepted or parked draft can be cleared without touching notes", () => {
  const conv = {
    messages: [{ role: "assistant", content: "full old answer" }],
    reading: { activeId: "q1" },
  };
  drafts.setComposerDraft(conv, "send me", null, "2026-07-31T01:00:00.000Z");
  assert.equal(drafts.clearComposerDraft(conv), true);
  assert.equal(drafts.getComposerDraft(conv), null);
  assert.deepEqual(conv.messages, [
    { role: "assistant", content: "full old answer" },
  ]);
  assert.deepEqual(conv.reading, { activeId: "q1" });
});

test("send acknowledgement clears only the submitted draft, not newer typing", () => {
  const conv = {};
  drafts.setComposerDraft(
    conv,
    "first question",
    null,
    "2026-07-31T01:00:00.000Z",
  );
  assert.equal(
    drafts.clearComposerDraftIfMatches(conv, "first question"),
    true,
  );

  drafts.setComposerDraft(
    conv,
    "a newer question",
    null,
    "2026-07-31T01:01:00.000Z",
  );
  assert.equal(
    drafts.clearComposerDraftIfMatches(conv, "first question"),
    false,
  );
  assert.equal(drafts.getComposerDraft(conv).text, "a newer question");
});

test("legacy string and v1 thoughtId drafts migrate to a v2 lineId", () => {
  const conv = { composerDraft: "legacy draft" };
  assert.equal(drafts.getComposerDraft(conv).text, "legacy draft");
  drafts.setComposerDraft(
    conv,
    "edited draft",
    { lineId: "q3" },
    "2026-07-31T01:00:00.000Z",
  );
  assert.equal(conv.composerDraft.version, 2);
  assert.equal(conv.composerDraft.lineId, "q3");

  const v1 = {
    composerDraft: {
      version: 1,
      text: "v1 draft",
      thoughtId: "q4",
      updatedAt: "2026-07-31T01:00:00.000Z",
    },
  };
  assert.equal(drafts.getComposerDraft(v1).lineId, "q4");
  assert.equal(drafts.getComposerDraft(v1).thoughtId, undefined);
});
