// @ts-nocheck
/*
 * eventMapper.ts — pure mapping of codex `--json` JSONL events to the
 * backend-neutral AgentEvent vocabulary. NO Zotero/Gecko APIs, so it is
 * unit-testable under plain Node AND bundled into the plugin.
 *
 * Ported 1:1 from the standalone app's app/agent/codex_driver.py::_map_event,
 * verified against codex-cli 0.130 (see test/fixtures/codex-0.130.jsonl).
 *
 * AgentEvent = { kind, sessionId?, text?, toolName?, detail?, message?, usage?, raw? }
 *   kind ∈ "thread_started" | "delta" | "tool" | "done" | "error"
 */

var AGENT_MESSAGE_TYPES = {
  agent_message: 1,
  assistant_message: 1,
  message: 1,
};
var TOOL_TYPES = {
  command_execution: 1,
  web_search: 1,
  file_search: 1,
  mcp_tool_call: 1,
};
var RATE_LIMIT_MARKERS = [
  "rate limit exceeded",
  "rate_limit_exceeded",
  "quota exceeded",
  "too many requests",
];

export function extractText(item) {
  var txt = item.text || item.message || item.content;
  if (Array.isArray(txt)) {
    txt = txt
      .map(function (b) {
        return b && b.text ? b.text : "";
      })
      .join(" ");
  }
  return (txt || "").trim();
}

function friendlyError(message) {
  var low = (message || "").toLowerCase();
  for (var i = 0; i < RATE_LIMIT_MARKERS.length; i++) {
    if (low.indexOf(RATE_LIMIT_MARKERS[i]) >= 0) {
      return "Codex is rate limited right now — wait a bit and try again.";
    }
  }
  return message;
}

// Map one parsed JSONL event object to zero or more AgentEvents.
export function mapEvent(ev) {
  var top = ev && ev.type;

  if (top === "thread.started") {
    return [
      {
        kind: "thread_started",
        sessionId: ev.thread_id || ev.session_id || ev.id,
        raw: ev,
      },
    ];
  }

  if (top === "item.completed") {
    var item = ev.item || {};
    var itype = item.type || item.item_type;
    if (AGENT_MESSAGE_TYPES[itype]) {
      var text = extractText(item);
      return text ? [{ kind: "delta", text: text, raw: ev }] : [];
    }
    if (TOOL_TYPES[itype]) {
      var detail = item.command || item.query || item.name || "";
      if (Array.isArray(detail)) detail = detail.join(" ");
      return [
        { kind: "tool", toolName: itype, detail: String(detail), raw: ev },
      ];
    }
    return [];
  }

  if (top === "turn.completed") {
    return [{ kind: "done", usage: ev.usage, raw: ev }];
  }

  if (top === "turn.failed" || top === "error") {
    return [
      {
        kind: "error",
        message: friendlyError(JSON.stringify(ev).slice(0, 600)),
        raw: ev,
      },
    ];
  }

  return []; // turn.started, item.started, etc. — ignored
}

// Streaming helper: append a stdout chunk (arbitrary size, NOT line-aligned)
// to `buffer`, parse every complete line, and return the produced events plus
// the leftover partial-line buffer. Mirrors the Python readline loop.
export function consume(buffer, chunk) {
  buffer += chunk;
  var events = [];
  var nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    var line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    var ev;
    try {
      ev = JSON.parse(line);
    } catch (e) {
      continue;
    }
    var mapped = mapEvent(ev);
    for (var i = 0; i < mapped.length; i++) events.push(mapped[i]);
  }
  return { events: events, buffer: buffer };
}
