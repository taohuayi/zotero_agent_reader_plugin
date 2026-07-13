// @ts-nocheck
/*
 * claudeDriver.ts — Claude (Claude Code CLI) backend. Spawns `claude -p` ONCE per
 * turn via Mozilla's Subprocess (privileged chrome / Zotero only) and streams its
 * stream-json output onto the backend-neutral AgentEvent vocabulary.
 *
 * This is the codex-EXEC analog (one process per turn + --resume), NOT the
 * persistent codex app-server: no JSON-RPC, no thread multiplex, no turn/interrupt
 * — cancel is just proc.kill(). `buildArgv` is pure (no Gecko APIs), unit-testable.
 *
 * Protocol (verified live against claude 2.1.183):
 *   claude -p "<prompt>" --output-format stream-json --include-partial-messages --verbose
 *   line-delimited JSON, one object per line:
 *     {"type":"system","subtype":"init","session_id":…}             → thread_started
 *     {"type":"stream_event","event":{"type":"content_block_delta",
 *        "delta":{"type":"text_delta","text":…}}}                    → delta  (TOKENS)
 *     {"type":"stream_event","event":{"type":"content_block_start",
 *        "content_block":{"type":"tool_use","name":…}}}              → tool
 *     {"type":"result","is_error":false,…}                           → done
 *     {"type":"result","is_error":true,"errors":[…]}                 → error
 *
 *   GOTCHAS handled (each cost a real bug if missed — see the design review):
 *   1. The SAME assistant text also arrives as a full {"type":"assistant"} message
 *      AND as result.result. We emit deltas ONLY (ignore both) so text isn't 3x'd.
 *   2. thinking_delta / input_json_delta share the content_block_delta envelope —
 *      we match delta.type === "text_delta" EXACTLY (else reasoning leaks as answer).
 *   3. On error the line keeps subtype:"success"; only is_error is reliable. A
 *      non-JSON line can precede the result (e.g. a bad --resume) — we skip non-JSON.
 */
import { resolveClaude } from "./codexEnv";
import { claudeModelInfo } from "./modelInfo";

function getSubprocess() {
  return ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs")
    .Subprocess;
}
function log(m) {
  try {
    Zotero.debug("[PaperReadingAgent] claudeDriver: " + m);
  } catch (e) {}
}

// Directory of an absolute path (pure string op so buildArgv stays Node-testable —
// no PathUtils). Handles both / and \ separators.
function parentDir(p) {
  var i = Math.max(String(p).lastIndexOf("/"), String(p).lastIndexOf("\\"));
  return i > 0 ? String(p).slice(0, i) : String(p);
}

// Read-only posture (analog of codex --sandbox read-only -c approval_policy=never).
// In headless -p mode an out-of-policy tool is AUTO-DENIED (never hangs), so this
// is safe without --dangerously-skip-permissions. Bash is scoped to pdftotext so
// the agent cannot route a write through the shell.
var RO_ALLOW = ["Bash(pdftotext:*)", "Read"];
var RO_WEB = ["WebSearch", "WebFetch"];
var RO_DENY = ["Write", "Edit", "NotebookEdit"];

export function buildArgv(workdir, sessionId, prompt, opts) {
  opts = opts || {};
  // -p is a BARE flag; the prompt is the LAST arg, after a "--" end-of-options
  // separator, so a message that starts with "-"/"--" (e.g. "-h means…") is not
  // mis-parsed by claude's CLI parser as an unknown option.
  var argv = [
    "-p",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--permission-mode",
    opts.permissionMode || "default",
  ];
  // grant read access to the workdir (CLAUDE.md) and the PDF's directory.
  argv.push("--add-dir", workdir);
  if (opts.addDir && opts.addDir !== workdir)
    argv.push("--add-dir", opts.addDir);
  // grant read access to each attached image's directory (deduped; skip ones already
  // covered by workdir/addDir). claude has no image input flag — it "sees" an image
  // by reading the file with its (multimodal) Read tool, so the dir must be allowed.
  var imgDirs = [];
  if (opts.images && opts.images.length) {
    var covered = [workdir];
    if (opts.addDir) covered.push(opts.addDir);
    for (var di = 0; di < opts.images.length; di++) {
      if (!opts.images[di]) continue;
      var d = parentDir(opts.images[di]);
      if (covered.indexOf(d) < 0 && imgDirs.indexOf(d) < 0) imgDirs.push(d);
    }
    for (var dj = 0; dj < imgDirs.length; dj++)
      argv.push("--add-dir", imgDirs[dj]);
  }
  // --allowedTools is variadic; --disallowedTools (a flag) terminates the list.
  var allow = RO_ALLOW.slice();
  if (opts.webSearch !== false) allow = allow.concat(RO_WEB);
  argv.push("--allowedTools");
  argv = argv.concat(allow);
  argv.push("--disallowedTools");
  argv = argv.concat(RO_DENY);
  if (opts.claudeModel) argv.push("--model", opts.claudeModel);
  if (sessionId) argv.push("--resume", sessionId);
  // claude has no image-input flag in -p mode; tell it to view each attached image
  // with the Read tool (the dirs were allow-listed via --add-dir above).
  var finalPrompt = prompt;
  if (opts.images && opts.images.length) {
    var lines = [];
    for (var pi = 0; pi < opts.images.length; pi++) {
      if (opts.images[pi]) lines.push("  " + opts.images[pi]);
    }
    if (lines.length)
      finalPrompt =
        prompt +
        "\n\n[The user attached the following image file(s). View them with the Read tool to answer:\n" +
        lines.join("\n") +
        "\n]";
  }
  argv.push("--", finalPrompt);
  return argv;
}

