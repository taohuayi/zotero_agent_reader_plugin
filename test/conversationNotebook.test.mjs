import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/modules/conversationNotebook.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false,
});
const notebook = await import(
  "data:text/javascript;base64," +
    Buffer.from(bundle.outputFiles[0].text).toString("base64")
);

function fixture() {
  return {
    import_metadata: {
      source: "chatgpt-conversation://example",
      source_title: "代数变形思路解析",
    },
    messages: [
      {
        role: "user",
        content: "为什么想到取倒数？",
        thoughtId: "q1",
      },
      {
        role: "assistant",
        content: "因为共轭乘积等于 \(1\)，所以倒数会制造第二个式子。",
        verbatimContent:
          "因为共轭乘积等于 \(1\)，所以倒数会制造第二个式子。\n\n这是完整逐字补充。",
        thoughtId: "q1",
      },
      {
        role: "user",
        content: "这个构造为什么不平凡？",
        thoughtId: "q2",
      },
      {
        role: "assistant",
        content: "首次发现通常来自移项平方，之后才提炼出共轭结构。",
        verbatimContent: "首次发现通常来自移项平方，之后才提炼出共轭结构。",
        thoughtId: "q2",
      },
      {
        role: "user",
        content: "它与双曲函数有什么关系？",
        thoughtId: "q3",
      },
      {
        role: "assistant",
        content: "它就是反双曲正弦函数。",
        thoughtId: "q3",
      },
    ],
    reading: {
      mode: "deep",
      sequence: 3,
      activeId: "q2",
      threads: [
        {
          id: "q1",
          parentId: null,
          title: "代数变形的目标链",
          rootQuestion: "为什么想到取倒数？",
          status: "paused",
        },
        {
          id: "q2",
          parentId: "q1",
          title: "构造共轭式为何不平凡",
          rootQuestion: "这个构造为什么不平凡？",
          originExcerpt: "想到倒数的原因，是倒数恰好等于共轭式。",
          originRole: "assistant",
          status: "active",
        },
        {
          id: "q3",
          parentId: "q1",
          title: "双曲函数背景",
          rootQuestion: "它与双曲函数有什么关系？",
          originExcerpt: "从更高层看，它其实是双曲函数。",
          originRole: "assistant",
          status: "paused",
        },
      ],
      parkingLot: [
        {
          id: "q4",
          question: "之后研究佩尔方程与这套结构的关系。",
          category: "later",
          parentId: "q2",
          anchor: { page: 11 },
        },
      ],
    },
  };
}

test("messagesForView supports node, ancestry path, and complete conversation", () => {
  const conv = fixture();

  assert.deepEqual(
    notebook.messagesForView(conv, "node").map((message) => message.content),
    [
      "这个构造为什么不平凡？",
      "首次发现通常来自移项平方，之后才提炼出共轭结构。",
    ],
  );
  assert.deepEqual(
    notebook.messagesForView(conv, "path").map((message) => message.thoughtId),
    ["q1", "q1", "q2", "q2"],
  );
  assert.equal(notebook.messagesForView(conv, "all").length, 6);
});

test("node and path views use lineId while preserving a shared backend thoughtId", () => {
  const conv = fixture();
  conv.reading.sequence = 5;
  conv.reading.activeId = "q5";
  conv.reading.threads.push({
    id: "q5",
    lineId: "q5",
    thoughtId: "q2",
    parentId: "q2",
    title: "继续追问首次发现过程",
    rootQuestion: "能否再展开首次发现过程？",
    status: "active",
  });
  conv.messages.push(
    {
      role: "user",
      content: "能否再展开首次发现过程？",
      lineId: "q5",
      thoughtId: "q2",
    },
    {
      role: "assistant",
      content: "可以，从最机械的移项平方开始。",
      lineId: "q5",
      thoughtId: "q2",
    },
  );

  assert.deepEqual(
    notebook.messagesForView(conv, "node").map((message) => message.lineId),
    ["q5", "q5"],
  );
  assert.deepEqual(
    notebook
      .messagesForView(conv, "path")
      .map((message) => message.lineId || message.thoughtId),
    ["q1", "q1", "q2", "q2", "q5", "q5"],
  );

  const hit = notebook.searchConversation(conv, "机械的移项平方")[0];
  assert.equal(hit.lineId, "q5");
  assert.equal(hit.thoughtId, "q2");

  const markdown = notebook.formatConversationMarkdown(conv, {});
  assert.match(markdown, /- 节点：q5/);
  assert.match(markdown, /- 连续会话：q2/);
  assert.match(markdown, /可以，从最机械的移项平方开始。/);
});

