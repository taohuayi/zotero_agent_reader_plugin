// @ts-nocheck
/*
 * chatPanel.ts — the Zotero item-pane chat section (privileged chrome only).
 *
 * Registers ONE section via Zotero.ItemPaneManager.registerSection; it docks in
 * the reader tab's right pane (beside the PDF) and in the library item pane,
 * auto-scoped to the current item. Streams codex deltas straight into the live
 * `body` DOM node — no HTTP, no SSE.
 */
import * as PRARender from "./render";
import { getBackend } from "./backends";
import * as PRAItemContext from "./itemContext";
import * as PRAStore from "./store";
import * as PRAChatService from "./chatService";
import * as PRAUpdater from "./updater";
import { resolveReferenceNearPage } from "./referenceResolver";
import { backendStatusLabel, messageModelLabel } from "./modelInfo";
import { preserveStreamingScroll, scrollToBottom } from "./streamingScroll";

var SECTION_ID = null;
var PLUGIN_ID = null;
var ROOT_URI = null;

function prefs() {
  function g(k, d) {
    var v = Zotero.Prefs.get("extensions.paper-reading-agent." + k, true);
    return v === undefined || v === null || v === "" ? d : v;
  }
  return {
    backend: g("backend", "codex") || "codex", // codex | claude
    // codex-specific
    codexPath: g("codexPath", "") || undefined,
    model: g("model", "") || undefined,
    codexLastModel: g("codexLastModel", "") || undefined,
    reasoningEffort: g("reasoningEffort", "") || undefined, // minimal|low|medium|high — lower = faster, less deep
    sandbox: "read-only",
    // claude-specific
    claudePath: g("claudePath", "") || undefined,
    claudeModel: g("claudeModel", "") || undefined, // e.g. sonnet | haiku (default: claude's default)
    claudeLastModel: g("claudeLastModel", "") || undefined,
    permissionMode: g("permissionMode", "") || undefined, // default (read-only allowlist applied in the driver)
    // shared
    timeoutSec: parseInt(g("timeoutSec", 600), 10) || 600,
    webSearch: g("webSearch", true) !== false,
  };
}

function el(doc, tag, css, text) {
  var e = doc.createElement(tag);
  if (css) e.style.cssText = css;
  if (text != null) e.textContent = text;
  return e;
}

