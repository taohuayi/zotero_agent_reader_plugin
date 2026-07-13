// @ts-nocheck
/*
 * appServer.ts — drive codex via a PERSISTENT `codex app-server` (stdio JSON-RPC)
 * to get TRUE token-level streaming (the `item/agentMessage/delta` notifications),
 * instead of the whole-message-at-once `codex exec --json`.
 *
 * Protocol (verified live against codex-cli 0.130.0, app-server generate-json-schema):
 *   line-delimited JSON-RPC 2.0 over stdin/stdout.
 *   handshake:  → initialize {clientInfo}        ← {userAgent,...}
 *               → initialized (notification)
 *   per paper:  → thread/start {cwd,approvalPolicy,sandbox}  ← {thread:{id}}   (or thread/resume {threadId})
 *   per turn:   → turn/start {threadId,input:[{type:"text",text}]}  ← {turn:{id}}
 *               ← item/agentMessage/delta {delta,itemId,threadId,turnId}   ← TOKEN STREAM
 *               ← item/completed {item:{type:"agentMessage",text}}         (full text, for reconcile)
 *               ← turn/completed {threadId,turn}                           (done)
 *   cancel:     → turn/interrupt {threadId,turnId}
 *
 * Exposes runTurn(opts, workdir, threadId, prompt, onEvent, liveRef) — same contract
 * as the codex exec driver, emitting: thread_started | delta (token, CONCATENATED by
 * chatService) | tool | done | error. EXPERIMENTAL codex protocol — pinned to 0.130.x.
 */

import { resolveCodex } from "./codexEnv";
import { normalizeCodexModelInfo } from "./modelInfo";

var ENC = null;
function encode(s) {
  if (!ENC) ENC = new TextEncoder();
  return ENC.encode(s);
}

// ---- persistent process + JSON-RPC state ----
// S.turns maps threadId -> active turn, so MULTIPLE papers can stream CONCURRENTLY:
// every per-turn notification carries threadId/turnId and routes to the right turn.
var S = {
  proc: null,
  ready: null,
  nextId: 1,
  pending: Object.create(null),
  activeThreads: null,
  turns: Object.create(null),
  modelCatalogPromise: null,
};

function getSubprocess() {
  return ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs")
    .Subprocess;
}

function log(m) {
  try {
    Zotero.debug("[PaperReadingAgent] appServer: " + m);
  } catch (e) {}
}

function send(obj) {
  if (!S.proc) return Promise.reject(new Error("app-server not running"));
  try {
    return S.proc.stdin.write(encode(JSON.stringify(obj) + "\n"));
  } catch (e) {
    return Promise.reject(e);
  }
}