test("searchConversation searches canonical, verbatim, title, and origin text", () => {
  const conv = fixture();

  const content = notebook.searchConversation(conv, "移项平方");
  assert.equal(content.length, 1);
  assert.equal(content[0].thoughtId, "q2");
  assert.equal(content[0].messageIndex, 3);
  assert.equal(content[0].role, "assistant");
  assert.equal(content[0].field, "content");

  const verbatim = notebook.searchConversation(conv, "完整逐字补充");
  assert.equal(verbatim.length, 1);
  assert.equal(verbatim[0].messageIndex, 1);
  assert.equal(verbatim[0].field, "verbatimContent");

  const title = notebook.searchConversation(conv, "双曲函数背景");
  assert.equal(title.length, 1);
  assert.equal(title[0].thoughtId, "q3");
  assert.equal(title[0].messageIndex, -1);
  assert.equal(title[0].role, "thread");
  assert.equal(title[0].field, "thread.title");

  const origin = notebook.searchConversation(conv, "恰好等于共轭式");
  assert.equal(origin.length, 1);
  assert.equal(origin[0].thoughtId, "q2");
  assert.equal(origin[0].role, "assistant");
  assert.equal(origin[0].field, "thread.originExcerpt");
});

test("searchConversation skips a duplicate verbatim layer", () => {
  const hits = notebook.searchConversation(fixture(), "首次发现通常");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].field, "content");
});

test("formatConversationMarkdown exports the full tree and every text layer", () => {
  const conv = fixture();
  const markdown = notebook.formatConversationMarkdown(conv, {
    paperTitle: "高等数学",
    exportedAt: "2026-07-31T02:00:00+08:00",
  });

  assert.match(markdown, /^# 代数变形思路解析/m);
  assert.match(markdown, /- 论文：高等数学/);
  assert.match(markdown, /- \[q1\] 代数变形的目标链/);
  assert.match(markdown, /  - \[q2\] 构造共轭式为何不平凡/);
  assert.match(markdown, /  - \[q3\] 双曲函数背景/);
  assert.ok(
    markdown.indexOf("1. 代数变形的目标链") <
      markdown.indexOf("2. 构造共轭式为何不平凡"),
  );
  assert.ok(
    markdown.indexOf("2. 构造共轭式为何不平凡") <
      markdown.indexOf("3. 双曲函数背景"),
  );
  assert.match(markdown, /> 想到倒数的原因，是倒数恰好等于共轭式。/);
  assert.match(markdown, /因为共轭乘积等于 \(1\)，所以倒数会制造第二个式子。/);
  assert.match(markdown, /\*\*回答 1的逐字原文\*\*/);
  assert.match(markdown, /这是完整逐字补充。/);
  assert.match(markdown, /## 问题停车场/);
  assert.match(markdown, /之后研究佩尔方程与这套结构的关系。/);
  assert.match(markdown, /- 父节点：q2/);
  assert.match(markdown, /- PDF 页：11/);
});

test("formatConversationMarkdown retains messages outside known tree nodes", () => {
  const conv = fixture();
  conv.messages.push({
    role: "assistant",
    content: "这条历史消息指向已不存在的节点，但仍不能丢失。",
    thoughtId: "missing-node",
  });
  const markdown = notebook.formatConversationMarkdown(conv, {});
  assert.match(markdown, /## 未归入思维节点的消息/);
  assert.match(markdown, /这条历史消息指向已不存在的节点，但仍不能丢失。/);
});
