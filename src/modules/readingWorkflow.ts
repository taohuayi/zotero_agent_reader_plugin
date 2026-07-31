// @ts-nocheck
/*
 * Pure state helpers for a per-paper tree of thought.
 *
 * A paper may contain several independent lines of inquiry. A visible line node
 * and a backend thought session are deliberately separate:
 *
 * - lineId / thread.id identifies one visible question-answer checkpoint.
 * - thoughtId identifies the backend session that supplies conversational memory.
 *
 * Consecutive follow-ups create new visible child nodes while retaining their
 * parent's thoughtId. An explicit branch creates both a new node and a new
 * thoughtId, so sibling branches never share backend history.
 */

var MAX_ANSWER_PREVIEW = 320;
var MAX_TITLE = 54;

function nowISO() {
  return new Date().toISOString();
}

function nextID(state) {
  state.sequence = (parseInt(state.sequence, 10) || 0) + 1;
  return "q" + state.sequence;
}

function titleFrom(question) {
  var value = String(question || "新问题")
    .replace(/\s+/g, " ")
    .trim();
  return value.length > MAX_TITLE
    ? value.slice(0, MAX_TITLE - 1).trimEnd() + "…"
    : value;
}

function cleanPreview(text) {
  var value = String(text || "")
    .replace(/\[p\.\d+(?:\s+"[^"]*")?\]/g, "")
    .replace(/[#*_>`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (value.length > MAX_ANSWER_PREVIEW)
    value = value.slice(0, MAX_ANSWER_PREVIEW - 1).trimEnd() + "…";
  return value;
}

function citationAnchor(message) {
  var checks = message && message.citations;
  if (Array.isArray(checks) && checks.length) {
    var first = checks[0] || {};
    var ref = first.reference || first;
    var page =
      first.resolvedPage || ref.resolvedPage || first.page || ref.page || null;
    var quote = ref.quote || first.quote || "";
    if (page) return { page: page, quote: quote };
  }
  var match = String((message && message.content) || "").match(
    /\[p\.(\d+)(?:\s+"([^"]*)")?\]/,
  );
  return match ? { page: parseInt(match[1], 10), quote: match[2] || "" } : null;
}

function makeThread(state, question, opts) {
  var timestamp = nowISO();
  var lineId = nextID(state);
  var thoughtId = (opts && opts.thoughtId) || lineId;
  return {
    id: lineId,
    lineId: lineId,
    thoughtId: thoughtId,
    title: titleFrom(question),
    rootQuestion: String(question || "").trim(),
    lastQuestion: String(question || "").trim(),
    parentId: (opts && opts.parentId) || null,
    // The exact sentence/paragraph in the parent conversation that prompted
    // this question. A parentId records hierarchy; originExcerpt records the
    // intellectual cause of the edge.
    originExcerpt: String((opts && opts.originExcerpt) || "").trim(),
    originRole: (opts && opts.originRole) || null,
    anchor: (opts && opts.anchor) || null,
    summary: "",
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function ensure(conv) {
  if (!conv.reading || typeof conv.reading !== "object") conv.reading = {};
  var state = conv.reading;
  state.mode = "deep";
  if (!state.sequence) state.sequence = 0;
  if (!Array.isArray(state.parkingLot)) state.parkingLot = [];
  if (!Array.isArray(state.threads)) state.threads = [];

  // Migrate the earlier single-card format without losing its anchor/preview.
  if (!state.threads.length && state.current) {
    var legacy = makeThread(state, state.current.question || "既有问题", {
      anchor: state.current.anchor || null,
    });
    legacy.id = state.current.id || legacy.id;
    legacy.summary = state.current.answerPreview || "";
    legacy.createdAt = state.current.createdAt || legacy.createdAt;
    legacy.updatedAt = state.current.updatedAt || legacy.updatedAt;
    state.threads.push(legacy);
    state.activeId = legacy.id;
  }

  // A conversation created before thought trees becomes one root branch.
  if (
    !state.threads.length &&
    Array.isArray(conv.messages) &&
    conv.messages.length
  ) {
    var firstUser = conv.messages.find(function (message) {
      return message && message.role === "user" && message.content;
    });
    var root = makeThread(
      state,
      (firstUser && firstUser.content) || "既有对话",
      null,
    );
    state.threads.push(root);
    state.activeId = root.id;
  }

  // Migrate the original one-id model. Historically message.thoughtId and
  // thread.id both meant "visible node". Preserve those values as the backend
  // thought id, while adding an explicit lineId for all visual filtering.
  state.threads.forEach(function (thread) {
    if (!thread || typeof thread !== "object") return;
    if (!thread.id && thread.lineId) thread.id = thread.lineId;
    if (!thread.lineId) thread.lineId = thread.id;
    if (!thread.thoughtId) thread.thoughtId = thread.id;
  });

  var ids = new Set(
    state.threads.map(function (thread) {
      return thread.id;
    }),
  );
  if (state.activeId && !ids.has(state.activeId)) state.activeId = null;
  if (typeof state.activeId === "undefined" && state.threads.length)
    state.activeId = state.threads[state.threads.length - 1].id;

  // Assign legacy messages to the migrated root so switching branches can
  // immediately filter the transcript.
  if (state.activeId && Array.isArray(conv.messages)) {
    var fallbackId = state.threads[0].id;
    conv.messages.forEach(function (message) {
      if (!message) return;
      if (!message.lineId) message.lineId = message.thoughtId || fallbackId;
      if (!message.thoughtId) {
        var owner = state.threads.find(function (thread) {
          return thread && thread.id === message.lineId;
        });
        message.thoughtId = (owner && owner.thoughtId) || fallbackId;
      }
    });
    if (!conv.thought_session_ids) conv.thought_session_ids = {};
    if (
      !conv.thought_session_ids[fallbackId] &&
      conv.session_ids &&
      Object.keys(conv.session_ids).length
    ) {
      conv.thought_session_ids[fallbackId] = Object.assign(
        {},
        conv.session_ids,
      );
    }
  }

  delete state.current;
  return state;
}

export function setMode(conv) {
  return ensure(conv).mode;
}

export function activeThread(conv) {
  var state = ensure(conv);
  return (
    state.threads.find(function (thread) {
      return thread.id === state.activeId;
    }) || null
  );
}

export function switchThread(conv, id) {
  var state = ensure(conv);
  var previous = activeThread(conv);
  var next = state.threads.find(function (thread) {
    return thread.id === id;
  });
  if (!next) return null;
  if (previous && previous.id !== next.id) previous.status = "paused";
  state.activeId = next.id;
  next.status = "active";
  next.updatedAt = nowISO();
  return next;
}

export function beginQuestion(conv, question, mode, opts) {
  var state = ensure(conv);
  var current = activeThread(conv);
  // Causal provenance and backend isolation are orthogonal. originExcerpt may
  // accompany either mode; only branch/newThought starts an isolated session.
  var startsNewThought = !!(opts && (opts.branch || opts.newThought));
  var followsCurrent = !!(
    current &&
    !startsNewThought &&
    opts &&
    (opts.followup || opts.inheritThought)
  );
  var branchesFromCurrent = !!(current && startsNewThought);
  var inheritedThoughtId = followsCurrent
    ? current.thoughtId || current.id
    : null;
  var thread = makeThread(state, question, {
    anchor: (opts && opts.anchor) || null,
    originExcerpt: (opts && opts.originExcerpt) || "",
    originRole: (opts && opts.originRole) || null,
    thoughtId: (opts && opts.thoughtId) || inheritedThoughtId || null,
    parentId:
      (opts && opts.parentId) ||
      (followsCurrent || branchesFromCurrent ? current.id : null),
  });
  if (current && thread.parentId === current.id) {
    current.status = "paused";
    current.updatedAt = thread.createdAt;
  }
  state.threads.push(thread);
  state.activeId = thread.id;
  return thread;
}

export function pauseActive(conv) {
  var thread = activeThread(conv);
  if (!thread) return null;
  thread.status = "paused";
  thread.updatedAt = nowISO();
  return thread;
}

export function completeCurrent(conv) {
  var state = ensure(conv);
  var old = pauseActive(conv);
  state.activeId = null;
  return old;
}

export function park(conv, question, category, anchor) {
  var text = String(question || "").trim();
  if (!text) return null;
  var state = ensure(conv);
  var current = activeThread(conv);
  var item = {
    id: nextID(state),
    question: text,
    category: category === "branch" ? "branch" : "later",
    parentId: current ? current.id : null,
    anchor: anchor || (current && current.anchor) || null,
    createdAt: nowISO(),
  };
  state.parkingLot.push(item);
  return item;
}

export function takeParked(conv, id) {
  var state = ensure(conv);
  var index = state.parkingLot.findIndex(function (item) {
    return item && item.id === id;
  });
  if (index < 0) return null;
  return state.parkingLot.splice(index, 1)[0];
}

export function removeParked(conv, id) {
  return !!takeParked(conv, id);
}

export function finishAnswer(conv, message) {
  var state = ensure(conv);
  var lineId = message && (message.lineId || message.questionId);
  var thread =
    (lineId &&
      state.threads.find(function (candidate) {
        return candidate && candidate.id === lineId;
      })) ||
    activeThread(conv);
  if (!thread) return null;
  thread.summary = cleanPreview(message && message.content);
  thread.updatedAt = nowISO();
  var anchor = citationAnchor(message);
  if (anchor) thread.anchor = anchor;
  return thread;
}

export function messagesForActive(conv) {
  var current = activeThread(conv);
  if (!current || !Array.isArray(conv.messages)) return [];
  return conv.messages.filter(function (message) {
    return (
      message &&
      (message.lineId || message.thoughtId) === (current.lineId || current.id)
    );
  });
}

export function thoughtIdForLine(conv, id) {
  var state = ensure(conv);
  var thread = state.threads.find(function (candidate) {
    return candidate && candidate.id === (id || state.activeId);
  });
  return thread ? thread.thoughtId || thread.id : null;
}

export function ancestry(conv, id) {
  var state = ensure(conv);
  var byId = Object.create(null);
  state.threads.forEach(function (thread) {
    byId[thread.id] = thread;
  });
  var result = [];
  var seen = new Set();
  var current = byId[id || state.activeId];
  while (current && !seen.has(current.id)) {
    result.unshift(current);
    seen.add(current.id);
    current = current.parentId ? byId[current.parentId] : null;
  }
  return result;
}

// Return threads in parent-first depth-first order. Conversation history is
// chronological, but a thought map is an outline: every child should appear
// immediately below the passage/question that caused it. Orphans and cycles
// are retained once at the end instead of disappearing.
export function orderedThreads(conv) {
  var state = ensure(conv);
  var threads = state.threads || [];
  var byID = new Map(
    threads.map(function (thread) {
      return [thread.id, thread];
    }),
  );
  var children = new Map();
  threads.forEach(function (thread) {
    var parent =
      thread.parentId && byID.has(thread.parentId) ? thread.parentId : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(thread);
  });
  var ordered = [];
  var seen = new Set();
  function visit(thread) {
    if (!thread || seen.has(thread.id)) return;
    seen.add(thread.id);
    ordered.push(thread);
    (children.get(thread.id) || []).forEach(visit);
  }
  (children.get(null) || []).forEach(visit);
  threads.forEach(visit);
  return ordered;
}

// A compact, deterministic tree layout expressed in abstract columns/rows.
// The UI converts these units to pixels and draws curved edges. Unary follow-up
// chains stay on one horizontal route; genuine branches spread vertically.
export function mindMapLayout(conv) {
  var state = ensure(conv);
  var threads = state.threads || [];
  var byID = new Map(
    threads.map(function (thread) {
      return [thread.id, thread];
    }),
  );
  var children = new Map();
  threads.forEach(function (thread) {
    var parent =
      thread.parentId && byID.has(thread.parentId) ? thread.parentId : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(thread);
  });

  var positions = new Map();
  var edges = [];
  var visiting = new Set();
  var finished = new Set();
  var nextRow = 0;
  function place(thread, column) {
    if (!thread || finished.has(thread.id)) return positions.get(thread.id);
    if (visiting.has(thread.id)) {
      var cyclePosition = { thread: thread, column: column, row: nextRow++ };
      positions.set(thread.id, cyclePosition);
      finished.add(thread.id);
      return cyclePosition;
    }
    visiting.add(thread.id);
    var childPositions = [];
    (children.get(thread.id) || []).forEach(function (child) {
      if (visiting.has(child.id)) return;
      edges.push({ from: thread.id, to: child.id });
      var childPosition = place(child, column + 1);
      if (childPosition) childPositions.push(childPosition);
    });
    var row = childPositions.length
      ? childPositions.reduce(function (sum, position) {
          return sum + position.row;
        }, 0) / childPositions.length
      : nextRow++;
    var position = { thread: thread, column: column, row: row };
    positions.set(thread.id, position);
    visiting.delete(thread.id);
    finished.add(thread.id);
    return position;
  }

  (children.get(null) || []).forEach(function (thread) {
    place(thread, 0);
  });
  threads.forEach(function (thread) {
    if (!finished.has(thread.id)) place(thread, 0);
  });
  return {
    nodes: orderedThreads(conv)
      .map(function (thread) {
        return positions.get(thread.id);
      })
      .filter(Boolean),
    edges: edges.filter(function (edge) {
      return positions.has(edge.from) && positions.has(edge.to);
    }),
  };
}

export function branchContext(conv, id) {
  var path = ancestry(conv, id);
  if (!path.length) return "";
  return path
    .map(function (thread, index) {
      var line =
        (index ? "Branch" : "Root") +
        ": " +
        (thread.rootQuestion || thread.title);
      if (thread.originExcerpt)
        line +=
          "\nPrompted by this exact earlier passage: " + thread.originExcerpt;
      if (thread.summary) line += "\nCheckpoint: " + thread.summary;
      return line;
    })
    .join("\n\n");
}

export function responseInstruction(mode, isFollowup) {
  return (
    "READING MODE: CONTINUOUS DEEP DIALOGUE. Explain the authentic discovery " +
    "process, not only the polished final argument. When useful, distinguish " +
    "mechanical first attempts from structural hindsight, respond to objections, " +
    "develop concrete variants, and connect deeper background without forcing a " +
    "short-answer layer. Keep this branch conceptually separate from sibling " +
    "branches in the paper's thought tree." +
    (isFollowup
      ? " Continue from this branch's existing context and unresolved question."
      : " This begins a new branch; use the supplied ancestry only as orientation.")
  );
}

// ── manual editing / restructuring (user-driven; anchored fields untouched) ──

function cleanTitle(value) {
  var v = String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
  if (!v) return "";
  return v.length > MAX_TITLE
    ? v.slice(0, MAX_TITLE - 1).trimEnd() + "…"
    : v;
}

// Edit a node's display title. rootQuestion (the original question) is
// preserved verbatim — it is the immutable record of what was asked.
export function updateThreadTitle(conv, id, title) {
  var state = ensure(conv);
  var t = state.threads.find(function (x) {
    return x && x.id === id;
  });
  if (!t) return false;
  var v = cleanTitle(title);
  if (!v) return false;
  t.title = v;
  t.updatedAt = nowISO();
  return true;
}

// Edit the checkpoint summary shown on the node. The summary is derived
// text; the anchor (page + verbatim quote) is never touched.
export function updateThreadSummary(conv, id, summary) {
  var state = ensure(conv);
  var t = state.threads.find(function (x) {
    return x && x.id === id;
  });
  if (!t) return false;
  t.summary = String(summary == null ? "" : summary).trim();
  t.updatedAt = nowISO();
  return true;
}

// Is `ancestorId` an ancestor-or-self of `maybeId`? Blocks cycles on reparent.
export function isDescendant(conv, ancestorId, maybeId) {
  var state = ensure(conv);
  var byId = Object.create(null);
  state.threads.forEach(function (t) {
    byId[t.id] = t;
  });
  var cur = byId[maybeId];
  var seen = new Set();
  while (cur && !seen.has(cur.id)) {
    if (cur.id === ancestorId) return true;
    seen.add(cur.id);
    cur = cur.parentId ? byId[cur.parentId] : null;
  }
  return false;
}

// Move a node under a new parent (null = root). Refuses cycles and unknown
// parents. Anchors / originExcerpt ride along unchanged.
export function reparentThread(conv, id, newParentId) {
  var state = ensure(conv);
  var t = state.threads.find(function (x) {
    return x && x.id === id;
  });
  if (!t) return false;
  if (newParentId && newParentId !== id) {
    if (isDescendant(conv, id, newParentId)) return false; // cycle
    if (
      !state.threads.some(function (x) {
        return x && x.id === newParentId;
      })
    )
      return false; // unknown parent
  }
  t.parentId = newParentId || null;
  t.updatedAt = nowISO();
  return true;
}

// Delete a node AND its whole descendant subtree. Messages stay in the
// conversation (they resurface under "未归入思维节点" on export); parked
// questions that pointed at the removed nodes are dropped.
export function removeThread(conv, id) {
  var state = ensure(conv);
  if (
    !state.threads.some(function (x) {
      return x && x.id === id;
    })
  )
    return false;
  var toRemove = new Set([id]);
  var stack = [id];
  while (stack.length) {
    var cur = stack.pop();
    state.threads.forEach(function (t) {
      if (t && t.parentId === cur && !toRemove.has(t.id)) {
        toRemove.add(t.id);
        stack.push(t.id);
      }
    });
  }
  state.threads = state.threads.filter(function (t) {
    return !toRemove.has(t.id);
  });
  if (state.activeId && toRemove.has(state.activeId)) {
    state.activeId = state.threads.length ? state.threads[0].id : null;
  }
  if (Array.isArray(state.parkingLot)) {
    state.parkingLot = state.parkingLot.filter(function (p) {
      return !(p && p.parentId && toRemove.has(p.parentId));
    });
  }
  return true;
}

// Manually insert a brand-new question node under `parentId` (null = root).
// Creates a fresh isolated thought (new thoughtId) — it starts its own AI
// session when first asked, exactly like a "从这里分叉" card.
export function insertThread(conv, question, parentId) {
  var state = ensure(conv);
  var text = String(question == null ? "" : question).trim();
  if (!text) return null;
  var thread = makeThread(state, text, {
    parentId: parentId || null,
    newThought: true,
  });
  if (parentId) {
    var parent = state.threads.find(function (x) {
      return x && x.id === parentId;
    });
    if (parent) {
      parent.status = "paused";
      parent.updatedAt = thread.createdAt;
    }
  }
  state.threads.push(thread);
  state.activeId = thread.id;
  return thread;
}
