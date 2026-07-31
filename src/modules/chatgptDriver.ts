// @ts-nocheck
/*
 * chatgptDriver.ts — stateless OpenAI-compatible HTTP backend for ChatGPT quota.
 *
 * Unlike codex (persistent app-server) and claude (per-turn CLI + --resume),
 * this backend has NO server-side memory: every turn is one
 * POST {endpoint}/v1/chat/completions with the FULL thought-chain history
 * supplied by chatService (backend.caps.stateless === true). It is intended
 * for local gateways such as chat2api that turn a ChatGPT Plus login into an
 * OpenAI-compatible API — so paper-reading conversations consume ChatGPT quota
 * instead of Codex quota.
 *
 * AgentEvents emitted: delta | done | error (no tools; no thread_started — the
 * session handle concept does not exist for a stateless HTTP backend).
 *
 * The SSE parsing (consumeSSE / mapSSE) and message building (buildMessages)
 * are pure functions so they are unit-testable under plain Node.
 */

import { chatgptModelInfo } from "./modelInfo";

function clean(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function friendlyError(message) {
  var low = String(message || "").toLowerCase();
  if (low.indexOf("rate limit") >= 0 || low.indexOf("429") >= 0)
    return "ChatGPT is rate limited right now — wait a bit and try again.";
  if (low.indexOf("403") >= 0 || low.indexOf("forbidden") >= 0)
    return "ChatGPT rejected the token (403) — refresh it in chat2api or check chatgptToken.";
  if (low.indexOf("401") >= 0 || low.indexOf("unauthorized") >= 0)
    return "ChatGPT token unauthorized (401) — refresh it or check chatgptToken.";
  if (low.indexOf("connection refused") >= 0 || low.indexOf("failed to fetch") >= 0 || low.indexOf("networkerror") >= 0)
    return "Cannot reach the ChatGPT gateway — is chat2api running at " + "the configured endpoint?";
  return message;
}

export function endpointOf(opts) {
  var e = clean(opts && opts.chatgptEndpoint).replace(/\/+$/, "");
  return e || "http://127.0.0.1:5005/v1";
}

// Map one parsed SSE JSON object (a chat.completion.chunk, a non-streaming
// chat.completion, or an error envelope) to AgentEvents.
export function mapSSE(obj) {
  if (!obj || typeof obj !== "object") return [];
  if (obj.error) {
    var detail = obj.error.message || JSON.stringify(obj.error);
    return [{ kind: "error", message: friendlyError(detail) }];
  }
  var out = [];
  var choices = Array.isArray(obj.choices) ? obj.choices : [];
  for (var i = 0; i < choices.length; i++) {
    var c = choices[i] || {};
    var delta = c.delta || {};
    if (typeof delta.content === "string" && delta.content) {
      out.push({ kind: "delta", text: delta.content });
    }
    var msg = c.message || {};
    if (typeof msg.content === "string" && msg.content) {
      out.push({ kind: "delta", text: msg.content });
    }
    if (c.finish_reason) out.push({ kind: "done" });
  }
  if (!out.length && obj.choices && obj.choices[0]) {
    out.push({ kind: "done" });
  }
  return out;
}

// Streaming helper: append an SSE text chunk to `buffer`, parse every complete
// `data:` line, and return produced events plus the leftover partial buffer.
export function consumeSSE(buffer, chunk) {
  buffer += chunk;
  var events = [];
  var nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    var line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line || line.indexOf("data:") !== 0) continue;
    var payload = line.slice(5).trim();
    if (!payload) continue;
    if (payload === "[DONE]") {
      events.push({ kind: "done" });
      continue;
    }
    var obj;
    try {
      obj = JSON.parse(payload);
    } catch (e) {
      continue;
    }
    var mapped = mapSSE(obj);
    for (var i = 0; i < mapped.length; i++) events.push(mapped[i]);
  }
  return { events: events, buffer: buffer };
}

// Build the API messages array: system (workdir instructions) + thought-chain
// history + the current user prompt.
export function buildMessages(system, history, prompt) {
  var messages = [];
  if (system) messages.push({ role: "system", content: system });
  (history || []).forEach(function (m) {
    if (!m) return;
    if (m.role !== "user" && m.role !== "assistant") return;
    var content = String(m.content || "");
    if (!content) return;
    messages.push({ role: m.role, content: content });
  });
  messages.push({ role: "user", content: String(prompt == null ? "" : prompt) });
  return messages;
}

// Token precedence: chatgptToken preference, then the local chat2api token file
// (~/.codex/chat2api/data/token.txt on this machine's layout).
export async function tokenOf(opts) {
  var t = clean(opts && opts.chatgptToken);
  if (t) return t;
  try {
    var home = typeof PathUtils !== "undefined" && PathUtils.getHomeDir
      ? PathUtils.getHomeDir()
      : "";
    if (home) {
      var p = PathUtils.join(home, ".codex", "chat2api", "data", "token.txt");
      if (await IOUtils.exists(p)) {
        var raw = (await IOUtils.readUTF8(p)).trim();
        if (raw) return raw;
      }
    }
  } catch (e) {}
  return "";
}