function request(method, params) {
  var id = S.nextId++;
  var p = new Promise(function (resolve, reject) {
    S.pending[id] = { resolve: resolve, reject: reject };
  });
  send({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
  return p;
}
function notify(method, params) {
  return send({ jsonrpc: "2.0", method: method, params: params || {} });
}

function dispatch(msg) {
  if (msg.id != null && ("result" in msg || "error" in msg)) {
    var pend = S.pending[msg.id];
    if (pend) {
      delete S.pending[msg.id];
      msg.error
        ? pend.reject(new Error(JSON.stringify(msg.error)))
        : pend.resolve(msg.result);
    }
    return;
  }
  if (msg.id != null && msg.method) {
    // server request (approval/elicitation)
    // approvalPolicy:never + read-only means these shouldn't fire; decline to avoid a hang.
    log("server request " + msg.method + " → declining");
    send({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: "client declines " + msg.method },
    });
    return;
  }
  if (msg.method) routeNotification(msg.method, msg.params || {});
}

// Map an app-server notification onto the RIGHT turn's AgentEvent stream (by threadId).
function routeNotification(method, p) {
  // Settings/runtime notifications are useful even though they are not answer
  // content. Persist the latest server-reported thread model and forward it to
  // the active response so the UI badge never has to infer the actual model.
  if (method === "thread/settings/updated") {
    var settings = p.threadSettings || {};
    var existing = p.threadId && S.activeThreads && S.activeThreads[p.threadId];
    if (p.threadId && S.activeThreads) {
      S.activeThreads[p.threadId] = Object.assign(existing || {}, {
        model: settings.model || (existing && existing.model) || "",
        modelProvider:
          settings.modelProvider || (existing && existing.modelProvider) || "",
        reasoningEffort:
          settings.effort || (existing && existing.reasoningEffort) || "",
      });
    }
    var settingsTurn = p.threadId && S.turns[p.threadId];
    if (settingsTurn && settings.model) {
      settingsTurn.reportedModel = settings.model;
      settingsTurn.reportedProvider = settings.modelProvider || "";
      settingsTurn.reportedEffort = settings.effort || "";
      settingsTurn.onEvent({
        kind: "runtime_info",
        backend: "codex",
        model: settings.model,
        modelProvider: settings.modelProvider || "",
        reasoningEffort: settings.effort || "",
        source: "thread-settings",
      });
    }
    return;
  }
  if (method === "model/rerouted") {
    var rerouted = p.threadId && S.activeThreads && S.activeThreads[p.threadId];
    if (rerouted) rerouted.model = p.toModel || rerouted.model;
    var reroutedTurn = p.threadId && S.turns[p.threadId];
    if (reroutedTurn && p.toModel) {
      reroutedTurn.reportedModel = p.toModel;
      reroutedTurn.onEvent({
        kind: "runtime_info",
        backend: "codex",
        model: p.toModel,
        modelProvider: (rerouted && rerouted.modelProvider) || "",
        reasoningEffort: (rerouted && rerouted.reasoningEffort) || "",
        source: "model-rerouted",
        requestedModel: p.fromModel || "",
        reason: p.reason || "",
      });
    }
    return;
  }

  var t = null;
  if (p.threadId)
    t = S.turns[p.threadId]; // route by thread → concurrency-safe
  else {
    var ks = Object.keys(S.turns);
    if (ks.length === 1) t = S.turns[ks[0]];
  } // threadId-less notif: only if a single turn is active
  if (!t) return;

  if (method === "item/agentMessage/delta") {
    if (typeof p.delta === "string" && p.delta.length) {
      t.gotText = true;
      t.onEvent({ kind: "delta", text: p.delta });
    }
    return;
  }
  if (method === "item/started") {
    var it = p.item || {},
      ty = it.type;
    if (ty === "agentMessage") {
      if (t.gotText) t.onEvent({ kind: "delta", text: "\n\n" });
    } // paragraph break between messages
    else if (ty === "reasoning") {
      t.onEvent({ kind: "tool", toolName: "reasoning", detail: "" });
    } // surface the (often long, silent) reasoning phase so the UI isn't frozen
    else if (
      ty === "commandExecution" ||
      ty === "webSearch" ||
      ty === "mcpToolCall" ||
      ty === "fileChange"
    ) {
      var d = it.command || it.query || it.name || it.server || "";
      if (Array.isArray(d)) d = d.join(" ");
      t.onEvent({ kind: "tool", toolName: ty, detail: String(d) });
    }
    return;
  }
  if (
    method === "item/reasoning/textDelta" ||
    method === "item/reasoning/summaryTextDelta"
  ) {
    t.onEvent({ kind: "tool", toolName: "reasoning", detail: "" }); // surface "thinking…"
    return;
  }
  if (method === "turn/completed") {
    finishTurn(t, { kind: "done" });
    return;
  }
  if (method === "turn/failed" || method === "error") {
    finishTurn(t, {
      kind: "error",
      message: (p && (p.message || JSON.stringify(p))) || "turn failed",
    });
    return;
  }
}

function finishTurn(t, ev) {
  if (t.finished) return;
  t.finished = true;
  if (t.timer) {
    try {
      clearTimeout(t.timer);
    } catch (e) {}
  }
  if (t.threadId && S.turns[t.threadId] === t) delete S.turns[t.threadId];
  t.onEvent(ev);
  t.resolve();
}

async function readLoop(proc) {
  var buffer = "";
  try {
    var chunk;
    while ((chunk = await proc.stdout.readString())) {
      buffer += chunk;
      var nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        var line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        var msg;
        try {
          msg = JSON.parse(line);
        } catch (e) {
          continue;
        }
        try {
          dispatch(msg);
        } catch (e) {
          log("dispatch error: " + e);
        }
      }
    }
  } catch (e) {
    log("read loop ended: " + e);
  }
  onProcExit();
}

function onProcExit() {
  var keys = Object.keys(S.pending);
  for (var i = 0; i < keys.length; i++) {
    try {
      S.pending[keys[i]].reject(new Error("app-server exited"));
    } catch (e) {}
  }
  S.pending = Object.create(null);
  var tks = Object.keys(S.turns);
  for (var j = 0; j < tks.length; j++) {
    try {
      finishTurn(S.turns[tks[j]], {
        kind: "error",
        message: "codex app-server exited",
      });
    } catch (e) {}
  }
  S.turns = Object.create(null);
  S.proc = null;
  S.ready = null;
  S.activeThreads = null;
  S.modelCatalogPromise = null;
}