// Full chat styling. Colors come from Zotero's own design tokens (so the panel
// is native-looking AND follows light/dark automatically), each with a fallback.
var PRA_CSS = [
  // layout
  ".pra-wrap{display:flex;flex-direction:column;gap:10px;padding:10px 8px 12px;font:13px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:var(--fill-primary,#1d2129);}",
  // health banner → subtle pill with a status dot
  ".pra-banner{display:inline-flex;align-items:center;gap:6px;align-self:flex-start;font-size:11px;padding:3px 10px;border-radius:999px;background:var(--fill-quinary,rgba(0,0,0,.05));color:var(--fill-secondary,#6b7280);max-width:100%;}",
  ".pra-banner::before{content:'';width:7px;height:7px;border-radius:50%;background:currentColor;flex:none;}",
  ".pra-banner.ok{color:var(--accent-green,#2a9d4a);}.pra-banner.err{color:var(--accent-red,#d23b3b);}",
  // messages — user-select:text makes the transcript selectable/copyable. Zotero's
  // item-pane is a privileged XUL document whose default is -moz-user-select:none,
  // which content inherits; we must explicitly opt the message area back in (this
  // only changes selection behaviour, not layout/appearance).
  ".pra-messages{display:flex;flex-direction:column;gap:16px;overflow-y:auto;max-height:56vh;padding:2px 1px;-moz-user-select:text;user-select:text;}",
  ".pra-row{display:flex;}.pra-row.user{justify-content:flex-end;}.pra-row.assistant{justify-content:flex-start;}",
  // user = accent bubble; assistant = clean full-width prose (premium, uses narrow pane well)
  ".pra-bubble{word-break:break-word;}",
  ".pra-bubble.user{max-width:86%;padding:8px 12px;border-radius:15px 15px 5px 15px;background:var(--accent-blue,#2563eb);color:var(--accent-white,#fff);white-space:pre-wrap;box-shadow:0 1px 2px rgba(0,0,0,.14);}",
  ".pra-bubble.assistant{max-width:100%;width:100%;white-space:pre-wrap;}",
  ".pra-bubble.assistant[data-model-label]::before{content:attr(data-model-label);display:block;margin:0 0 5px;font-size:10.5px;line-height:1.35;letter-spacing:.01em;color:var(--fill-tertiary,#8a8f98);white-space:normal;}",
  // blinking streaming caret
  ".pra-bubble.streaming::after{content:'\\2588';margin-left:1px;font-size:.9em;color:var(--accent-blue,#2563eb);animation:pra-blink 1.05s steps(1) infinite;}",
  "@keyframes pra-blink{50%{opacity:0;}}",
  // status line
  ".pra-status{display:flex;align-items:center;gap:6px;min-height:16px;font-size:11px;color:var(--fill-secondary,#888);}",
  // composer = a large card holding the textarea + a bottom bar with Send (codex/claude-code style)
  ".pra-composer{display:flex;flex-direction:column;gap:8px;border:1px solid var(--color-border,rgba(0,0,0,.16));border-radius:16px;background:var(--color-control,#fff);padding:11px 11px 9px 13px;transition:border-color .15s,box-shadow .15s;}",
  ".pra-composer:focus-within{border-color:var(--accent-blue,#2563eb);box-shadow:0 0 0 3px var(--accent-blue10,rgba(64,114,229,.15));}",
  ".pra-input{border:none;outline:none;background:transparent;resize:none;width:100%;min-height:30px;max-height:340px;padding:0;font:inherit;line-height:1.55;color:var(--fill-primary,#1d2129);}",
  ".pra-input::placeholder{color:var(--fill-tertiary,#9aa0a6);}",
  ".pra-input:disabled{opacity:.6;}",
  ".pra-bar{display:flex;justify-content:flex-end;align-items:center;}",
  ".pra-send{flex:none;height:34px;padding:0 20px;border:none;border-radius:10px;cursor:pointer;background:var(--accent-blue,#2563eb);color:var(--accent-white,#fff);font:inherit;font-weight:600;transition:filter .15s,opacity .15s;}",
  ".pra-send:hover{filter:brightness(1.07);}.pra-send:active{filter:brightness(.95);}.pra-send:disabled{opacity:.5;cursor:default;}",
  ".pra-send.stop{background:var(--accent-red,#d23b3b);}",
  // pending image attachments (composer) — small removable thumbnails
  ".pra-attach{display:flex;flex-wrap:wrap;gap:6px;}",
  ".pra-chip{position:relative;width:46px;height:46px;border-radius:8px;overflow:hidden;border:1px solid var(--color-border,rgba(0,0,0,.16));background:var(--fill-quinary,rgba(0,0,0,.06));flex:none;}",
  ".pra-chip-img{width:100%;height:100%;object-fit:cover;display:block;}",
  ".pra-chip-x{position:absolute;top:1px;right:1px;width:16px;height:16px;line-height:14px;padding:0;border:none;border-radius:50%;background:rgba(0,0,0,.55);color:#fff;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;}",
  ".pra-chip-x:hover{background:rgba(0,0,0,.75);}",
  // image thumbnails shown inside a sent user message
  ".pra-msg-imgs{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px;}",
  ".pra-msg-imgs img{max-width:180px;max-height:180px;border-radius:8px;border:1px solid var(--accent-white30,rgba(255,255,255,.35));display:block;}",
  ".pra-msg-imgph{padding:6px 10px;border-radius:8px;background:rgba(255,255,255,.22);font-size:.85em;}",
  // ---- markdown (assistant) ----
  ".pra-md>:first-child{margin-top:0;}.pra-md>:last-child{margin-bottom:0;}",
  ".pra-md p{margin:0 0 8px;}.pra-md ul,.pra-md ol{margin:6px 0;padding-left:22px;}.pra-md li{margin:2px 0;}",
  ".pra-md h1,.pra-md h2,.pra-md h3,.pra-md h4{margin:12px 0 6px;font-weight:650;line-height:1.3;}",
  ".pra-md h1{font-size:1.25em;}.pra-md h2{font-size:1.15em;}.pra-md h3{font-size:1.06em;}.pra-md h4{font-size:1em;}",
  ".pra-md pre{background:var(--fill-quinary,rgba(0,0,0,.05));border:1px solid var(--color-border,rgba(0,0,0,.08));padding:8px 10px;border-radius:9px;overflow-x:auto;margin:8px 0;}",
  ".pra-md code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em;}",
  ".pra-md :not(pre)>code{background:var(--fill-quinary,rgba(0,0,0,.06));padding:1.5px 5px;border-radius:5px;}",
  ".pra-md blockquote{margin:8px 0;padding:2px 0 2px 12px;border-left:3px solid var(--accent-blue30,rgba(64,114,229,.3));color:var(--fill-secondary,#555);}",
  ".pra-md a{color:var(--accent-blue,#2563eb);text-decoration:none;}.pra-md a:hover{text-decoration:underline;}",
  // clickable PDF source citation: visible verbatim evidence + physical page
  ".pra-cite{cursor:pointer;color:var(--fill-primary,#1d2129);border:1px solid var(--accent-blue30,rgba(64,114,229,.35));border-radius:6px;padding:1px 5px;margin:0 1px;font-size:.84em;line-height:1.7;background:var(--accent-blue10,rgba(64,114,229,.08));box-decoration-break:clone;-webkit-box-decoration-break:clone;}",
  ".pra-cite-page{color:var(--accent-blue,#2563eb);font-weight:600;white-space:nowrap;}",
  ".pra-cite-quote{color:var(--fill-secondary,#4b5563);}",
  ".pra-cite:hover{background:var(--accent-blue10,rgba(64,114,229,.13));}",
  ".pra-cite.corrected{border-color:var(--accent-green,#2a9d4a);}",
  ".pra-cite.unverified,.pra-cite.ambiguous{border-style:dashed;}",
  ".pra-cite.locating{opacity:.62;cursor:progress;}",
  ".pra-md table{border-collapse:collapse;margin:8px 0;font-size:.95em;}",
  ".pra-md th,.pra-md td{border:1px solid var(--color-border,rgba(0,0,0,.15));padding:4px 8px;}",
  ".pra-md th{background:var(--fill-quinary,rgba(0,0,0,.04));font-weight:600;}",
  ".pra-md hr{border:none;border-top:1px solid var(--color-border,rgba(0,0,0,.1));margin:10px 0;}",
  ".pra-md img{max-width:100%;}",
  ".pra-md .katex-display{margin:10px 0;overflow-x:auto;overflow-y:hidden;padding:2px 0;}",
].join("");