function friendlyError(message) {
  var low = String(message || "").toLowerCase();
  if (low.indexOf("not logged in") >= 0 || low.indexOf("/login") >= 0)
    return "Claude is not logged in — run `claude /login` in a terminal.";
  if (
    low.indexOf("rate limit") >= 0 ||
    low.indexOf("out_of_credits") >= 0 ||
    low.indexOf("overage") >= 0
  )
    return "Claude is rate limited or out of credits — wait a bit or check your plan.";
  return message;
}

// Map one parsed stream-json line to zero or more AgentEvents.
export function mapLine(msg) {
  var t = msg && msg.type;

  if (t === "system") {
    if (msg.subtype === "init") {
      var initEvents = [];
      if (msg.session_id)
        initEvents.push({ kind: "thread_started", sessionId: msg.session_id });
      if (msg.model && msg.model !== "<synthetic>")
        initEvents.push({
          kind: "runtime_info",
          backend: "claude",
          model: msg.model,
          source: "system-init",
        });
      return initEvents;
    }
    return [];
  }

  // Claude duplicates answer text in this full assistant message, so continue to
  // ignore its content. It is, however, the authoritative place where Claude
  // Code reports the concrete model behind an alias/default.
  if (t === "assistant") {
    var model = (msg.message && msg.message.model) || msg.model || "";
    if (model && model !== "<synthetic>")
      return [
        {
          kind: "runtime_info",
          backend: "claude",
          model: model,
          source: "assistant-message",
        },
      ];
    return [];
  }

  if (t === "stream_event") {
    var e = msg.event || {};
    if (e.type === "content_block_delta") {
      var d = e.delta || {};
      // ONLY text_delta is answer text; thinking_delta/input_json_delta share this envelope.
      if (
        d.type === "text_delta" &&
        typeof d.text === "string" &&
        d.text.length
      )
        return [{ kind: "delta", text: d.text }];
      return [];
    }
    if (e.type === "content_block_start") {
      var cb = e.content_block || {};
      if (cb.type === "tool_use") {
        var detail = "";
        if (cb.input && typeof cb.input === "object") {
          try {
            detail = JSON.stringify(cb.input);
          } catch (e2) {}
          if (detail === "{}") detail = "";
        }
        return [{ kind: "tool", toolName: cb.name || "tool", detail: detail }];
      }
      return [];
    }
    return [];
  }

  if (t === "result") {
    // is_error is the ONLY reliable terminal signal (subtype stays "success").
    if (msg.is_error) {
      var m = "";
      if (Array.isArray(msg.errors) && msg.errors.length)
        m = msg.errors.join("; ");
      else if (typeof msg.result === "string" && msg.result) m = msg.result;
      else m = "claude turn failed";
      return [{ kind: "error", message: friendlyError(m) }];
    }
    return [{ kind: "done", usage: msg.usage }];
  }

  // "assistant" full-text message, "user" tool_result, rate_limit_event,
  // system/status, thinking blocks — all informational, ignored.
  return [];
}

