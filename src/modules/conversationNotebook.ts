// @ts-nocheck
/*
 * Pure conversation-notebook helpers.
 *
 * This module deliberately knows nothing about Zotero chrome, DOM nodes, or
 * filesystem APIs. It provides the data transformations shared by the panel:
 * selecting transcript scope, searching every preserved text layer, and
 * exporting a complete tree-ordered Markdown notebook.
 */

import * as PRAReading from "./readingWorkflow";

var EXCERPT_CONTEXT_BEFORE = 54;
var EXCERPT_CONTEXT_AFTER = 108;

function asText(value) {
  return value == null ? "" : String(value);
}

function normalized(value) {
  return asText(value).toLocaleLowerCase();
}

function compactLine(value) {
  return asText(value).replace(/\s+/g, " ").trim();
}

function excerptAround(value, query) {
  var source = asText(value);
  var folded = normalized(source);
  var needle = normalized(query);
  var index = needle ? folded.indexOf(needle) : -1;
  if (index < 0) return compactLine(source).slice(0, 180);

  var start = Math.max(0, index - EXCERPT_CONTEXT_BEFORE);
  var end = Math.min(
    source.length,
    index + needle.length + EXCERPT_CONTEXT_AFTER,
  );
  var excerpt = compactLine(source.slice(start, end));
  if (start > 0) excerpt = "…" + excerpt;
  if (end < source.length) excerpt += "…";
  return excerpt;
}

function threadMap(conv) {
  var state = PRAReading.ensure(conv);
  var result = Object.create(null);
  state.threads.forEach(function (thread) {
    if (thread && thread.id) result[thread.id] = thread;
  });
  return result;
}

function pathIDs(conv) {
  var state = PRAReading.ensure(conv);
  var result = Object.create(null);
  PRAReading.ancestry(conv, state.activeId).forEach(function (thread) {
    result[thread.id] = true;
  });
  return result;
}

function messageLineId(message) {
  return message && (message.lineId || message.thoughtId);
}

// Return messages in their original chronological order.
//
// mode === "node": only the active thought node
// mode === "path": every node on the active node's root-to-leaf ancestry
// mode === "all":  the complete conversation, including every sibling branch
export function messagesForView(conv, mode) {
  if (!conv || !Array.isArray(conv.messages)) return [];
  var state = PRAReading.ensure(conv);
  if (mode === "all") return conv.messages.slice();

  if (mode === "path") {
    var ids = pathIDs(conv);
    return conv.messages.filter(function (message) {
      return !!(message && ids[messageLineId(message)]);
    });
  }

  if (!state.activeId) return [];
  return conv.messages.filter(function (message) {
    return !!(message && messageLineId(message) === state.activeId);
  });
}

function addSearchHit(results, value, query, details) {
  if (!value || normalized(value).indexOf(normalized(query)) < 0) return;
  results.push({
    lineId: details.lineId || details.thoughtId || null,
    thoughtId: details.thoughtId || null,
    messageIndex:
      typeof details.messageIndex === "number" ? details.messageIndex : -1,
    role: details.role || "unknown",
    excerpt: excerptAround(value, query),
    field: details.field,
  });
}

// Search canonical Markdown, preserved verbatim text, and thought-tree metadata.
// A verbatim layer identical to content is skipped to avoid duplicate results.
export function searchConversation(conv, query) {
  var needle = compactLine(query);
  if (!conv || !needle) return [];

  var results = [];
  var threads = PRAReading.orderedThreads(conv);
  threads.forEach(function (thread) {
    addSearchHit(results, thread.title || thread.rootQuestion, needle, {
      lineId: thread.id,
      thoughtId: thread.thoughtId || thread.id,
      messageIndex: -1,
      role: "thread",
      field: "thread.title",
    });
    addSearchHit(results, thread.originExcerpt, needle, {
      lineId: thread.id,
      thoughtId: thread.thoughtId || thread.id,
      messageIndex: -1,
      role: thread.originRole || "thread",
      field: "thread.originExcerpt",
    });
  });

  var messages = Array.isArray(conv.messages) ? conv.messages : [];
  messages.forEach(function (message, index) {
    if (!message) return;
    var content = asText(message.content);
    var verbatim = asText(message.verbatimContent);
    addSearchHit(results, content, needle, {
      lineId: messageLineId(message),
      thoughtId: message.thoughtId || null,
      messageIndex: index,
      role: message.role || "unknown",
      field: "content",
    });
    if (verbatim && verbatim !== content) {
      addSearchHit(results, verbatim, needle, {
        lineId: messageLineId(message),
        thoughtId: message.thoughtId || null,
        messageIndex: index,
        role: message.role || "unknown",
        field: "verbatimContent",
      });
    }
  });

  return results;
}

function markdownQuote(value) {
  return asText(value)
    .split(/\r?\n/)
    .map(function (line) {
      return "> " + line;
    })
    .join("\n");
}

function heading(level, title) {
  var safeLevel = Math.max(1, Math.min(6, level));
  return new Array(safeLevel + 1).join("#") + " " + title;
}

function treeDepth(conv, thread) {
  return Math.max(0, PRAReading.ancestry(conv, thread.id).length - 1);
}

function outlineLine(conv, thread) {
  var depth = treeDepth(conv, thread);
  var indent = new Array(depth + 1).join("  ");
  return (
    indent +
    "- [" +
    asText(thread.id || "?") +
    "] " +
    asText(thread.title || thread.rootQuestion || "未命名节点")
  );
}