// Inject KaTeX's stylesheet + our chat CSS into the panel's OWN subtree (wrap).
// Putting them in our HTML subtree (NOT doc.head — which does not reliably apply
// in the Zotero item-pane document) is what makes the styles take effect.
function injectStyles(doc, wrap) {
  try {
    if (ROOT_URI) {
      var link = doc.createElement("link");
      link.rel = "stylesheet";
      link.href = ROOT_URI + "content/vendor/katex.min.css";
      wrap.appendChild(link);
    }
    var style = doc.createElement("style");
    style.textContent = PRA_CSS;
    wrap.appendChild(style);
  } catch (e) {
    try {
      Zotero.debug("[PaperReadingAgent] injectStyles: " + e);
    } catch (e2) {}
  }
}

// Jump the open PDF reader to a page (1-based). Resolve WHICH reader robustly:
// the one already showing this attachment → else the active reader tab (the paper
// the user is looking at) → else any open reader → else open the attachment. The
// bare itemID match alone is unreliable when an item has multiple attachments
// (the resolved PDF may differ from the one open in the reader), which silently
// fell through to Reader.open() and did nothing for an already-open reader.
async function navigateToReference(attachmentID, page, quote) {
  if (!page) return { exact: false, opened: false };
  var loc = { pageIndex: page - 1 }; // Reader pageIndex is 0-based
  try {
    var R = Zotero.Reader;
    var readers = (R && R._readers) || [];
    var r = attachmentID
      ? readers.find(function (x) {
          return x.itemID === attachmentID;
        })
      : null;
    if (!r || !r.navigate) {
      // active tab only when it is the same attachment
      try {
        var win = Zotero.getMainWindow && Zotero.getMainWindow();
        var selID = win && win.Zotero_Tabs && win.Zotero_Tabs.selectedID;
        var ar = selID && R && R.getByTabID ? R.getByTabID(selID) : null;
        if (ar && ar.navigate && (!attachmentID || ar.itemID === attachmentID))
          r = ar;
      } catch (e) {}
    }
    if ((!r || !r.navigate) && attachmentID && R && R.open) {
      var opened = await R.open(attachmentID, loc); // open the correct attachment, never an unrelated reader
      r =
        opened ||
        (R._readers || []).find(function (x) {
          return x.itemID === attachmentID;
        });
      if (r && r._initPromise) {
        try {
          await r._initPromise;
        } catch (e) {}
      }
    }

    if (r && r.navigate && quote) {
      try {
        var resolved = await resolveReferenceNearPage(r, page - 1, quote, {
          timeoutMs: 4500,
          neighborRadius: 1,
        });
        if (resolved && resolved.position) {
          await r.navigate({ position: resolved.position });
          return {
            exact: true,
            opened: true,
            matchCount: resolved.matchCount,
            corrected: resolved.corrected,
            resolvedPage: resolved.resolvedPageIndex + 1,
          };
        }
      } catch (e) {
        try {
          Zotero.debug("[PaperReadingAgent] exact cite resolve: " + e);
        } catch (e2) {}
      }
    }
    if (r && r.navigate) {
      await r.navigate(loc);
      return { exact: false, opened: true };
    }
    if (attachmentID && R && R.open) {
      await R.open(attachmentID, loc);
      return { exact: false, opened: true };
    }
  } catch (e) {
    try {
      Zotero.debug("[PaperReadingAgent] cite navigate: " + e);
    } catch (e2) {}
  }
  return { exact: false, opened: false };
}