// Drive one turn. Same contract as the codex drivers' runTurn.
export async function runTurn(
  opts,
  workdir,
  sessionId,
  prompt,
  onEvent,
  liveRef,
) {
  opts = opts || {};
  var Subprocess = getSubprocess();
  var command, env;
  try {
    var r = await resolveClaude(opts);
    command = r.command;
    env = r.env;
  } catch (e) {
    onEvent({ kind: "error", message: String(e && e.message ? e.message : e) });
    return { exitCode: -1 };
  }

  var argv = buildArgv(workdir, sessionId, prompt, opts);
  var proc;
  try {
    proc = await Subprocess.call({
      command: command,
      arguments: argv,
      workdir: workdir,
      environment: env,
      environmentAppend: true,
      stderr: "pipe",
    });
  } catch (e) {
    onEvent({ kind: "error", message: "failed to start claude: " + e });
    return { exitCode: -1 };
  }

  // -p reads no stdin; close it so claude never blocks waiting for input.
  try {
    proc.stdin.close();
  } catch (e) {}

  var killed = false;
  var sawTerminal = false;
  var gotText = false;
  var gotThread = false;
  var resumeFailed = false;
  var timer = null;
  function stopTimer() {
    if (timer) {
      try {
        clearTimeout(timer);
      } catch (e) {}
      timer = null;
    }
  }
  // exactly one terminal event per turn (no events after done/error/cancel).
  function emitTerminal(ev) {
    if (sawTerminal) return;
    sawTerminal = true;
    stopTimer();
    onEvent(ev);
  }

  if (liveRef)
    liveRef.kill = function () {
      if (sawTerminal) return;
      killed = true;
      try {
        proc.kill();
      } catch (e) {}
      emitTerminal({ kind: "error", message: "cancelled" });
    };

  var timeoutMs = (opts.timeoutSec || 600) * 1000;
  timer = setTimeout(function () {
    if (sawTerminal) return;
    killed = true;
    try {
      proc.kill();
    } catch (e) {}
    emitTerminal({
      kind: "error",
      message: "claude turn timed out after " + timeoutMs / 1000 + "s",
    });
  }, timeoutMs);

  var buffer = "";
  try {
    var chunk;
    while ((chunk = await proc.stdout.readString())) {
      if (killed || sawTerminal || resumeFailed) break;
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
        } // skip non-JSON (e.g. "No conversation found")
        var evs = mapLine(msg);
        for (var i = 0; i < evs.length; i++) {
          var ev = evs[i];
          if (ev.kind === "thread_started") gotThread = true;
          if (ev.kind === "delta") gotText = true;
          // A stale --resume errors out with NO init line (no thread_started) and no
          // output. Swallow it and retry once with a fresh session (below), mirroring
          // codex appServer's resume→fresh fallback — otherwise the dead id is re-sent
          // every turn and the conversation is permanently stuck.
          if (ev.kind === "error" && sessionId && !gotThread && !gotText) {
            resumeFailed = true;
            break;
          }
          // out-of-credits / rate-limited turns come back as is_error:false but
          // EMPTY (no deltas, output_tokens 0). Don't show the user a blank "done".
          if (
            ev.kind === "done" &&
            !gotText &&
            !(msg.usage && msg.usage.output_tokens)
          ) {
            ev = {
              kind: "error",
              message:
                "Claude returned an empty response — you may be rate limited or out of credits. Try again shortly or check your Claude usage.",
            };
          }
          if (ev.kind === "done" || ev.kind === "error") emitTerminal(ev);
          else onEvent(ev);
        }
        if (resumeFailed || sawTerminal) break;
      }
      if (resumeFailed || sawTerminal) break;
    }
    var res = await proc.wait();
    stopTimer();
    // resume failed → retry ONCE without --resume (fresh session refreshes the
    // stored handle via the new thread_started). One level deep: the retry passes
    // sessionId=null, so it cannot resume-fail again.
    if (resumeFailed && !killed) {
      log("claude resume failed; starting a fresh session");
      return await runTurn(opts, workdir, null, prompt, onEvent, liveRef);
    }
    if (!killed && !sawTerminal) {
      if (res.exitCode !== 0) {
        var err = "";
        try {
          err = await proc.stderr.readString();
        } catch (e) {}
        emitTerminal({
          kind: "error",
          message:
            "claude exited " +
            res.exitCode +
            (err ? ": " + String(err).slice(-400) : ""),
        });
      } else {
        emitTerminal({ kind: "done" });
      }
    }
    return res;
  } catch (e) {
    stopTimer();
    emitTerminal({ kind: "error", message: "claude stream error: " + e });
    try {
      proc.kill();
    } catch (e2) {}
    return { exitCode: -1 };
  }
}

export async function healthcheck(opts) {
  opts = opts || {};
  try {
    var Subprocess = getSubprocess();
    var command, env;
    try {
      var r = await resolveClaude(opts);
      command = r.command;
      env = r.env;
    } catch (e) {
      return { ok: false, error: "claude not found" };
    }
    var proc = await Subprocess.call({
      command: command,
      arguments: ["--version"],
      environment: env,
      environmentAppend: true,
    });
    var out = "",
      c;
    while ((c = await proc.stdout.readString())) out += c;
    var res = await proc.wait();
    return { ok: res.exitCode === 0, version: String(out).trim() };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function getModelInfo(opts, _forceRefresh) {
  return claudeModelInfo(opts || {});
}

// one-process-per-turn: nothing persistent to tear down (per-turn procs are
// killed via liveRef on Stop / timeout).
export function shutdown() {}