async function systemPromptOf(workdir) {
  if (!workdir) return "";
  try {
    var p = PathUtils.join(workdir, "AGENTS.md");
    if (await IOUtils.exists(p)) return await IOUtils.readUTF8(p);
  } catch (e) {}
  return "";
}

function modelOf(opts) {
  return clean(opts && (opts.chatgptModel || opts.model)) || "gpt-5";
}

export async function runTurn(opts, workdir, _sessionId, prompt, onEvent, liveRef, history) {
  opts = opts || {};
  var endpoint = endpointOf(opts);
  var token = await tokenOf(opts);
  if (!token) {
    onEvent({
      kind: "error",
      message:
        "ChatGPT token not found — start chat2api (with a valid token file) or set chatgptToken in Settings.",
    });
    return { exitCode: -1 };
  }
  var system = await systemPromptOf(workdir);
  var messages = buildMessages(system, history, prompt);
  var body = {
    model: modelOf(opts),
    messages: messages,
    stream: true,
  };
  var controller = new AbortController();
  if (liveRef)
    liveRef.kill = function () {
      try {
        controller.abort();
      } catch (e) {}
    };
  var timeoutMs = (opts.timeoutSec || 600) * 1000;
  var timer = setTimeout(function () {
    try {
      controller.abort();
    } catch (e) {}
    finish({ kind: "error", message: "ChatGPT request timed out after " + timeoutMs / 1000 + "s" });
  }, timeoutMs);
  var finished = false;
  var terminalEvent = null;
  function finish(ev) {
    if (finished) return;
    finished = true;
    terminalEvent = ev;
    try {
      clearTimeout(timer);
    } catch (e) {}
    onEvent(ev);
  }
  try {
    var resp = await fetch(endpoint + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      var errText = "";
      try {
        errText = (await resp.text()).slice(0, 400);
      } catch (e) {}
      finish({
        kind: "error",
        message: friendlyError("ChatGPT HTTP " + resp.status + (errText ? ": " + errText : "")),
      });
      return { exitCode: resp.status === 0 ? -1 : resp.status };
    }
    var buffer = "";
    if (resp.body && typeof resp.body.getReader === "function") {
      var reader = resp.body.getReader();
      var decoder = new TextDecoder();
      for (;;) {
        var r = await reader.read();
        if (r.done) break;
        var text = decoder.decode(r.value, { stream: true });
        var res = consumeSSE(buffer, text);
        buffer = res.buffer;
        for (var i = 0; i < res.events.length; i++) {
          var ev = res.events[i];
          if (ev.kind === "done" || ev.kind === "error") finish(ev);
          else onEvent(ev);
          if (finished) break;
        }
        if (finished) break;
      }
      if (!finished && buffer.trim()) {
        // stream ended without a [DONE] marker — flush the tail line
        var obj;
        try {
          obj = JSON.parse(buffer.trim());
        } catch (e) {}
        if (obj) {
          var tail = mapSSE(obj);
          for (var j = 0; j < tail.length; j++) {
            var ev2 = tail[j];
            if (ev2.kind === "done" || ev2.kind === "error") finish(ev2);
            else onEvent(ev2);
          }
        }
      }
      if (!finished) finish({ kind: "done" });
    } else {
      // non-streaming fallback (e.g. a gateway that ignores stream:true)
      var bodyText = await resp.text();
      var parsed = JSON.parse(bodyText);
      var mapped = mapSSE(parsed);
      for (var k = 0; k < mapped.length; k++) {
        var ev3 = mapped[k];
        if (ev3.kind === "done" || ev3.kind === "error") finish(ev3);
        else onEvent(ev3);
      }
      if (!finished) finish({ kind: "done" });
    }
  } catch (e) {
    if (!finished)
      finish({
        kind: "error",
        message: friendlyError("ChatGPT request failed: " + String(e && e.message ? e.message : e)),
      });
  }
  return { exitCode: terminalEvent && terminalEvent.kind === "error" ? -1 : 0 };
}

export async function healthcheck(opts) {
  opts = opts || {};
  try {
    var endpoint = endpointOf(opts);
    var token = await tokenOf(opts);
    if (!token) return { ok: false, error: "ChatGPT token not found" };
    var controller = new AbortController();
    var timer = setTimeout(function () {
      try {
        controller.abort();
      } catch (e) {}
    }, 8000);
    try {
      var resp = await fetch(endpoint + "/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
        body: JSON.stringify({
          model: modelOf(opts),
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        var errText = "";
        try {
          errText = (await resp.text()).slice(0, 200);
        } catch (e) {}
        return {
          ok: false,
          error: friendlyError("HTTP " + resp.status + (errText ? " " + errText : "")),
        };
      }
      var obj = JSON.parse(await resp.text());
      return { ok: true, version: obj && obj.model ? obj.model : "chatgpt" };
    } finally {
      try {
        clearTimeout(timer);
      } catch (e) {}
    }
  } catch (e) {
    return {
      ok: false,
      error: friendlyError(String(e && e.message ? e.message : e)),
    };
  }
}

export async function getModelInfo(opts, _forceRefresh) {
  return chatgptModelInfo(opts || {});
}

export function shutdown() {}