// Render assistant text as Markdown+math HTML; fall back to plain text on any
// failure (never inject unsanitized HTML into the privileged node).
function setRich(bubble, text, attachmentID, citations) {
  var html = null;
  try {
    var win = bubble.ownerDocument && bubble.ownerDocument.defaultView;
    if (PRARender && win) html = PRARender.render(text, win, citations);
  } catch (e) {
    html = null;
  }
  if (html == null) {
    bubble.textContent = text || "";
    return;
  }
  try {
    bubble.innerHTML = html; // can throw in a strict (XHTML) item-pane doc on odd HTML
    bubble.classList.add("pra-md");
    bubble.style.whiteSpace = "normal";
  } catch (e) {
    try {
      Zotero.debug(
        "[PaperReadingAgent] setRich innerHTML failed, falling back to text: " +
          e,
      );
    } catch (e2) {}
    bubble.textContent = text || "";
    return;
  }
  try {
    var as = bubble.querySelectorAll("a[href]");
    for (var i = 0; i < as.length; i++) {
      (function (href) {
        // open links in the external browser, never navigate the item pane
        as[i].addEventListener("click", function (e) {
          e.preventDefault();
          try {
            Zotero.launchURL(href);
          } catch (e2) {}
        });
      })(as[i].getAttribute("href"));
    }
    // [p.N] citation clicks are handled via ONE delegated listener on the
    // messages container (see mount) — robust to streaming re-renders and to any
    // single span missing its binding.
  } catch (e) {}
}

// Downscale an image File/Blob to a small JPEG data URL for in-chat display +
// persistence (keeps the conversation JSON light; full-res file goes to the agent).
// Resolves null on any failure — callers degrade to a generic chip.
function makeThumb(doc, file) {
  return new Promise(function (resolve) {
    try {
      var win = doc.defaultView;
      var url = win.URL.createObjectURL(file);
      var img = doc.createElement("img");
      img.onload = function () {
        try {
          var max = 320; // longest side; covers retina chips
          var w = img.naturalWidth || 1,
            h = img.naturalHeight || 1;
          var s = Math.min(1, max / Math.max(w, h));
          var cw = Math.max(1, Math.round(w * s)),
            ch = Math.max(1, Math.round(h * s));
          var canvas = doc.createElement("canvas");
          canvas.width = cw;
          canvas.height = ch;
          canvas.getContext("2d").drawImage(img, 0, 0, cw, ch);
          var data = canvas.toDataURL("image/jpeg", 0.72);
          try {
            win.URL.revokeObjectURL(url);
          } catch (e) {}
          resolve(data || null);
        } catch (e) {
          try {
            win.URL.revokeObjectURL(url);
          } catch (e2) {}
          resolve(null);
        }
      };
      img.onerror = function () {
        try {
          win.URL.revokeObjectURL(url);
        } catch (e) {}
        resolve(null);
      };
      img.src = url;
    } catch (e) {
      resolve(null);
    }
  });
}

// Queue a pasted image for the NEXT turn. We keep the in-memory Blob (+ a thumb for
// the chip) and only write it to disk on send (see persistPending) — so an image the
// user removes with × or abandons by navigating away never touches disk, avoiding an
// orphaned-file leak in <workdir>/images.
async function addPendingImage(session, file) {
  try {
    var doc = session.view && session.view.doc;
    if (!doc) return;
    var thumb = await makeThumb(doc, file);
    if (!session.pending) session.pending = [];
    session.pending.push({ file: file, thumb: thumb });
    renderPending(session);
  } catch (e) {
    try {
      Zotero.debug("[PaperReadingAgent] addPendingImage: " + e);
    } catch (e2) {}
  }
}

// On send, write each queued image to <workdir>/images and return [{path, thumb}] for
// the turn. Files written here ARE retained (they back the persisted transcript). An
// image that fails to write is dropped (best-effort) rather than aborting the send.
var IMG_SEQ = 0;
async function persistPending(ctx, pend) {
  var out = [];
  if (!pend || !pend.length) return out;
  var dir = PathUtils.join(ctx.workdir, "images");
  try {
    await IOUtils.makeDirectory(dir, {
      ignoreExisting: true,
      createAncestors: true,
    });
  } catch (e) {}
  for (var i = 0; i < pend.length; i++) {
    var im = pend[i];
    try {
      var buf = await im.file.arrayBuffer();
      var ext =
        ((im.file.type || "image/png").split("/")[1] || "png")
          .replace(/[^a-z0-9]/gi, "")
          .slice(0, 5) || "png";
      var path = PathUtils.join(
        dir,
        "img-" + Date.now() + "-" + ++IMG_SEQ + "." + ext,
      );
      await IOUtils.write(path, new Uint8Array(buf));
      out.push({ path: path, thumb: im.thumb || null });
    } catch (e) {
      try {
        Zotero.debug("[PaperReadingAgent] persistPending: " + e);
      } catch (e2) {}
    }
  }
  return out;
}

// Paint the pending-attachment chips in the composer (hidden when empty).
function renderPending(session) {
  var v = session.view;
  if (!v || !v.ui.attach) return;
  var doc = v.doc,
    box = v.ui.attach,
    pend = session.pending || [];
  box.textContent = "";
  box.style.display = pend.length ? "flex" : "none";
  pend.forEach(function (im) {
    var chip = el(doc, "div");
    chip.className = "pra-chip";
    if (im.thumb) {
      var t = el(doc, "img");
      t.className = "pra-chip-img";
      t.src = im.thumb;
      chip.appendChild(t);
    }
    var x = el(doc, "button", null, "×");
    x.className = "pra-chip-x";
    x.setAttribute("title", "Remove");
    x.addEventListener("click", function () {
      var i = session.pending.indexOf(im);
      if (i >= 0) session.pending.splice(i, 1);
      renderPending(session);
    });
    chip.appendChild(x);
    box.appendChild(chip);
  });
}