function messageLabel(message, counters) {
  if (message && message.role === "user") {
    counters.user += 1;
    return "问题 " + counters.user;
  }
  if (message && message.role === "assistant") {
    counters.assistant += 1;
    return "回答 " + counters.assistant;
  }
  counters.other += 1;
  return (
    "消息 " + counters.other + "（" + asText(message && message.role) + "）"
  );
}

function appendMessage(parts, message, counters) {
  var label = messageLabel(message, counters);
  parts.push("**" + label + "**");
  parts.push("");
  parts.push(asText(message && message.content));
  parts.push("");

  var content = asText(message && message.content);
  var verbatim = asText(message && message.verbatimContent);
  if (verbatim && verbatim !== content) {
    parts.push("**" + label + "的逐字原文**");
    parts.push("");
    parts.push(verbatim);
    parts.push("");
  }
}

function messagesForThread(conv, threadID) {
  if (!conv || !Array.isArray(conv.messages)) return [];
  return conv.messages.filter(function (message) {
    return !!(message && messageLineId(message) === threadID);
  });
}

function appendThread(parts, conv, thread, ordinal) {
  var depth = treeDepth(conv, thread);
  var title = asText(thread.title || thread.rootQuestion || "未命名思维节点");
  parts.push(heading(Math.min(6, depth + 2), ordinal + ". " + title));
  parts.push("");
  parts.push("- 节点：" + asText(thread.id || "?"));
  if (thread.thoughtId && thread.thoughtId !== thread.id) {
    parts.push("- 连续会话：" + asText(thread.thoughtId));
  }
  if (thread.status) parts.push("- 状态：" + asText(thread.status));
  if (thread.anchor && thread.anchor.page) {
    parts.push("- PDF 页：" + asText(thread.anchor.page));
  }
  parts.push("");

  if (thread.originExcerpt) {
    parts.push(
      "**由上一段文字引出" +
        (thread.originRole ? "（" + asText(thread.originRole) + "）" : "") +
        "**",
    );
    parts.push("");
    parts.push(markdownQuote(thread.originExcerpt));
    parts.push("");
  }

  var counters = { user: 0, assistant: 0, other: 0 };
  var messages = messagesForThread(conv, thread.id);
  if (!messages.length && thread.rootQuestion) {
    parts.push("**节点问题**");
    parts.push("");
    parts.push(asText(thread.rootQuestion));
    parts.push("");
  } else {
    messages.forEach(function (message) {
      appendMessage(parts, message, counters);
    });
  }
}

function appendUnassignedMessages(parts, conv, assigned) {
  var messages = Array.isArray(conv.messages) ? conv.messages : [];
  var unassigned = messages.filter(function (message, index) {
    return !assigned[index];
  });
  if (!unassigned.length) return;

  parts.push("## 未归入思维节点的消息");
  parts.push("");
  var counters = { user: 0, assistant: 0, other: 0 };
  unassigned.forEach(function (message) {
    appendMessage(parts, message, counters);
  });
}

function appendParkingLot(parts, conv) {
  var state = PRAReading.ensure(conv);
  var parked = state.parkingLot || [];
  parts.push("## 问题停车场");
  parts.push("");
  if (!parked.length) {
    parts.push("暂无。");
    parts.push("");
    return;
  }

  parked.forEach(function (item, index) {
    var kind = item.category === "branch" ? "旁支" : "稍后";
    parts.push("### " + (index + 1) + ". " + kind);
    parts.push("");
    if (item.parentId) parts.push("- 父节点：" + asText(item.parentId));
    if (item.anchor && item.anchor.page)
      parts.push("- PDF 页：" + asText(item.anchor.page));
    if (item.parentId || (item.anchor && item.anchor.page)) parts.push("");
    parts.push(asText(item.question));
    parts.push("");
  });
}

// Export canonical Markdown rather than rendered DOM/KaTeX HTML. Every
// message.content is emitted in full. When the imported verbatim layer differs
// from the canonical Markdown, it is emitted immediately after that message.
export function formatConversationMarkdown(conv, metadata) {
  conv = conv || {};
  metadata = metadata || {};
  var imported = conv.import_metadata || {};
  var title =
    metadata.title ||
    imported.source_title ||
    metadata.paperTitle ||
    "对话笔记";
  var source = metadata.source || imported.source || "";
  var paperTitle = metadata.paperTitle || "";
  var exportedAt = metadata.exportedAt || "";
  var parts = [];

  parts.push("# " + asText(title));
  parts.push("");
  if (paperTitle && paperTitle !== title)
    parts.push("- 论文：" + asText(paperTitle));
  if (source) parts.push("- 来源：" + asText(source));
  if (exportedAt) parts.push("- 导出时间：" + asText(exportedAt));
  if (paperTitle || source || exportedAt) parts.push("");

  var threads = PRAReading.orderedThreads(conv);
  parts.push("## 思维链总览");
  parts.push("");
  if (!threads.length) {
    parts.push("暂无思维节点。");
  } else {
    threads.forEach(function (thread) {
      parts.push(outlineLine(conv, thread));
    });
  }
  parts.push("");

  var assigned = Object.create(null);
  threads.forEach(function (thread, index) {
    appendThread(parts, conv, thread, index + 1);
    if (Array.isArray(conv.messages)) {
      conv.messages.forEach(function (message, messageIndex) {
        if (message && messageLineId(message) === thread.id)
          assigned[messageIndex] = true;
      });
    }
  });
  appendUnassignedMessages(parts, conv, assigned);
  appendParkingLot(parts, conv);

  // Repeated blank lines can be meaningful inside a preserved message or
  // verbatim import, so do not normalize the assembled document globally.
  return parts.join("\n");
}