// Idempotent + race-safe: sets S.ready (the in-flight promise) synchronously, so two
// concurrent runTurns (two papers asked at once) share ONE app-server, not two.
function ensureReady(opts) {
  if (S.ready) return S.ready;
  S.ready = startServer(opts).catch(function (e) {
    S.ready = null;
    S.proc = null;
    throw e;
  });
  return S.ready;
}
async function startServer(opts) {
  var Subprocess = getSubprocess();
  var command, env;
  try {
    var r = await resolveCodex(opts);
    command = r.command;
    env = r.env;
  } catch (e) {
    throw new Error(String(e && e.message ? e.message : e));
  }

  var argv = ["app-server"];
  if (opts.webSearch !== false) argv.push("-c", "tools.web_search=true");

  var proc = await Subprocess.call({
    command: command,
    arguments: argv,
    environment: env,
    environmentAppend: true,
    stderr: "pipe",
  });
  S.proc = proc;
  S.activeThreads = Object.create(null);
  readLoop(proc); // fire-and-forget; runs for the life of the process
  await request("initialize", {
    clientInfo: { name: "paper-reading-agent", version: "0.1.0" },
  });
  await notify("initialized");
  log("ready");
}

function emitRuntimeInfo(onEvent, response, source) {
  if (!onEvent || !response || !response.model) return;
  onEvent({
    kind: "runtime_info",
    backend: "codex",
    model: response.model,
    modelProvider: response.modelProvider || "",
    reasoningEffort: response.reasoningEffort || response.effort || "",
    source: source,
  });
}

function rememberThread(id, response, requestedModel) {
  if (!S.activeThreads) S.activeThreads = Object.create(null);
  S.activeThreads[id] = {
    model: (response && response.model) || "",
    modelProvider: (response && response.modelProvider) || "",
    reasoningEffort:
      (response && (response.reasoningEffort || response.effort)) || "",
    requestedModel: requestedModel || "",
  };
}

// Ensure a thread exists in THIS server (start a new one or resume a persisted id).
async function ensureThread(workdir, threadId, opts, desiredModel, onEvent) {
  var common = {
    cwd: workdir,
    approvalPolicy: "never",
    sandbox: opts.sandbox || "read-only",
  };
  if (desiredModel) common.model = desiredModel;
  if (threadId && S.activeThreads[threadId]) {
    var active = S.activeThreads[threadId];
    if (active.model && active.requestedModel === (opts.model || ""))
      emitRuntimeInfo(onEvent, active, "active-thread");
    return threadId;
  }
  if (threadId) {
    try {
      var r = await request(
        "thread/resume",
        Object.assign({ threadId: threadId }, common),
      );
      var id = (r && r.thread && r.thread.id) || threadId;
      rememberThread(id, r, opts.model || "");
      emitRuntimeInfo(onEvent, r, "thread-resume");
      return id;
    } catch (e) {
      log("resume failed (" + e + "), starting fresh");
    }
  }
  var rs = await request("thread/start", common);
  var nid = rs && rs.thread && rs.thread.id;
  if (!nid) throw new Error("thread/start returned no thread id");
  rememberThread(nid, rs, opts.model || "");
  if (onEvent) onEvent({ kind: "thread_started", sessionId: nid });
  emitRuntimeInfo(onEvent, rs, "thread-start");
  return nid;
}

async function loadModelCatalog() {
  if (S.modelCatalogPromise) return S.modelCatalogPromise;
  S.modelCatalogPromise = (async function () {
    var data = [];
    var cursor = null;
    var pages = 0;
    do {
      var response = await request("model/list", {
        cursor: cursor,
        limit: 100,
        includeHidden: false,
      });
      if (response && Array.isArray(response.data))
        data = data.concat(response.data);
      cursor = response && response.nextCursor;
      pages++;
    } while (cursor && pages < 20);
    return { data: data, nextCursor: cursor || null };
  })().catch(function (e) {
    // model/list is newer than the original app-server integration. An older
    // Codex still works: Settings remains an editable text field.
    log("model/list unavailable: " + e);
    return { data: [] };
  });
  return S.modelCatalogPromise;
}

export async function getModelInfo(opts, forceRefresh) {
  opts = opts || {};
  await ensureReady(opts);
  if (forceRefresh) S.modelCatalogPromise = null;
  var results = await Promise.all([
    loadModelCatalog(),
    request("config/read", { includeLayers: false }).catch(function (e) {
      log("config/read unavailable: " + e);
      return null;
    }),
  ]);
  return normalizeCodexModelInfo(opts, results[0], results[1]);
}

async function desiredModelForTurn(opts) {
  if (opts.model) return opts.model;
  try {
    var info = await getModelInfo(opts);
    return info && info.effective ? info.effective : null;
  } catch (e) {
    log("could not resolve default model: " + e);
    return null;
  }
}