function renderMessage(doc, container, msg, attachmentID) {
  var row = el(doc, "div");
  row.className = "pra-row " + (msg.role === "user" ? "user" : "assistant");
  var bubble = el(doc, "div");
  bubble.className =
    "pra-bubble " + (msg.role === "user" ? "user" : "assistant");
  paintAssistantMetadata(bubble, msg);
  // a user message may carry image thumbnails (data URLs) above its text
  if (msg.role === "user" && msg.images && msg.images.length) {
    var imgsDiv = el(doc, "div");
    imgsDiv.className = "pra-msg-imgs";
    msg.images.forEach(function (im) {
      if (!im) return;
      if (im.thumb) {
        var pic = el(doc, "img");
        pic.src = im.thumb;
        imgsDiv.appendChild(pic);
      } else
        imgsDiv.appendChild(el(doc, "div", null, "🖼 image")).className =
          "pra-msg-imgph"; // thumb failed → placeholder, never an empty bubble
    });
    if (imgsDiv.childNodes.length) bubble.appendChild(imgsDiv);
    if (msg.content) {
      var txt = el(doc, "div");
      txt.textContent = msg.content;
      bubble.appendChild(txt);
    }
  } else if (msg.role === "assistant" && msg.content) {
    setRich(bubble, msg.content, attachmentID, msg.citations);
  } else {
    bubble.textContent = msg.content || "";
  }
  row.appendChild(bubble);
  container.appendChild(row);
  return bubble;
}

function paintAssistantMetadata(bubble, message) {
  if (!bubble || !message || message.role !== "assistant") return;
  var label = messageModelLabel(message);
  if (label) bubble.setAttribute("data-model-label", label);
  else bubble.removeAttribute("data-model-label");
}

function rememberEffectiveModel(backendID, model) {
  if (!model || (backendID !== "codex" && backendID !== "claude")) return;
  try {
    var key = backendID === "claude" ? "claudeLastModel" : "codexLastModel";
    Zotero.Prefs.set(
      "extensions.paper-reading-agent." + key,
      String(model),
      true,
    );
  } catch (e) {}
}

function buildSkeleton(doc, body) {
  body.textContent = "";
  var wrap = el(doc, "div");
  wrap.className = "pra-wrap";
  injectStyles(doc, wrap);
  var banner = el(doc, "div");
  banner.className = "pra-banner";
  var messages = el(doc, "div");
  messages.className = "pra-messages";
  var status = el(doc, "div");
  status.className = "pra-status";
  var composer = el(doc, "div");
  composer.className = "pra-composer";
  var input = el(doc, "textarea");
  input.className = "pra-input";
  input.setAttribute("rows", "4");
  input.setAttribute(
    "placeholder",
    "Ask about this paper…   (Enter to send · Shift+Enter for a new line)",
  );
  var attach = el(doc, "div");
  attach.className = "pra-attach";
  attach.style.display = "none";
  var bar = el(doc, "div");
  bar.className = "pra-bar";
  var send = el(doc, "button");
  send.className = "pra-send";
  send.textContent = "Send";
  bar.appendChild(send);
  composer.append(input, attach, bar);
  wrap.append(banner, messages, status, composer);
  body.append(wrap);
  return {
    banner: banner,
    messages: messages,
    status: status,
    input: input,
    send: send,
    attach: attach,
  };
}

// ---- Session model ---------------------------------------------------------
// A turn (in-flight codex request + its streaming) is owned by a module-level
// SESSION keyed by the paper's attachment key — NOT by a panel mount. So when
// Zotero re-renders/destroys/recreates the item-pane section (on tab switch,
// clicking a citation that opens the reader, item change, scroll), the turn
// KEEPS RUNNING and the next mount RE-ATTACHES to it. All painting reads
// `session.view` (the current ui), so a re-mount just swaps the view.
var SESSIONS = Object.create(null); // attachmentKey -> session
function getSession(key) {
  return (
    SESSIONS[key] ||
    (SESSIONS[key] = {
      key: key,
      ctx: null,
      conv: null,
      run: null,
      richId: 0,
      view: null,
      pending: [],
    })
  );
}
function isBusy(session) {
  return !!(session.run && !session.run.finished);
}

function setSending(session, busy) {
  var v = session.view;
  if (!v) return;
  v.ui.input.disabled = busy;
  v.ui.send.disabled = false; // stays clickable as a Stop button while busy
  v.ui.send.textContent = busy ? "Stop" : "Send";
  v.ui.send.classList.toggle("stop", busy);
}
function paintStatus(session) {
  var v = session.view,
    r = session.run;
  if (v && r && !r.finished) {
    v.ui.status.textContent =
      "⚙ " +
      r.lastActivity +
      " · " +
      Math.round((Date.now() - r.startedAt) / 1000) +
      "s";
  }
}
function renderAssistant(session) {
  // render run.text into the CURRENT view's bubble
  var v = session.view,
    r = session.run;
  if (v && v.assistantBubble && r) {
    preserveStreamingScroll(v.ui.messages, function () {
      paintAssistantMetadata(v.assistantBubble, r.message);
      setRich(
        v.assistantBubble,
        r.text,
        v.attachmentID,
        r.message && r.message.citations,
      );
    });
  }
}
function scheduleRender(session) {
  // ~16fps; setTimeout (not rAF, which pauses off-screen)
  if (session.richId) return;
  session.richId = setTimeout(function () {
    session.richId = 0;
    renderAssistant(session);
  }, 60);
}
function flushRender(session) {
  if (session.richId) {
    try {
      clearTimeout(session.richId);
    } catch (e) {}
    session.richId = 0;
  }
  renderAssistant(session);
}

function startTurn(session, content, images) {
  var run = (session.run = {
    liveRef: {},
    startedAt: Date.now(),
    lastActivity: "thinking…",
    finished: false,
    text: "",
    target: "",
    drip: 0,
    timer: 0,
  });
  setSending(session, true);
  paintStatus(session);
  run.timer = setInterval(function () {
    paintStatus(session);
  }, 1000);
  function endTurn(errMsg) {
    if (run.finished) return;
    run.finished = true;
    try {
      clearInterval(run.timer);
    } catch (e) {}
    try {
      clearInterval(run.drip);
    } catch (e) {}
    run.drip = 0;
    run.text = run.target; // reveal any not-yet-dripped tail, then render the full answer
    flushRender(session);
    var v = session.view;
    if (v) {
      if (v.assistantBubble) v.assistantBubble.classList.remove("streaming");
      v.ui.status.textContent = errMsg ? "⚠ " + errMsg : "";
    }
    session.run = null;
    setSending(session, false);
  }
  // Typewriter buffer: some backends (claude -p) stream in big lumpy bursts
  // (~30 chars every ~0.5s) instead of per-token, which looks janky. Reveal the
  // received text at a steady cadence so it flows smoothly. Adaptive — the step
  // grows with the backlog, so a token-level backend (codex) stays ~realtime.
  function startDrip() {
    if (run.drip) return;
    run.drip = setInterval(function () {
      if (run.finished) {
        try {
          clearInterval(run.drip);
        } catch (e) {}
        run.drip = 0;
        return;
      }
      if (run.text.length < run.target.length) {
        var backlog = run.target.length - run.text.length;
        var step = Math.max(1, Math.ceil(backlog / 10));
        run.text = run.target.slice(0, run.text.length + step);
        scheduleRender(session);
      }
    }, 40);
  }
  var adapter = {
    onUser: function (m) {
      var v = session.view;
      if (v) {
        renderMessage(v.doc, v.ui.messages, m, v.attachmentID);
        scrollToBottom(v.ui.messages);
      }
    },
    onAssistantStart: function (m) {
      run.message = m;
      var v = session.view;
      if (v) {
        v.assistantBubble = renderMessage(
          v.doc,
          v.ui.messages,
          m,
          v.attachmentID,
        );
        v.assistantBubble.classList.add("streaming");
        // Appending the empty assistant row changes scrollHeight before the
        // first token. Keep the just-started turn in follow mode.
        scrollToBottom(v.ui.messages);
      }
    },
    onAssistantUpdate: function (text) {
      run.target = text;
      startDrip();
    },
    onRuntimeInfo: function (m, ev) {
      run.message = m;
      rememberEffectiveModel(m.backend || (ev && ev.backend), m.model);
      var v = session.view;
      if (v && v.assistantBubble) paintAssistantMetadata(v.assistantBubble, m);
    },
    onStatus: function (s) {
      run.lastActivity = String(s).slice(0, 120);
      paintStatus(session);
    },
    onDone: function () {
      endTurn(null);
    },
    onError: function (msg) {
      endTurn(msg);
    },
  };
  PRAChatService.runTurn(
    prefs(),
    session.ctx,
    session.conv,
    content,
    images,
    adapter,
    run.liveRef,
  ).catch(function (e) {
    endTurn(String(e));
  });
}