// Pure construction is exported for protocol regression tests.
export function buildTurnParams(threadId, input, opts, desiredModel) {
  opts = opts || {};
  var params = {
    threadId: threadId,
    input: input,
    model: desiredModel || opts.model || null,
  };
  var effort = opts.reasoningEffort;
  // Codex rejects minimal together with web search/image generation tools.
  if (effort === "minimal" && opts.webSearch !== false) effort = "low";
  if (effort) params.effort = effort;
  return params;
}

// Same contract as the codex exec driver's runTurn.
export async function runTurn(
  opts,
  workdir,
  threadId,
  prompt,
  onEvent,
  liveRef,
) {
  opts = opts || {};
  try {
    await ensureReady(opts);
  } catch (e) {
    onEvent({ kind: "error", message: String(e && e.message ? e.message : e) });
    return { exitCode: -1 };
  }

  var desiredModel = await desiredModelForTurn(opts);
  var tid;
  try {
    tid = await ensureThread(workdir, threadId, opts, desiredModel, onEvent);
  } catch (e) {
    onEvent({ kind: "error", message: "failed to open codex thread: " + e });
    return { exitCode: -1 };
  }

  var done;
  var donePromise = new Promise(function (res) {
    done = res;
  });
  var turn = {
    threadId: tid,
    turnId: null,
    onEvent: onEvent,
    resolve: done,
    finished: false,
    gotText: false,
    timer: null,
    reportedModel: "",
    reportedProvider: "",
    reportedEffort: "",
  };
  S.turns[tid] = turn;

  if (liveRef)
    liveRef.kill = function () {
      if (turn.turnId) {
        try {
          request("turn/interrupt", { threadId: tid, turnId: turn.turnId });
        } catch (e) {}
      }
      finishTurn(turn, { kind: "error", message: "cancelled" });
    };
  var timeoutMs = (opts.timeoutSec || 600) * 1000;
  turn.timer = setTimeout(function () {
    if (turn.turnId) {
      try {
        request("turn/interrupt", { threadId: tid, turnId: turn.turnId });
      } catch (e) {}
    }
    finishTurn(turn, {
      kind: "error",
      message: "codex turn timed out after " + timeoutMs / 1000 + "s",
    });
  }, timeoutMs);

  try {
    // input is UserInput[]: a text item plus one localImage item per attached image
    // (codex app-server v2 UserInput union: {type:"text",text} | {type:"localImage",path}).
    var input = [{ type: "text", text: prompt }];
    if (opts.images && opts.images.length) {
      for (var im = 0; im < opts.images.length; im++) {
        if (opts.images[im])
          input.push({ type: "localImage", path: opts.images[im] });
      }
    }
    var turnParams = buildTurnParams(tid, input, opts, desiredModel);
    if (opts.reasoningEffort === "minimal" && opts.webSearch !== false) {
      log(
        "effort 'minimal' is incompatible with web_search; using 'low' for this turn",
      );
    }
    var tr = await request("turn/start", turnParams);
    turn.turnId = (tr && tr.turn && tr.turn.id) || null;
    // A successful turn/start means the server accepted the per-turn model.
    // A later thread/settings/updated or model/rerouted notification supersedes it.
    if (desiredModel) {
      var meta = S.activeThreads && S.activeThreads[tid];
      var sameSelection =
        meta && meta.requestedModel === (opts.model || "") && meta.model;
      var reportedModel =
        turn.reportedModel || (sameSelection ? meta.model : desiredModel);
      if (meta) {
        meta.model = reportedModel;
        meta.reasoningEffort = turnParams.effort || meta.reasoningEffort || "";
        meta.requestedModel = opts.model || "";
      }
      emitRuntimeInfo(
        onEvent,
        {
          model: reportedModel,
          modelProvider:
            turn.reportedProvider || (meta && meta.modelProvider) || "",
          reasoningEffort:
            turn.reportedEffort ||
            turnParams.effort ||
            (meta && meta.reasoningEffort) ||
            "",
        },
        opts.model ? "turn-selection" : "turn-default",
      );
    }
  } catch (e) {
    finishTurn(turn, { kind: "error", message: "turn/start failed: " + e });
    return { exitCode: -1 };
  }
  await donePromise;
  return { exitCode: 0 };
}

export function shutdown() {
  try {
    if (S.proc) S.proc.kill();
  } catch (e) {}
  S.proc = null;
  S.ready = null;
  S.turns = Object.create(null);
  S.activeThreads = null;
  S.pending = Object.create(null);
  S.modelCatalogPromise = null;
}