// (Re)build the panel for a given item and RE-ATTACH any running turn.
async function mount(body, item) {
  var doc = body.ownerDocument;
  var ui = buildSkeleton(doc, body);

  var p = prefs();
  var backend = getBackend(p.backend);
  getBackendInfo(backend.id).then(function (h) {
    ui.banner.textContent = h.ok
      ? backendStatusLabel(h)
      : backendStatusLabel(h) + " — " + backend.loginHint;
    ui.banner.classList.remove("ok", "err");
    ui.banner.classList.add(h.ok ? "ok" : "err");
  });

  if (!item) {
    ui.banner.textContent = "Select a paper.";
    ui.input.disabled = true;
    ui.send.disabled = true;
    return;
  }

  var ctx;
  try {
    ctx = await PRAItemContext.prepareWorkdir(item);
  } catch (e) {
    ui.status.textContent = "⚠ " + (e && e.message ? e.message : e);
    ui.input.disabled = true;
    ui.send.disabled = true;
    return;
  }

  var session = getSession(ctx.key);
  session.ctx = ctx;
  if (!session.conv) session.conv = await PRAStore.load(ctx.key);

  ui.messages.textContent = "";
  var lastBubble = null;
  session.conv.messages.forEach(function (m) {
    // one bad message must NOT abort mount (else the input never gets wired)
    try {
      lastBubble = renderMessage(doc, ui.messages, m, ctx.attachmentID);
    } catch (e) {
      try {
        Zotero.debug("[PaperReadingAgent] renderMessage failed: " + e);
      } catch (e2) {}
    }
  });
  ui.messages.scrollTop = ui.messages.scrollHeight;

  session.view = {
    ui: ui,
    doc: doc,
    attachmentID: ctx.attachmentID,
    assistantBubble: null,
  };
  renderPending(session); // restore any queued image chips after a re-mount

  if (isBusy(session)) {
    // last message is the in-flight assistant — re-attach to it
    session.view.assistantBubble = lastBubble;
    if (lastBubble) lastBubble.classList.add("streaming");
    setSending(session, true);
    flushRender(session); // make sure the partial answer shows
    paintStatus(session); // the (module-level) timer keeps ticking into this view
  } else {
    setSending(session, false);
  }

  function doSend() {
    var content = (ui.input.value || "").trim();
    var pend =
      session.pending && session.pending.length
        ? session.pending.slice()
        : null;
    try {
      Zotero.debug(
        "[PaperReadingAgent] doSend len=" +
          content.length +
          " imgs=" +
          (pend ? pend.length : 0) +
          " busy=" +
          isBusy(session) +
          " run=" +
          (session.run ? "finished:" + session.run.finished : "null") +
          " view=" +
          !!session.view,
      );
    } catch (e) {}
    if ((!content && !pend) || isBusy(session)) return;
    ui.input.value = "";
    ui.input.style.height = "auto";
    session.pending = [];
    renderPending(session);
    // write queued images to disk first, then start the turn with their paths
    persistPending(ctx, pend).then(function (images) {
      images = images && images.length ? images : null;
      if (!content && !images) {
        ui.status.textContent = "⚠ Could not attach the image(s).";
        return;
      }
      try {
        startTurn(session, content, images);
      } catch (e) {
        try {
          Zotero.debug("[PaperReadingAgent] startTurn threw: " + e);
        } catch (e2) {}
        ui.status.textContent = "⚠ " + e;
      }
    });
  }
  ui.send.addEventListener("click", function () {
    // Send, or Stop (cancel) while a turn runs
    try {
      Zotero.debug("[PaperReadingAgent] send-click busy=" + isBusy(session));
    } catch (e) {}
    if (isBusy(session)) {
      try {
        if (session.run && session.run.liveRef && session.run.liveRef.kill)
          session.run.liveRef.kill();
      } catch (e) {}
    } else doSend();
  });
  ui.input.addEventListener("keydown", function (e) {
    // Do NOT hijack Enter while an IME (e.g. Chinese pinyin) is composing.
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.isComposing &&
      e.keyCode !== 229
    ) {
      e.preventDefault();
      doSend();
    }
  });
  ui.input.addEventListener("input", function () {
    // auto-grow
    ui.input.style.height = "auto";
    ui.input.style.height = Math.min(340, ui.input.scrollHeight) + "px";
  });
  // Paste an image (e.g. a screenshot) straight into the composer → queued as an
  // attachment for the next turn. Only swallow the paste when it actually carries
  // image files; normal text paste is left untouched.
  ui.input.addEventListener("paste", function (e) {
    var items = (e.clipboardData && e.clipboardData.items) || [];
    var files = [];
    for (var i = 0; i < items.length; i++) {
      if (
        items[i].kind === "file" &&
        items[i].type &&
        items[i].type.indexOf("image/") === 0
      ) {
        var f = items[i].getAsFile();
        if (f) files.push(f);
      }
    }
    if (!files.length) return;
    e.preventDefault();
    files.forEach(function (f) {
      addPendingImage(session, f);
    });
  });
  // Delegated citation clicks: resolve the visible quote to exact PDF coordinates;
  // if the text layer cannot be matched, retain the old page-only navigation.
  // ONE listener serves the whole transcript, so it
  // survives streaming re-renders and never depends on per-span binding.
  ui.messages.addEventListener("click", async function (e) {
    var cite = e.target && e.target.closest && e.target.closest(".pra-cite");
    if (!cite || cite.classList.contains("locating")) return;
    cite.classList.add("locating");
    var page = parseInt(cite.getAttribute("data-page"), 10);
    var quote = cite.getAttribute("data-quote") || "";
    try {
      var result = await navigateToReference(ctx.attachmentID, page, quote);
      if (result.corrected && result.resolvedPage) {
        cite.setAttribute("data-page", String(result.resolvedPage));
        cite.classList.add("corrected");
        var pageLabel = cite.querySelector(".pra-cite-page");
        if (pageLabel)
          pageLabel.textContent = "[p." + result.resolvedPage + "]";
      }
      cite.setAttribute(
        "title",
        result.exact && result.corrected
          ? "The cited page was wrong; corrected and highlighted the passage on physical p." +
              result.resolvedPage
          : result.exact
            ? "Opened and highlighted the exact passage"
            : quote
              ? "Exact passage was not found; opened the cited page"
              : "Opened the cited page",
      );
    } finally {
      cite.classList.remove("locating");
    }
  });
}

export function register(arg) {
  PLUGIN_ID = arg && arg.pluginID;
  ROOT_URI = arg && arg.rootURI;
  try {
    // Zotero 7–9 require header/sidenav to carry { l10nID, icon } (NOT a plain
    // `label` — the validator rejects unknown keys). l10nID resolves against
    // the plugin's FTL (addon/locale/en-US/addon.ftl → paper-reading-agent-*),
    // injected into each window in hooks.ts. Icons are background-images themed
    // via -moz-context-properties, so the SVGs use fill="context-fill".
    SECTION_ID = Zotero.ItemPaneManager.registerSection({
      paneID: "paper-reading-agent-chat",
      pluginID: PLUGIN_ID,
      header: {
        l10nID: "paper-reading-agent-header",
        icon: ROOT_URI + "content/icon16.svg",
      },
      sidenav: {
        l10nID: "paper-reading-agent-sidenav",
        icon: ROOT_URI + "content/icon20.svg",
      },
      onRender: function () {
        /* skeleton built in onAsyncRender */
      },
      onAsyncRender: async function (hooks) {
        try {
          await mount(hooks.body, hooks.item);
        } catch (e) {
          Zotero.debug("[PaperReadingAgent] render error: " + e);
        }
      },
      onItemChange: function (hooks) {
        try {
          mount(hooks.body, hooks.item);
        } catch (e) {}
        return true;
      },
      onDestroy: function () {
        /* keep any running turn alive across re-render; the next mount re-attaches. Runs are killed only by Stop or plugin shutdown (appServer.shutdown). */
      },
    });
    Zotero.debug("[PaperReadingAgent] section registered: " + SECTION_ID);
  } catch (e) {
    Zotero.debug("[PaperReadingAgent] registerSection FAILED: " + e);
  }
}

export function unregister() {
  try {
    if (SECTION_ID) Zotero.ItemPaneManager.unregisterSection(SECTION_ID);
  } catch (e) {}
  SECTION_ID = null;
}

export function dump() {
  // debug: inspect per-paper session state from Run JavaScript
  var out = {};
  try {
    Object.keys(SESSIONS).forEach(function (k) {
      var s = SESSIONS[k];
      out[k] = {
        busy: isBusy(s),
        run: s.run
          ? {
              finished: s.run.finished,
              lastActivity: s.run.lastActivity,
              textLen: (s.run.text || "").length,
            }
          : null,
        msgs: s.conv ? s.conv.messages.length : -1,
        hasView: !!s.view,
      };
    });
  } catch (e) {
    out.error = String(e);
  }
  return out;
}

// Run the selected backend's healthcheck — used by the Settings pane's "Test
// connection" button (Zotero.PaperReadingAgent.healthcheck).
export async function getBackendInfo(backendID, forceModelRefresh) {
  var p = prefs();
  if (backendID) p.backend = backendID;
  var backend = getBackend(p.backend);
  var h = await backend.healthcheck(p);
  var out = {
    ok: !!(h && h.ok),
    version: h && h.version,
    error: h && h.error,
    id: backend.id,
    label: backend.label,
  };
  if (out.ok && backend.getModelInfo) {
    try {
      out.modelInfo = await backend.getModelInfo(p, !!forceModelRefresh);
    } catch (e) {
      out.modelError = String(e && e.message ? e.message : e);
    }
  }
  return out;
}

export async function healthcheck() {
  return await getBackendInfo();
}

// On-demand update check/install — used by the Settings pane's "Check for updates"
// button. Uses the plugin id passed to register() (config.addonID).
export async function checkForUpdates() {
  return await PRAUpdater.checkForUpdates(PLUGIN_ID);
}
export async function installUpdate() {
  return await PRAUpdater.installPendingUpdate();
}

// reachable from Run JavaScript for debugging (unchanged handle from v0.1.0)
try {
  Zotero.PaperReadingAgent = {
    register: register,
    unregister: unregister,
    dump: dump,
    healthcheck: healthcheck,
    getBackendInfo: getBackendInfo,
    checkForUpdates: checkForUpdates,
    installUpdate: installUpdate,
  };
} catch (e) {}
