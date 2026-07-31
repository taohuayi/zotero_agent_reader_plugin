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
import { ensureLibrarySnapshot } from "./libraryContext";
import * as PRAReading from "./readingWorkflow";
import * as PRANotebook from "./conversationNotebook";
import * as PRAComposerDraft from "./composerDraft";
import { loadPdfTextIndexPages } from "./pdfTextIndex";

var SECTION_ID = null;
var PLUGIN_ID = null;
var ROOT_URI = null;

// The section lives in Zotero's right-side context pane. Zotero remembers that
// pane independently from our section's own open state, so a user can have the
// plugin enabled and its section expanded while the entire host pane is hidden.
// Reveal the host pane whenever this plugin is registered/rendered.
function revealContextPane() {
  try {
    var win = Zotero.getMainWindow && Zotero.getMainWindow();
    var pane = win && win.ZoteroContextPane;
    if (pane && pane.collapsed) pane.collapsed = false;
  } catch (e) {
    try {
      Zotero.debug("[PaperReadingAgent] revealContextPane: " + e);
    } catch (e2) {}
  }
}

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
    // chatgpt-specific (stateless OpenAI-compatible gateway, e.g. chat2api)
    chatgptEndpoint: g("chatgptEndpoint", "") || undefined, // base URL, default http://127.0.0.1:5005/v1
    chatgptToken: g("chatgptToken", "") || undefined, // access token; empty = read the chat2api token file
    chatgptModel: g("chatgptModel", "") || undefined, // gpt-5.6 | gpt-5 | gpt-4o | o3-mini | ...
    chatgptLastModel: g("chatgptLastModel", "") || undefined,
    // shared
    timeoutSec: parseInt(g("timeoutSec", 600), 10) || 600,
    webSearch: g("webSearch", true) !== false,
    // off by default: it widens what the agent (and the CLI's provider) can
    // read from one paper to every paper in the library
    libraryAccess: g("libraryAccess", false) === true,
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
  ".pra-wrap{display:flex;flex-direction:column;gap:13px;width:100%;max-width:100%;min-width:0;overflow-x:hidden;box-sizing:border-box;padding:13px 10px 18px;font:13.5px/1.78 -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei UI',sans-serif;color:var(--fill-primary,#1d2129);background:linear-gradient(180deg,var(--color-control,#fff) 0,var(--fill-quinary,rgba(0,0,0,.018)) 100%);}",
  ".pra-wrap.pra-wide{position:fixed!important;top:14px!important;right:14px!important;bottom:14px!important;left:auto!important;width:min(58%,1000px)!important;max-width:none!important;height:auto!important;z-index:2147483000!important;overflow-x:hidden!important;overflow-y:auto!important;padding:20px 24px 26px!important;border:1px solid var(--color-border,rgba(0,0,0,.16));border-radius:16px;background:var(--color-control,#fff)!important;box-shadow:0 16px 54px rgba(0,0,0,.28);}",
  ".pra-wide .pra-messages{max-height:none!important;overflow-y:visible!important;}",
  ".pra-wide .pra-thought-list{max-height:430px!important;}",
  ".pra-wide .pra-composer{position:sticky;bottom:0;z-index:6;box-shadow:0 -8px 22px var(--color-control,#fff);}",
  ".pra-topbar{position:sticky;top:0;z-index:30;display:flex;align-items:center;justify-content:flex-start;gap:8px;width:100%;max-width:100%;min-width:0;box-sizing:border-box;padding:6px 0;background:var(--color-control,#fff);box-shadow:0 7px 12px -12px rgba(0,0,0,.45);}",
  ".pra-version{flex:none;font-size:9.5px;color:var(--fill-tertiary,#9aa0a8);letter-spacing:.04em;user-select:none;white-space:nowrap;padding:0 2px;}",
  // health banner → subtle pill with a status dot
  ".pra-banner{display:inline-flex;align-items:center;gap:6px;align-self:flex-start;font-size:11px;padding:3px 10px;border-radius:999px;background:var(--fill-quinary,rgba(0,0,0,.035));max-width:100%;min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  ".pra-banner::before{content:'';width:7px;height:7px;border-radius:50%;background:currentColor;flex:none;}",
  ".pra-banner.ok{color:var(--accent-green,#2a9d4a);}.pra-banner.err{color:var(--accent-red,#d23b3b);}",
  ".pra-popout{flex:none;height:28px;padding:0 10px;border:1px solid var(--accent-blue30,rgba(64,114,229,.35));border-radius:8px;background:var(--accent-blue10,rgba(64,114,229,.08));color:var(--accent-blue,#245fbd);cursor:pointer;font:650 11px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei UI',sans-serif;}",
  ".pra-popout:hover{border-color:var(--accent-blue,#2563eb);background:var(--accent-blue10,rgba(64,114,229,.14));}",
  ".pra-notebook-tools{position:sticky;top:40px;z-index:29;display:flex;align-items:center;gap:6px;flex-wrap:wrap;width:100%;max-width:100%;min-width:0;box-sizing:border-box;padding:5px 0 7px;background:var(--color-control,#fff);}",
  ".pra-search{flex:1 1 170px;min-width:120px;height:30px;box-sizing:border-box;padding:4px 9px;border:1px solid var(--color-border,rgba(0,0,0,.15));border-radius:8px;background:var(--color-control,#fff);color:var(--fill-primary,#222);font:inherit;font-size:11.5px;outline:none;}",
  ".pra-search:focus{border-color:var(--accent-blue,#2563eb);box-shadow:0 0 0 2px var(--accent-blue10,rgba(64,114,229,.1));}",
  ".pra-view-select{height:30px;max-width:120px;padding:3px 7px;border:1px solid var(--color-border,rgba(0,0,0,.15));border-radius:8px;background:var(--color-control,#fff);color:var(--fill-primary,#222);font:inherit;font-size:11px;}",
  ".pra-tool-btn{height:30px;padding:0 8px;border:1px solid var(--color-border,rgba(0,0,0,.15));border-radius:8px;background:var(--color-control,#fff);color:var(--fill-secondary,#555);cursor:pointer;font:650 10.5px/1.2 inherit;}",
  ".pra-tool-btn:hover{border-color:var(--accent-blue,#2563eb);color:var(--accent-blue,#245fbd);}",
  ".pra-search-count{flex:0 0 auto;font-size:10px;color:var(--fill-tertiary,#888);white-space:nowrap;}",
  ".pra-search-results{display:none;flex:1 0 100%;max-height:230px;overflow:auto;box-sizing:border-box;padding:4px;border:1px solid var(--color-border,rgba(0,0,0,.11));border-radius:9px;background:var(--color-control,#fff);box-shadow:0 8px 18px rgba(0,0,0,.09);}",
  ".pra-search-results.show{display:flex;flex-direction:column;gap:2px;}",
  ".pra-search-result{display:flex;align-items:flex-start;gap:6px;width:100%;padding:6px 7px;border:0;border-radius:7px;background:transparent;color:var(--fill-primary,#222);text-align:left;cursor:pointer;font:inherit;font-size:10.5px;line-height:1.42;}",
  ".pra-search-result:hover,.pra-search-result.active{background:var(--accent-blue10,rgba(64,114,229,.09));}",
  ".pra-search-result-kind{flex:none;color:var(--accent-blue,#245fbd);font-weight:700;white-space:nowrap;}",
  ".pra-search-result-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  ".pra-storage-status{flex:0 0 auto;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:var(--fill-tertiary,#888);}",
  ".pra-storage-status.ok{color:var(--accent-green,#2a8f46);}.pra-storage-status.warn{color:var(--accent-orange,#b66a00);}.pra-storage-status.err{color:var(--accent-red,#c93636);}",
  ".pra-message-context{margin:7px 0 2px;padding:2px 7px;border-left:2px solid var(--accent-blue30,rgba(64,114,229,.3));font-size:10px;color:var(--fill-tertiary,#858b95);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
  ".pra-row.search-hit{border-radius:8px;background:var(--accent-yellow10,rgba(245,158,11,.08));}",
  // messages — user-select:text makes the transcript selectable/copyable. Zotero's
  // item-pane is a privileged XUL document whose default is -moz-user-select:none,
  // which content inherits; we must explicitly opt the message area back in (this
  // only changes selection behaviour, not layout/appearance).
  ".pra-messages{display:flex;flex-direction:column;gap:0;width:100%;max-width:100%;min-width:0;overflow-x:auto;overflow-y:auto;max-height:62vh;padding:4px 2px 18px;box-sizing:border-box;-moz-user-select:text;user-select:text;scrollbar-gutter:stable;}",
  ".pra-row{position:relative;display:flex;flex-direction:column;width:100%;max-width:100%;min-width:0;box-sizing:border-box;}.pra-row.user{justify-content:stretch;margin-top:22px;}.pra-row.assistant{justify-content:stretch;}",
  // Notebook layout: a question is a section heading and an answer is prose,
  // rather than two opposing chat bubbles.
  ".pra-bubble{word-break:break-word;box-sizing:border-box;}",
  ".pra-messages pre,.pra-messages .katex-display{max-width:100%;overflow-x:auto;overflow-y:hidden;}",
  ".pra-messages .katex{white-space:nowrap;display:inline-block;max-width:100%;overflow-x:auto;overflow-y:hidden;vertical-align:middle;scrollbar-width:thin;}",
  ".pra-messages .katex-display{margin:6px 0;padding:2px 0;max-width:100%;overflow-x:auto;overflow-y:hidden;}",
  ".pra-messages img{max-width:100%;height:auto;}",
  ".pra-messages table{display:block;max-width:100%;overflow-x:auto;}",
  ".pra-messages pre{max-width:100%;}",
  ".pra-messages blockquote{max-width:100%;}",
  ".pra-messages .pra-md{max-width:100%;min-width:0;}",
  ".pra-messages .pra-md *{max-width:100%;}",
  ".pra-messages code{white-space:pre-wrap;word-break:break-all;}",
  ".pra-bubble.user{position:relative;width:100%;max-width:none;padding:13px 14px 12px 16px;border-radius:4px 13px 13px 4px;border-left:4px solid var(--accent-blue,#2563eb);background:var(--accent-blue10,rgba(64,114,229,.07));color:var(--fill-primary,#1d2129);white-space:pre-wrap;font-size:14.5px;font-weight:680;line-height:1.58;box-shadow:none;}",
  ".pra-bubble.user::before{content:'问题';display:block;margin-bottom:5px;color:var(--accent-blue,#2563eb);font-size:10px;font-weight:750;letter-spacing:.12em;}",
  ".pra-bubble.assistant{max-width:100%;width:100%;padding:17px 11px 25px 16px;border-left:1px solid var(--color-border,rgba(0,0,0,.11));white-space:pre-wrap;background:transparent;}",
  ".pra-row.assistant.imported .pra-bubble.assistant::after{content:'旧对话 · 已导入为笔记';display:block;margin-top:13px;padding-top:8px;border-top:1px solid var(--color-border,rgba(0,0,0,.09));font-size:10px;color:var(--fill-tertiary,#888);letter-spacing:.03em;}",
  ".pra-verbatim{margin-top:18px;border:1px solid var(--color-border,rgba(0,0,0,.09));border-radius:10px;background:var(--fill-quinary,rgba(0,0,0,.022));}",
  ".pra-verbatim>summary{cursor:pointer;padding:7px 9px;font-size:10.5px;font-weight:650;color:var(--fill-secondary,#666);user-select:none;}",
  ".pra-verbatim-text{max-height:42vh;overflow:auto;margin:0;padding:10px;border-top:1px solid var(--color-border,rgba(0,0,0,.09));white-space:pre-wrap;font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--fill-secondary,#555);}",
  ".pra-bubble.assistant[data-model-label]::before{content:attr(data-model-label);display:block;margin:0 0 5px;font-size:10.5px;line-height:1.35;letter-spacing:.01em;color:var(--fill-tertiary,#8a8f98);white-space:normal;}",
  // blinking streaming caret
  ".pra-bubble.streaming::after{content:'\\2588';margin-left:1px;font-size:.9em;color:var(--accent-blue,#2563eb);animation:pra-blink 1.05s steps(1) infinite;}",
  "@keyframes pra-blink{50%{opacity:0;}}",
  // status line
  ".pra-status{display:flex;align-items:center;gap:6px;min-height:16px;font-size:11px;color:var(--fill-secondary,#888);}",
  // reading workflow: answer depth, one current card, and a compact parking lot
  ".pra-reading{display:flex;flex-direction:column;gap:7px;width:100%;max-width:100%;min-width:0;overflow-x:hidden;box-sizing:border-box;}",
  ".pra-thought-map{width:100%;max-width:100%;min-width:0;overflow:hidden;box-sizing:border-box;border:1px solid var(--color-border,rgba(0,0,0,.11));border-radius:14px;padding:10px 8px;background:var(--color-control,#fff);box-shadow:0 1px 7px rgba(0,0,0,.035);}",
  ".pra-thought-head{display:flex;justify-content:flex-start;align-items:center;gap:8px;font-size:11px;font-weight:750;letter-spacing:.04em;color:var(--fill-secondary,#555);margin:0 3px 8px;}",
  ".pra-thought-list{position:relative;max-height:340px;min-height:150px;width:100%;overflow-x:scroll;overflow-y:auto;direction:ltr;cursor:grab;overscroll-behavior:contain;scrollbar-gutter:stable;border-radius:10px;background:radial-gradient(circle at 1px 1px,var(--color-border,rgba(0,0,0,.09)) 1px,transparent 1.2px);background-size:16px 16px;}",
  ".pra-thought-list.dragging{cursor:grabbing;-moz-user-select:none;user-select:none;}",
  ".pra-mindmap-canvas{position:relative;min-height:150px;}",
  ".pra-mindmap-links{position:absolute;inset:0;overflow:visible;pointer-events:none;}",
  ".pra-mindmap-link{fill:none;stroke:var(--color-border,rgba(70,80,95,.28));stroke-width:1.5;}",
  ".pra-mindmap-link.active{stroke:var(--accent-blue,#2563eb);stroke-width:2.2;}",
  ".pra-map-node{position:absolute;box-sizing:border-box;width:168px;height:48px;padding:7px 10px;border:1px solid var(--color-border,rgba(0,0,0,.14));border-radius:11px;background:var(--color-control,#fff);color:var(--fill-primary,#222);box-shadow:0 2px 7px rgba(0,0,0,.055);text-align:left;cursor:pointer;font:inherit;font-size:11px;line-height:1.35;overflow:hidden;transition:border-color .13s,box-shadow .13s,transform .13s;}",
  ".pra-map-node:hover{border-color:var(--accent-blue30,rgba(64,114,229,.45));box-shadow:0 4px 12px rgba(0,0,0,.09);transform:translateY(-1px);}",
  ".pra-map-node.root{font-weight:720;border-left:4px solid var(--accent-blue,#2563eb);}",
  ".pra-map-node.branch{border-left:3px solid var(--accent-orange,#d97706);}",
  ".pra-map-node.active{border-color:var(--accent-blue,#2563eb);background:var(--accent-blue10,rgba(64,114,229,.1));color:var(--accent-blue,#245fbd);font-weight:700;box-shadow:0 0 0 2px var(--accent-blue10,rgba(64,114,229,.13));}",
  ".pra-map-node-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}",
  ".pra-origin-branches{display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-top:7px;padding-top:6px;border-top:1px dashed var(--color-border,rgba(0,0,0,.12));font-size:10.5px;color:var(--fill-secondary,#666);}",
  ".pra-origin-jump{border:1px solid var(--accent-orange30,rgba(217,119,6,.35));background:var(--accent-orange10,rgba(217,119,6,.08));color:var(--accent-orange,#b45309);border-radius:7px;padding:2px 7px;font:inherit;font-size:10.5px;cursor:pointer;max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  ".pra-origin-jump:hover{background:var(--accent-orange10,rgba(217,119,6,.18));}",
  ".pra-origin-bar{display:flex;align-items:center;gap:6px;margin:2px 0 8px;padding:6px 9px;border-radius:8px;background:var(--accent-orange10,rgba(217,119,6,.07));border-left:3px solid var(--accent-orange,#d97706);font-size:11px;color:var(--fill-secondary,#555);}",
  ".pra-origin-excerpt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  ".pra-map-actions{display:none;position:absolute;top:-14px;right:4px;gap:3px;z-index:5;}",
  ".pra-map-node:hover .pra-map-actions{display:flex;}",
  ".pra-map-act{border:1px solid var(--color-border,rgba(0,0,0,.16));background:var(--color-control,#fff);border-radius:6px;padding:1px 5px;font:inherit;font-size:9.5px;cursor:pointer;color:var(--fill-secondary,#555);}",
  ".pra-map-act:hover{color:var(--accent-blue,#2563eb);border-color:var(--accent-blue,#2563eb);}",
  ".pra-map-act.danger:hover{color:#dc2626;border-color:#dc2626;}",
  ".pra-map-node.dragging{opacity:.55;transform:scale(1.02);z-index:10;box-shadow:0 8px 22px rgba(0,0,0,.18);}",
  ".pra-map-node.drop-target{outline:2px dashed var(--accent-blue,#2563eb);outline-offset:2px;}",
  ".pra-map-node.renamed::after{content:'✏';position:absolute;right:4px;bottom:2px;font-size:8px;color:var(--fill-tertiary,#999);}",
  ".pra-message-edit{border:none;background:transparent;color:var(--fill-tertiary,#888);font-size:10px;cursor:pointer;padding:2px 4px;opacity:.55;transition:opacity .12s;}",
  ".pra-row:hover .pra-message-edit{opacity:1;}.pra-message-edit:hover{color:var(--accent-blue,#2563eb);opacity:1;}",
  ".pra-edit-area{width:100%;min-height:150px;box-sizing:border-box;border:1px solid var(--color-border,rgba(0,0,0,.22));border-radius:8px;padding:8px;font:12px/1.6 ui-monospace,Consolas,Menlo,monospace;background:var(--color-control,#fff);color:var(--fill-primary,#222);resize:vertical;}",
  ".pra-edit-bar{display:flex;gap:6px;margin-top:6px;}",
  ".pra-edit-note{font-size:10px;color:var(--fill-tertiary,#888);margin-top:4px;}",
  ".pra-empty-hint{padding:18px 12px;text-align:center;color:var(--fill-tertiary,#888);font-size:11.5px;border:1px dashed var(--color-border,rgba(0,0,0,.15));border-radius:10px;margin:8px 0;}",
  ".pra-breadcrumb{font-size:10.5px;color:var(--fill-secondary,#666);margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
  ".pra-message-branch{align-self:center;opacity:0;border:none;background:transparent;color:var(--fill-tertiary,#888);font-size:10px;cursor:pointer;padding:2px 4px;transition:opacity .12s;}",
  ".pra-row:hover .pra-message-branch{opacity:1;}.pra-message-branch:hover{color:var(--accent-blue,#2563eb);}",
  ".pra-modebar{display:flex;align-items:center;gap:5px;}",
  ".pra-mode-label{font-size:11px;color:var(--fill-secondary,#6b7280);margin-right:2px;}",
  ".pra-mode,.pra-mini{border:1px solid var(--color-border,rgba(0,0,0,.15));background:var(--color-control,#fff);color:var(--fill-secondary,#555);border-radius:8px;padding:3px 8px;font:inherit;font-size:11px;cursor:pointer;}",
  ".pra-mode.active{background:var(--accent-blue10,rgba(64,114,229,.12));border-color:var(--accent-blue,#2563eb);color:var(--accent-blue,#2563eb);font-weight:600;}",
  ".pra-current{display:none;border:1px solid var(--accent-blue30,rgba(64,114,229,.22));border-radius:14px;padding:11px 12px;background:var(--color-control,#fff);box-shadow:0 1px 6px rgba(0,0,0,.035);}",
  ".pra-current.show{display:block;}.pra-current-title{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--accent-blue,#2563eb);font-weight:700;}",
  ".pra-current-q{font-weight:600;margin-top:2px;}.pra-current-a{font-size:11.5px;color:var(--fill-secondary,#555);margin-top:4px;}",
  ".pra-origin{margin:9px 0 2px;padding:9px 10px;border-radius:9px;background:var(--fill-quinary,rgba(0,0,0,.035));border-left:3px solid var(--accent-orange,#d97706);}",
  ".pra-origin-label{font-size:9.5px;font-weight:750;letter-spacing:.09em;color:var(--accent-orange,#b45309);margin-bottom:3px;}",
  ".pra-origin-text{font-size:11.5px;line-height:1.55;color:var(--fill-secondary,#555);display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap;}",
  ".pra-current-actions{display:flex;gap:5px;margin-top:6px;flex-wrap:wrap;}",
  ".pra-anchor{border:none;background:transparent;color:var(--accent-blue,#2563eb);padding:0;font:inherit;font-size:11px;cursor:pointer;text-align:left;}",
  ".pra-parking{border-top:1px solid var(--color-border,rgba(0,0,0,.1));padding-top:5px;}",
  ".pra-parking-head{font-size:11px;color:var(--fill-secondary,#666);cursor:pointer;user-select:none;}",
  ".pra-parking-list{display:flex;flex-direction:column;gap:5px;margin-top:5px;}",
  ".pra-park-item{display:grid;grid-template-columns:auto 1fr auto auto;gap:5px;align-items:start;font-size:11px;}",
  ".pra-park-kind{color:var(--fill-tertiary,#888);white-space:nowrap;}.pra-park-q{word-break:break-word;}",
  // composer = a large card holding the textarea + a bottom bar with Send (codex/claude-code style)
  ".pra-composer{display:flex;flex-direction:column;gap:8px;border:1px solid var(--color-border,rgba(0,0,0,.16));border-radius:16px;background:var(--color-control,#fff);padding:11px 11px 9px 13px;transition:border-color .15s,box-shadow .15s;}",
  ".pra-composer:focus-within{border-color:var(--accent-blue,#2563eb);box-shadow:0 0 0 3px var(--accent-blue10,rgba(64,114,229,.15));}",
  ".pra-input{border:none;outline:none;background:transparent;resize:none;width:100%;min-height:30px;max-height:340px;padding:0;font:inherit;line-height:1.55;color:var(--fill-primary,#1d2129);}",
  ".pra-input::placeholder{color:var(--fill-tertiary,#9aa0a6);}",
  ".pra-input:disabled{opacity:.6;}",
  ".pra-bar{display:flex;justify-content:space-between;align-items:center;gap:6px;}",
  ".pra-park-actions{display:flex;gap:4px;flex-wrap:wrap;}",
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
  ".pra-md p{margin:0 0 11px;}.pra-md ul,.pra-md ol{margin:8px 0 12px;padding-left:23px;}.pra-md li{margin:3px 0 5px;}",
  ".pra-md h1,.pra-md h2,.pra-md h3,.pra-md h4{margin:22px 0 9px;font-weight:720;line-height:1.42;color:var(--fill-primary,#16191f);}",
  ".pra-md h1{font-size:1.28em;padding-bottom:6px;border-bottom:1px solid var(--color-border,rgba(0,0,0,.11));}.pra-md h2{font-size:1.17em;color:var(--accent-blue,#245fbd);}.pra-md h3{font-size:1.08em;}.pra-md h4{font-size:1em;}",
  ".pra-md pre{background:var(--fill-quinary,rgba(0,0,0,.05));border:1px solid var(--color-border,rgba(0,0,0,.08));padding:8px 10px;border-radius:9px;overflow-x:auto;margin:8px 0;}",
  ".pra-md code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em;}",
  ".pra-md :not(pre)>code{background:var(--fill-quinary,rgba(0,0,0,.06));padding:1.5px 5px;border-radius:5px;}",
  ".pra-md blockquote{margin:11px 0 13px;padding:7px 11px 7px 13px;border-left:3px solid var(--accent-blue30,rgba(64,114,229,.35));border-radius:0 8px 8px 0;background:var(--accent-blue10,rgba(64,114,229,.045));color:var(--fill-secondary,#555);}",
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
  ".pra-bubble,.pra-md{max-width:100%;min-width:0;box-sizing:border-box;}",
  ".pra-md .katex{font-size:1.08em;}",
  ".pra-md .katex-display{display:block;width:100%;max-width:100%;min-width:0;box-sizing:border-box;margin:13px 0 15px;overflow-x:auto;overflow-y:hidden;padding:10px 12px;border-radius:10px;border:1px solid var(--color-border,rgba(0,0,0,.075));background:var(--fill-quinary,rgba(0,0,0,.022));text-align:center!important;direction:ltr;}",
  ".pra-md .katex-display>.katex{display:inline-block!important;width:max-content;max-width:none;font-size:1.04em;text-align:left!important;}",
].join("");

// Inject KaTeX's stylesheet + our chat CSS into the panel's OWN subtree (wrap).
// Putting them in our HTML subtree (NOT doc.head — which does not reliably apply
// in the Zotero item-pane document) is what makes the styles take effect.
function injectStyles(doc, wrap) {
  try {
    if (ROOT_URI) {
      var link = doc.createElement("link");
      link.rel = "stylesheet";
      // chrome:// beats jar: here — the KaTeX stylesheet references its fonts
      // via relative urls (fonts/KaTeX_*.woff2); under a jar: root those
      // font loads fail in Zotero and every formula renders as an empty box.
      // The chrome package is registered in bootstrap.js (__addonRef__).
      link.href = "chrome://paper-reading-agent/content/vendor/katex.min.css";
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
// Scale down any math that overflows its container so it always fits the
// panel width (Firefox supports the zoom property, which also reflows —
// unlike transform, it leaves no blank space below).
function fitMath(root) {
  if (!root) return;
  var items = root.querySelectorAll(".katex-display .katex, .katex-display");
  for (var i = 0; i < items.length; i++) {
    var el = items[i];
    var parent = el.parentElement;
    if (!parent || !parent.isConnected) continue;
    if (el.scrollWidth > parent.clientWidth + 4 && el.scrollWidth > 40) {
      var scale = Math.max(0.35, parent.clientWidth / el.scrollWidth);
      el.style.zoom = scale.toFixed(3);
    } else if (el.style.zoom) {
      el.style.zoom = ""; // container widened (wide mode) — restore full size
    }
  }
}

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

function paintStorageStatus(session, text, kind, title) {
  var view = session && session.view;
  var status = view && view.ui && view.ui.storageStatus;
  if (!status) return;
  status.textContent = text || "";
  status.classList.remove("ok", "warn", "err");
  if (kind) status.classList.add(kind);
  status.setAttribute("title", title || text || "");
}

function paintLoadedStoreNotice(session) {
  var notice = session && session.conv && session.conv.__storeNotice;
  if (!notice) {
    paintStorageStatus(
      session,
      "本地存储就绪",
      "ok",
      PRAStore.convPath ? PRAStore.convPath(session.key) : "本地会话存储正常",
    );
    return;
  }
  if (notice.type === "recovered") {
    paintStorageStatus(
      session,
      "已从备份恢复",
      "warn",
      "主文件读取失败，已使用备份：" +
        (notice.backupPath || "") +
        (notice.mainError ? "\n" + notice.mainError : ""),
    );
    return;
  }
  paintStorageStatus(
    session,
    "存储异常 · 已阻止覆盖",
    "err",
    [notice.mainError, notice.backupError].filter(Boolean).join("\n"),
  );
}

function saveWorkflow(session) {
  if (!session || !session.conv) return Promise.resolve(false);
  paintStorageStatus(session, "保存中…", null, "正在安全写入本地会话文件");
  return PRAStore.save(session.conv)
    .then(function () {
      paintStorageStatus(
        session,
        "已保存",
        "ok",
        PRAStore.convPath ? PRAStore.convPath(session.key) : "本地保存完成",
      );
      return true;
    })
    .catch(function (error) {
      var message = String(error && error.message ? error.message : error);
      paintStorageStatus(session, "保存失败", "err", message);
      try {
        Zotero.debug("[PaperReadingAgent] store.save failed: " + message);
      } catch (e) {}
      return false;
    });
}

var DRAFT_SAVE_DELAY_MS = 300;

function composerDraftContext(session) {
  var current =
    session && session.conv ? PRAReading.activeThread(session.conv) : null;
  return {
    lineId: current ? current.id : null,
    branchNext: !!(session && session.branchNext),
    branchOrigin: (session && session.branchOrigin) || "",
    branchOriginRole: (session && session.branchOriginRole) || null,
    nextAnchor: (session && session.nextAnchor) || null,
  };
}

function reportDraftSaveError(session, error) {
  try {
    Zotero.debug("[PaperReadingAgent] composer draft save failed: " + error);
  } catch (e) {}
  var view = session && session.view;
  if (view && view.ui && view.ui.status) {
    view.ui.status.textContent =
      "⚠ 草稿保存失败：" +
      String(error && error.message ? error.message : error);
  }
  paintStorageStatus(
    session,
    "草稿保存失败",
    "err",
    String(error && error.message ? error.message : error),
  );
}

function flushComposerDraft(session) {
  if (!session || !session.conv) return Promise.resolve();
  if (session.draftTimer) {
    clearTimeout(session.draftTimer);
    session.draftTimer = 0;
  }
  if (!session.draftDirty) return Promise.resolve();
  session.draftDirty = false;
  paintStorageStatus(session, "保存草稿…", null, "正在保存未发送的输入");
  return PRAStore.save(session.conv)
    .then(function () {
      paintStorageStatus(session, "草稿已保存", "ok", "未发送的输入已保存");
    })
    .catch(function (error) {
      session.draftDirty = true;
      reportDraftSaveError(session, error);
    });
}

function rememberComposerDraft(session, text) {
  if (!session || !session.conv) return false;
  var changed = PRAComposerDraft.setComposerDraft(
    session.conv,
    text,
    composerDraftContext(session),
  );
  if (!changed) return false;
  session.draftDirty = true;
  if (session.draftTimer) clearTimeout(session.draftTimer);
  session.draftTimer = setTimeout(function () {
    session.draftTimer = 0;
    flushComposerDraft(session);
  }, DRAFT_SAVE_DELAY_MS);
  return true;
}

function clearAcceptedComposerDraft(session, submittedText) {
  if (!session || !session.conv) return false;
  // The image write before startTurn is asynchronous. If the user has already
  // begun another draft in that short interval, never clear the newer text.
  if (
    !PRAComposerDraft.clearComposerDraftIfMatches(session.conv, submittedText)
  )
    return false;
  session.draftDirty = true;
  flushComposerDraft(session);
  return true;
}

function restoreComposerDraft(session) {
  if (!session || !session.conv || !session.view) return null;
  var draft = PRAComposerDraft.getComposerDraft(session.conv);
  if (!draft) return null;

  var state = PRAReading.ensure(session.conv);
  if (
    draft.lineId &&
    state.activeId !== draft.lineId &&
    state.threads.some(function (thread) {
      return thread && thread.id === draft.lineId;
    })
  ) {
    PRAReading.switchThread(session.conv, draft.lineId);
  }
  session.branchNext = !!draft.branchNext;
  session.branchOrigin = draft.branchOrigin || "";
  session.branchOriginRole = draft.branchOriginRole || null;
  session.nextAnchor = draft.nextAnchor || null;

  var input = session.view.ui.input;
  input.value = draft.text;
  input.style.height = "auto";
  input.style.height = Math.min(340, input.scrollHeight) + "px";
  session.view.ui.status.textContent = "已恢复未发送的草稿。";
  return draft;
}

function renderWorkflow(session) {
  var v = session.view;
  if (!v || !v.ui || !session.conv) return;
  var ui = v.ui;
  var doc = v.doc;
  var state = PRAReading.ensure(session.conv);
  var currentThread = PRAReading.activeThread(session.conv);

  ui.thoughtList.textContent = "";
  ui.thoughtTitle.textContent =
    "思维导图 · 纵向主干与分支（" + state.threads.length + " 个节点）";
  var mapCollapsed = !!session.mapCollapsed;
  ui.thoughtMap.style.display =
    state.threads.length && !mapCollapsed ? "block" : "none";
  if (ui.toggleMap) {
    ui.toggleMap.textContent = mapCollapsed ? "展开导图" : "收起导图";
    ui.toggleMap.setAttribute(
      "title",
      mapCollapsed ? "展开思维导图" : "收起思维导图，为正文留出更多空间",
    );
  }
  var layout = PRAReading.mindMapLayout(session.conv);
  var NODE_W = 168;
  var NODE_H = 48;
  var X_STEP = 184;
  var Y_STEP = 76;
  var PAD = 18;
  var maxColumn = 0;
  var maxRow = 0;
  var positions = Object.create(null);
  layout.nodes.forEach(function (position) {
    maxColumn = Math.max(maxColumn, position.column);
    maxRow = Math.max(maxRow, position.row);
    positions[position.thread.id] = {
      x: PAD + position.row * X_STEP,
      y: PAD + position.column * Y_STEP,
      position: position,
    };
  });
  var canvasWidth = Math.max(360, PAD * 2 + maxRow * X_STEP + NODE_W);
  var canvasHeight = Math.max(150, PAD * 2 + maxColumn * Y_STEP + NODE_H);
  var canvas = el(doc, "div");
  canvas.className = "pra-mindmap-canvas";
  canvas.style.width = canvasWidth + "px";
  canvas.style.height = canvasHeight + "px";
  var ns = "http://www.w3.org/2000/svg";
  var svg = doc.createElementNS(ns, "svg");
  svg.setAttribute("class", "pra-mindmap-links");
  svg.setAttribute("width", String(canvasWidth));
  svg.setAttribute("height", String(canvasHeight));
  svg.setAttribute("viewBox", "0 0 " + canvasWidth + " " + canvasHeight);
  var activePath = new Set(
    PRAReading.ancestry(session.conv, state.activeId).map(function (thread) {
      return thread.id;
    }),
  );
  layout.edges.forEach(function (edge) {
    var from = positions[edge.from];
    var to = positions[edge.to];
    if (!from || !to) return;
    var x1 = from.x + NODE_W / 2;
    var y1 = from.y + NODE_H;
    var x2 = to.x + NODE_W / 2;
    var y2 = to.y;
    var bend = Math.max(22, (y2 - y1) * 0.48);
    var path = doc.createElementNS(ns, "path");
    path.setAttribute(
      "d",
      "M " +
        x1 +
        " " +
        y1 +
        " C " +
        x1 +
        " " +
        (y1 + bend) +
        ", " +
        x2 +
        " " +
        (y2 - bend) +
        ", " +
        x2 +
        " " +
        y2,
    );
    path.setAttribute(
      "class",
      "pra-mindmap-link" +
        (activePath.has(edge.from) && activePath.has(edge.to) ? " active" : ""),
    );
    svg.appendChild(path);
  });
  canvas.appendChild(svg);
  layout.nodes.forEach(function (position) {
    var thread = position.thread;
    var point = positions[thread.id];
    var children = layout.edges.filter(function (edge) {
      return edge.from === thread.id;
    }).length;
    var node = el(doc, "div");
    node.className =
      "pra-map-node" +
      (position.column === 0 ? " root" : "") +
      (children > 1 ? " branch" : "") +
      (thread.id === state.activeId ? " active" : "") +
      (thread.title && thread.title !== thread.rootQuestion ? " renamed" : "");
    node.style.left = point.x + "px";
    node.style.top = point.y + "px";
    node.setAttribute("aria-level", String(position.column + 1));
    var label = el(doc, "span", null, thread.title || thread.rootQuestion);
    label.className = "pra-map-node-title";
    node.appendChild(label);
    node.setAttribute(
      "title",
      "原始问题：" +
        (thread.rootQuestion || thread.title || "—") +
        (thread.anchor && thread.anchor.page
          ? "\n锚定：p." + thread.anchor.page
          : "") +
        (thread.summary ? "\n\n摘要：" + thread.summary : "") +
        "\n\n拖拽可调整层级：拖到另一节点上=变为其子节点，拖到空白=回到主干。锚定原文的部分（引用/出处）不会随拖拽改变。",
    );

    // ── node actions: insert / retitle / summary / delete ──
    function promptText(title, initial) {
      try {
        var win = doc.defaultView;
        if (!win || typeof win.prompt !== "function") return null;
        return win.prompt(title, initial == null ? "" : String(initial));
      } catch (e) {
        return null;
      }
    }
    function confirmAction(text) {
      try {
        var win = doc.defaultView;
        if (!win || typeof win.confirm !== "function") return true;
        return win.confirm(text);
      } catch (e) {
        return true;
      }
    }
    var actions = el(doc, "div");
    actions.className = "pra-map-actions";
    function act(labelText, tip, handler, danger) {
      var b = el(doc, "button", null, labelText);
      b.className = "pra-map-act" + (danger ? " danger" : "");
      b.setAttribute("title", tip);
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        if (isBusy(session)) return;
        handler();
      });
      actions.appendChild(b);
    }
    act("➕", "在此节点下插入一个新问题节点", function () {
      var q = promptText("新问题节点（挂在「" + (thread.title || thread.rootQuestion) + "」之下）", "");
      if (q == null) return;
      var created = PRAReading.insertThread(session.conv, q, thread.id);
      if (!created) return;
      saveWorkflow(session);
      renderActiveMessages(session);
      renderWorkflow(session);
      ui.input.placeholder = "向这个新问题提问…";
      ui.input.focus();
    });
    act("✏️", "改写标题（原始问题仍保留在提示与导出中）", function () {
      var v = promptText("改写节点标题（原始问题不变）", thread.title || thread.rootQuestion);
      if (v == null) return;
      if (PRAReading.updateThreadTitle(session.conv, thread.id, v)) {
        saveWorkflow(session);
        renderWorkflow(session);
      }
    });
    act("📝", "改写摘要（锚定页码与引文不受影响）", function () {
      var v = promptText("改写摘要", thread.summary || "");
      if (v == null) return;
      if (PRAReading.updateThreadSummary(session.conv, thread.id, v)) {
        saveWorkflow(session);
        renderWorkflow(session);
      }
    });
    act("🗑", "删除此节点及其全部分支（消息仍保留在对话中）", function () {
      var n = 1 + layout.edges.filter(function (edge) {
        return edge.from === thread.id;
      }).length;
      if (!confirmAction("删除「" + (thread.title || thread.rootQuestion) + "」及其 " + n + " 个子分支？\n删除后消息仍保留在对话记录中，可重新组织。")) return;
      PRAReading.removeThread(session.conv, thread.id);
      saveWorkflow(session);
      renderActiveMessages(session);
      renderWorkflow(session);
    });
    node.appendChild(actions);

    // ── drag to reparent: onto a node → its child; onto empty canvas → root ──
    var draggingThreadId = thread.id;
    var drag = null;
    var suppressClick = false; // set after a real drag ends, cleared on next click
    node.addEventListener("pointerdown", function (e) {
      if (isBusy(session)) return;
      if (e.button !== 0) return;
      if (e.target.closest(".pra-map-act")) return;
      drag = {
        startX: e.clientX,
        startY: e.clientY,
        origLeft: point.x,
        origTop: point.y,
        moved: false,
      };
      var onMove = function (ev) {
        if (!drag) return;
        var dx = ev.clientX - drag.startX;
        var dy = ev.clientY - drag.startY;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 5) {
          drag.moved = true;
          node.classList.add("dragging");
        }
        if (!drag.moved) return;
        node.style.left = drag.origLeft + dx + "px";
        node.style.top = drag.origTop + dy + "px";
        // highlight the node we would drop onto
        var target = dropTargetAt(ev.clientX, ev.clientY);
        canvas.querySelectorAll(".pra-map-node.drop-target").forEach(function (n) {
          n.classList.remove("drop-target");
        });
        if (target && target.dataset.threadId !== draggingThreadId) {
          target.classList.add("drop-target");
        }
      };
      var onUp = function (ev) {
        if (typeof document.removeEventListener === "function") {
          document.removeEventListener("pointermove", onMove);
          document.removeEventListener("pointerup", onUp);
        }
        if (!drag) return;
        var wasDrag = drag.moved;
        drag = null;
        node.classList.remove("dragging");
        canvas.querySelectorAll(".pra-map-node.drop-target").forEach(function (n) {
          n.classList.remove("drop-target");
        });
        if (!wasDrag) return; // plain clicks are handled by the click listener
        suppressClick = true;
        var target = dropTargetAt(ev.clientX, ev.clientY);
        var targetId = target ? target.dataset.threadId : null;
        if (targetId && targetId !== thread.id) {
          if (PRAReading.isDescendant(session.conv, thread.id, targetId)) return;
          if (PRAReading.reparentThread(session.conv, thread.id, targetId)) {
            saveWorkflow(session);
            renderWorkflow(session);
          }
        } else if (!targetId && thread.parentId) {
          // dropped on empty canvas → promote to a root node
          if (PRAReading.reparentThread(session.conv, thread.id, null)) {
            saveWorkflow(session);
            renderWorkflow(session);
          }
        }
      };
      if (typeof document.addEventListener === "function") {
        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
      }
      // NOTE: deliberately no preventDefault() here — Firefox needs the
      // synthetic click to fire so node switching stays reliable. The click
      // handler below ignores clicks that ended a drag.
    });
    node.addEventListener("click", function (e) {
      if (suppressClick) {
        suppressClick = false; // the click that concludes a drag
        return;
      }
      drag = null;
      if (isBusy(session)) return;
      if (e.target.closest(".pra-map-act")) return;
      if (thread.id === state.activeId) return;
      PRAReading.switchThread(session.conv, thread.id);
      session.branchNext = false;
      saveWorkflow(session);
      renderActiveMessages(session);
      renderWorkflow(session);
      ui.input.placeholder = "继续这条思路…";
      ui.input.focus();
    });
    node.setAttribute("data-thread-id", thread.id);
    canvas.appendChild(node);
  });
  function dropTargetAt(clientX, clientY) {
    var els = canvas.querySelectorAll(".pra-map-node");
    for (var i = 0; i < els.length; i++) {
      var n = els[i];
      if (n.classList.contains("dragging")) continue;
      var r = n.getBoundingClientRect();
      if (
        clientX >= r.left &&
        clientX <= r.right &&
        clientY >= r.top &&
        clientY <= r.bottom
      ) {
        return n;
      }
    }
    return null;
  }
  ui.thoughtList.appendChild(canvas);
  var activePoint = positions[state.activeId];
  if (activePoint) {
    ui.thoughtList.scrollLeft = Math.max(
      0,
      activePoint.x - Math.max(0, (ui.thoughtList.clientWidth - NODE_W) / 2),
    );
    ui.thoughtList.scrollTop = Math.max(0, activePoint.y - 54);
  }

  ui.current.textContent = "";
  if (currentThread) {
    ui.current.classList.add("show");
    var path = PRAReading.ancestry(session.conv, currentThread.id);
    var crumb = el(
      doc,
      "div",
      null,
      path
        .map(function (thread) {
          return thread.title;
        })
        .join(" › "),
    );
    crumb.className = "pra-breadcrumb";
    var title = el(doc, "div", null, "当前思维链");
    title.className = "pra-current-title";
    var q = el(
      doc,
      "div",
      null,
      currentThread.lastQuestion || currentThread.rootQuestion || "图片问题",
    );
    q.className = "pra-current-q";
    ui.current.append(crumb, title, q);
    if (currentThread.originExcerpt) {
      var origin = el(doc, "div");
      origin.className = "pra-origin";
      var originLabel = el(doc, "div", null, "由上一段文字引出");
      originLabel.className = "pra-origin-label";
      var originText = el(doc, "div", null, currentThread.originExcerpt);
      originText.className = "pra-origin-text";
      origin.append(originLabel, originText);
      ui.current.appendChild(origin);
    }
    if (currentThread.anchor && currentThread.anchor.page) {
      var anchor = el(
        doc,
        "button",
        null,
        "📍 PDF 第 " + currentThread.anchor.page + " 页",
      );
      anchor.className = "pra-anchor";
      anchor.addEventListener("click", function () {
        navigateToReference(
          v.attachmentID,
          currentThread.anchor.page,
          currentThread.anchor.quote || "",
        );
      });
      ui.current.appendChild(anchor);
    }
    if (currentThread.summary) {
      var answer = el(doc, "div", null, "上次停在：" + currentThread.summary);
      answer.className = "pra-current-a";
      ui.current.appendChild(answer);
    }
    var actions = el(doc, "div");
    actions.className = "pra-current-actions";
    var branch = el(doc, "button", null, "从这里分叉");
    branch.className = "pra-mini";
    branch.setAttribute(
      "title",
      "下一条消息将建立独立支线，并继承当前思路的断点",
    );
    branch.setAttribute("title", "从当前分支的最近断点建立子分支");
    branch.addEventListener("click", function () {
      if (isBusy(session)) return;
      session.branchNext = true;
      session.branchOrigin =
        currentThread.summary || currentThread.lastQuestion || "";
      session.branchOriginRole = "checkpoint";
      ui.input.value = "";
      ui.input.placeholder = "输入新支线的起点…";
      ui.input.focus();
    });
    var pause = el(doc, "button", null, "暂时搁置");
    pause.className = "pra-mini";
    pause.addEventListener("click", function () {
      if (isBusy(session)) return;
      PRAReading.pauseActive(session.conv);
      state.activeId = null;
      session.branchNext = false;
      ui.input.value = "";
      ui.input.placeholder = "输入一个新问题，或从思维地图恢复旧支线…";
      saveWorkflow(session);
      renderActiveMessages(session);
      renderWorkflow(session);
      ui.input.focus();
    });
    actions.append(branch, pause);
    ui.current.appendChild(actions);
  } else {
    ui.current.classList.remove("show");
  }

  ui.parkingList.textContent = "";
  var parked = state.parkingLot || [];
  ui.parkingHead.textContent = "问题停车场（" + parked.length + "）";
  ui.parking.style.display = parked.length ? "block" : "none";
  parked.forEach(function (item) {
    var row = el(doc, "div");
    row.className = "pra-park-item";
    var kind = el(
      doc,
      "span",
      null,
      item.category === "branch" ? "旁支" : "稍后",
    );
    kind.className = "pra-park-kind";
    var text = el(doc, "span", null, item.question);
    text.className = "pra-park-q";
    var ask = el(doc, "button", null, "提问");
    ask.className = "pra-mini";
    ask.addEventListener("click", function () {
      var picked = PRAReading.takeParked(session.conv, item.id);
      if (!picked) return;
      if (picked.parentId)
        PRAReading.switchThread(session.conv, picked.parentId);
      ui.input.value = picked.question;
      session.nextAnchor = picked.anchor || null;
      session.branchNext = !!picked.parentId;
      ui.input.dispatchEvent(new doc.defaultView.Event("input"));
      ui.input.focus();
      saveWorkflow(session);
      renderActiveMessages(session);
      renderWorkflow(session);
    });
    var remove = el(doc, "button", null, "×");
    remove.className = "pra-mini";
    remove.setAttribute("title", "删除");
    remove.addEventListener("click", function () {
      PRAReading.removeParked(session.conv, item.id);
      saveWorkflow(session);
      renderWorkflow(session);
    });
    row.append(kind, text, ask, remove);
    ui.parkingList.appendChild(row);
  });
}

function renderMessage(doc, container, msg, attachmentID, onBranch, meta) {
  var row = el(doc, "div");
  row.className =
    "pra-row " +
    (msg.role === "user" ? "user" : "assistant") +
    (msg.imported ? " imported" : "") +
    (meta && meta.searchHit ? " search-hit" : "");
  if (meta && typeof meta.messageIndex === "number") {
    row.setAttribute("data-message-index", String(meta.messageIndex));
  }
  if (meta && meta.threadTitle) {
    var context = el(
      doc,
      "div",
      null,
      (meta.threadId || "") + " · " + meta.threadTitle,
    );
    context.className = "pra-message-context";
    row.appendChild(context);
  }
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
    if (msg.verbatimContent) {
      var details = el(doc, "details");
      details.className = "pra-verbatim";
      var detailsTitle = el(doc, "summary", null, "原始全文（逐字保存）");
      var verbatim = el(doc, "pre", null, msg.verbatimContent);
      verbatim.className = "pra-verbatim-text";
      details.append(detailsTitle, verbatim);
      bubble.appendChild(details);
    }
  } else {
    bubble.textContent = msg.content || "";
  }
  row.appendChild(bubble);
  if (onBranch && msg && msg.content) {
    var branch = el(doc, "button", null, "由此追问");
    branch.className = "pra-message-branch";
    branch.setAttribute("title", "基于这条消息继续当前会话");
    branch.addEventListener("click", function () {
      var selected = "";
      try {
        selected = String(doc.defaultView.getSelection() || "").trim();
      } catch (e) {}
      onBranch(msg, selected);
    });
    branch.setAttribute(
      "title",
      "先选中触发你思考的具体文字；追问会记录出处并继续当前 AI 上下文",
    );
    row.appendChild(branch);
  }
  // AI 回答可作为笔记编辑：原始输出自动备份到「原始全文」
  if (msg.role === "assistant" && meta && meta.onEditMessage) {
    var editBtn = el(doc, "button", null, "✏️ 编辑");
    editBtn.className = "pra-message-edit";
    editBtn.setAttribute("title", "像笔记一样改写这条回答（原始 AI 输出自动保存）");
    editBtn.addEventListener("click", function () {
      meta.onEditMessage(row, bubble, msg);
    });
    row.appendChild(editBtn);
  }
  // branches that grew out of THIS message's text: clickable chips
  if (meta && meta.originThreads && meta.originThreads.length) {
    var originWrap = el(doc, "div");
    originWrap.className = "pra-origin-branches";
    originWrap.appendChild(el(doc, "span", null, "💡 由这段文字引出："));
    meta.originThreads.forEach(function (t) {
      var chip = el(doc, "button", null, t.title || t.id || "分支");
      chip.className = "pra-origin-jump";
      chip.setAttribute(
        "title",
        "跳转到从这个位置长出的分支" +
          (t.originExcerpt ? "：" + t.originExcerpt : ""),
      );
      chip.addEventListener("click", function () {
        if (meta.onJumpToBranch) meta.onJumpToBranch(t.id);
      });
      originWrap.appendChild(chip);
    });
    row.appendChild(originWrap);
  }
  container.appendChild(row);
  return bubble;
}

function notebookViewState(conv) {
  var reading = PRAReading.ensure(conv);
  if (!reading.ui || typeof reading.ui !== "object") reading.ui = {};
  if (
    reading.ui.viewMode !== "path" &&
    reading.ui.viewMode !== "node" &&
    reading.ui.viewMode !== "all"
  ) {
    reading.ui.viewMode = "path";
  }
  if (typeof reading.ui.mapCollapsed !== "boolean")
    reading.ui.mapCollapsed = false;
  return reading.ui;
}

function messageLineId(message) {
  return message && (message.lineId || message.thoughtId);
}

function scrollToRenderedMessage(session, messageIndex) {
  var view = session && session.view;
  if (!view || !view.ui || typeof messageIndex !== "number") return;
  if (messageIndex < 0) {
    view.ui.messages.scrollTop = 0;
    return;
  }
  var row = view.ui.messages.querySelector(
    '.pra-row[data-message-index="' + messageIndex + '"]',
  );
  if (!row) return;
  if (view.ui.wrap.classList.contains("pra-wide") && row.scrollIntoView) {
    row.scrollIntoView({ block: "center", behavior: "smooth" });
  } else {
    view.ui.messages.scrollTop = Math.max(
      0,
      row.offsetTop - Math.max(24, view.ui.messages.clientHeight * 0.24),
    );
  }
}

function renderActiveMessages(session, options) {
  options = options || {};
  var v = session && session.view;
  if (!v || !session.conv) return null;
  var previousScrollTop = v.ui.messages.scrollTop;
  if (session.lastRenderedViewMode) {
    session.messageScroll[session.lastRenderedViewMode] = previousScrollTop;
  }
  v.ui.messages.textContent = "";

  var viewState = notebookViewState(session.conv);
  var mode = session.viewMode || viewState.viewMode || "path";
  session.viewMode = mode;
  var activeChanged =
    !!session.lastRenderedActiveId &&
    session.lastRenderedActiveId !== PRAReading.ensure(session.conv).activeId;
  if (v.ui.viewSelect) v.ui.viewSelect.value = mode;

  var state = PRAReading.ensure(session.conv);
  var threads = Object.create(null);
  state.threads.forEach(function (thread) {
    if (thread && thread.id) threads[thread.id] = thread;
  });
  var globalIndices = new Map();
  (session.conv.messages || []).forEach(function (message, index) {
    globalIndices.set(message, index);
  });
  var hitIndices = Object.create(null);
  (session.searchHits || []).forEach(function (hit) {
    if (hit && hit.messageIndex >= 0) hitIndices[hit.messageIndex] = true;
  });

  // ── requirement: mark the exact passages that spawned later branches ──
  // For every message, find the threads whose originExcerpt matches a run of
  // that message's text. Those become clickable "由此引出" chips under the
  // message, jumping back to the branch that grew out of that passage.
  function normText(s) {
    return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  }
  var originByMessage = new Map();
  (session.conv.messages || []).forEach(function (message, index) {
    if (!message || !message.content) return;
    var base = normText(message.content);
    if (!base) return;
    state.threads.forEach(function (thread) {
      if (!thread || !thread.originExcerpt) return;
      var excerpt = normText(thread.originExcerpt);
      if (!excerpt || base.indexOf(excerpt) < 0) return;
      if (!originByMessage.has(index)) originByMessage.set(index, []);
      originByMessage.get(index).push(thread);
    });
  });

  // ── "源起" bar: the active branch shows where its question came from ──
  var activeThreadForBar = PRAReading.activeThread(session.conv);
  if (activeThreadForBar && activeThreadForBar.originExcerpt) {
    var srcIndex = -1;
    var srcExcerpt = normText(activeThreadForBar.originExcerpt);
    (session.conv.messages || []).forEach(function (m, i) {
      if (srcIndex >= 0 || !m || !m.content) return;
      if (normText(m.content).indexOf(srcExcerpt) >= 0) srcIndex = i;
    });
    if (srcIndex >= 0) {
      var bar = el(v.doc, "div");
      bar.className = "pra-origin-bar";
      bar.appendChild(el(v.doc, "span", null, "源起："));
      var excerpt = el(v.doc, "span", null, activeThreadForBar.originExcerpt);
      excerpt.className = "pra-origin-excerpt";
      excerpt.setAttribute(
        "title",
        "触发这个问题的原文摘录（保留自提问时刻，不可编辑）",
      );
      bar.appendChild(excerpt);
      var back = el(v.doc, "button", null, "回到原文 ↩");
      back.className = "pra-anchor";
      back.addEventListener("click", function () {
        session.viewMode = "all";
        notebookViewState(session.conv).viewMode = "all";
        renderActiveMessages(session, { targetMessageIndex: srcIndex });
      });
      bar.appendChild(back);
      v.ui.messages.appendChild(bar);
    }
  }

  var lastBubble = null;
  var lastContextLine = null;
  var hasRenderedMessage = false;
  PRANotebook.messagesForView(session.conv, mode).forEach(function (message) {
    try {
      var lineId = messageLineId(message);
      var thread = threads[lineId];
      var messageIndex = globalIndices.get(message);
      var showContext = mode !== "node" && lineId !== lastContextLine;
      if (showContext) lastContextLine = lineId;
      var canFollowFromMessage =
        !!lineId && lineId === state.activeId && !isBusy(session);
      lastBubble = renderMessage(
        v.doc,
        v.ui.messages,
        message,
        v.attachmentID,
        canFollowFromMessage
          ? function (origin, selectedText) {
              if (isBusy(session)) return;
              // A passage-level follow-up creates a new visible checkpoint but
              // inherits the current thoughtId/backend session. The explicit
              // "从这里分叉" card action remains the isolated-session command.
              session.branchNext = false;
              session.branchOrigin = selectedText || origin.content || "";
              session.branchOriginRole = origin.role || null;
              v.ui.input.value = "";
              v.ui.input.placeholder = "基于选中文字继续追问…";
              rememberComposerDraft(session, "");
              v.ui.input.focus();
            }
          : null,
        {
          messageIndex: messageIndex,
          searchHit: !!hitIndices[messageIndex],
          threadId: showContext ? lineId : null,
          threadTitle:
            showContext && thread
              ? thread.title || thread.rootQuestion || lineId
              : null,
          originThreads: originByMessage.get(messageIndex),
          onJumpToBranch: function (threadId) {
            if (isBusy(session)) return;
            PRAReading.switchThread(session.conv, threadId);
            session.branchNext = false;
            saveWorkflow(session);
            renderActiveMessages(session);
            renderWorkflow(session);
          },
          onEditMessage: function (rowEl, bubbleEl, message) {
            if (isBusy(session)) return;
            var editor = el(v.doc, "textarea");
            editor.className = "pra-edit-area";
            editor.value = String(message.content || "");
            editor.spellcheck = false;
            bubbleEl.textContent = "";
            bubbleEl.appendChild(editor);
            var bar = el(v.doc, "div");
            bar.className = "pra-edit-bar";
            var save = el(v.doc, "button", null, "保存");
            save.className = "pra-mini";
            var cancel = el(v.doc, "button", null, "取消");
            cancel.className = "pra-mini";
            bar.appendChild(save);
            bar.appendChild(cancel);
            bubbleEl.appendChild(bar);
            var note = el(
              v.doc,
              "div",
              null,
              "编辑前的原始 AI 输出会自动保存在「原始全文」中；保存后重新校验引用页码。",
            );
            note.className = "pra-edit-note";
            bubbleEl.appendChild(note);
            editor.focus();
            save.addEventListener("click", async function () {
              var next = String(editor.value || "");
              var orig = String(message.content || "");
              if (next !== orig && !message.verbatimContent) {
                message.verbatimContent = orig;
              }
              message.content = next;
              // re-verify citations against the page index if available
              try {
                var pages = session.ctx && session.ctx.pageTextPages;
                if (
                  (!Array.isArray(pages) || !pages.length) &&
                  session.ctx &&
                  session.ctx.pageTextPath
                ) {
                  pages = await loadPdfTextIndexPages(session.ctx.pageTextPath);
                  session.ctx.pageTextPages = pages;
                }
                if (Array.isArray(pages) && pages.length) {
                  var result = PRAChatService.applyCitationVerification(message, {
                    pageTextPages: pages,
                  });
                  if (!result) {
                    delete message.citations;
                    delete message.citationCounts;
                  }
                } else {
                  delete message.citations;
                  delete message.citationCounts;
                }
              } catch (e) {
                try {
                  Zotero.debug("[PaperReadingAgent] re-verify failed: " + e);
                } catch (e2) {}
                delete message.citations;
                delete message.citationCounts;
              }
              saveWorkflow(session);
              renderActiveMessages(session);
              renderWorkflow(session);
            });
            cancel.addEventListener("click", function () {
              renderActiveMessages(session);
            });
          },
        },
      );
      hasRenderedMessage = true;
      fitMath(v.ui.messages);
    } catch (e) {
      try {
        Zotero.debug("[PaperReadingAgent] renderMessage failed: " + e);
      } catch (e2) {}
    }
  });

  if (!hasRenderedMessage) {
    var emptyHint = el(
      v.doc,
      "div",
      null,
      "这个节点还没有对话——在下方输入框提问，回答会归入这个节点。",
    );
    emptyHint.className = "pra-empty-hint";
    v.ui.messages.appendChild(emptyHint);
  }

  if (typeof options.targetMessageIndex === "number") {
    scrollToRenderedMessage(session, options.targetMessageIndex);
  } else if (options.preserveScroll) {
    v.ui.messages.scrollTop = previousScrollTop;
  } else if (
    !activeChanged &&
    typeof session.messageScroll[mode] === "number"
  ) {
    v.ui.messages.scrollTop = session.messageScroll[mode];
  } else if (options.toBottom) {
    v.ui.messages.scrollTop = v.ui.messages.scrollHeight;
  } else {
    v.ui.messages.scrollTop = 0;
  }
  session.lastRenderedViewMode = mode;
  session.lastRenderedActiveId = state.activeId;
  return lastBubble;
}

function searchKindLabel(hit) {
  if (!hit) return "命中";
  if (hit.field === "thread.title") return "节点";
  if (hit.field === "thread.originExcerpt") return "引出文字";
  if (hit.field === "verbatimContent") return "逐字原文";
  if (hit.role === "user") return "问题";
  if (hit.role === "assistant") return "回答";
  return "正文";
}

function renderSearchResults(session) {
  var view = session && session.view;
  if (!view || !view.ui || !view.ui.searchResults) return;
  var ui = view.ui;
  var query = String(session.searchQuery || "").trim();
  var hits = session.searchHits || [];
  ui.searchResults.textContent = "";

  if (!query) {
    ui.searchCount.textContent = "";
    ui.searchResults.classList.remove("show");
    return;
  }
  ui.searchCount.textContent = hits.length
    ? (session.searchCursor >= 0 ? session.searchCursor + 1 + "/" : "") +
      hits.length +
      " 处"
    : "无匹配";
  if (!hits.length) {
    ui.searchResults.classList.remove("show");
    return;
  }

  hits.slice(0, 50).forEach(function (hit, index) {
    var button = el(view.doc, "button");
    button.className =
      "pra-search-result" + (index === session.searchCursor ? " active" : "");
    button.setAttribute("type", "button");
    button.setAttribute(
      "title",
      "跳到 " + (hit.lineId || hit.thoughtId || "未归类消息"),
    );
    var kind = el(view.doc, "span", null, searchKindLabel(hit));
    kind.className = "pra-search-result-kind";
    var excerpt = el(
      view.doc,
      "span",
      null,
      (hit.lineId ? hit.lineId + " · " : "") + (hit.excerpt || ""),
    );
    excerpt.className = "pra-search-result-text";
    button.append(kind, excerpt);
    button.addEventListener("click", function () {
      navigateSearchHit(session, index);
    });
    ui.searchResults.appendChild(button);
  });
  ui.searchResults.classList.add("show");
}

function navigateSearchHit(session, index) {
  var hits = session.searchHits || [];
  if (!hits.length) return;
  if (index < 0) index = hits.length - 1;
  if (index >= hits.length) index = 0;
  var hit = hits[index];
  var state = PRAReading.ensure(session.conv);
  var lineId = hit.lineId || null;
  var lineExists =
    lineId &&
    state.threads.some(function (thread) {
      return thread && thread.id === lineId;
    });
  if (lineExists && lineId !== state.activeId) {
    if (isBusy(session)) {
      session.view.ui.status.textContent =
        "回答生成中，暂不切换到其他思维节点。";
      return;
    }
    PRAReading.switchThread(session.conv, lineId);
    saveWorkflow(session);
  } else if (!lineExists && session.viewMode !== "all") {
    session.viewMode = "all";
    notebookViewState(session.conv).viewMode = "all";
    session.view.ui.viewSelect.value = "all";
    saveWorkflow(session);
  }
  session.searchCursor = index;
  renderActiveMessages(session, {
    targetMessageIndex: hit.messageIndex,
  });
  renderWorkflow(session);
  renderSearchResults(session);
}

function updateSearch(session, query) {
  session.searchQuery = String(query || "");
  session.searchHits = PRANotebook.searchConversation(
    session.conv,
    session.searchQuery,
  );
  session.searchCursor = -1;
  renderActiveMessages(session, { preserveScroll: true });
  renderSearchResults(session);
}

function safeExportBaseName(value) {
  var name = String(value || "对话笔记")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[.\s]+$/g, "")
    .trim();
  return (name || "对话笔记").slice(0, 90);
}

function compactExportTimestamp(date) {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .replace("Z", "");
}

async function exportConversation(session, format) {
  if (!session || !session.conv || !session.ctx) return null;
  var view = session.view;
  var isJSON = format === "json";
  var button = isJSON ? view.ui.exportJSON : view.ui.exportMD;
  button.disabled = true;
  try {
    await flushComposerDraft(session);
    var imported = session.conv.import_metadata || {};
    var title = imported.source_title || session.ctx.title || session.key;
    var now = new Date();
    var contents = isJSON
      ? JSON.stringify(session.conv, null, 2) + "\n"
      : PRANotebook.formatConversationMarkdown(session.conv, {
          title: title,
          paperTitle: session.ctx.title || "",
          source: imported.source || "",
          exportedAt: now.toISOString(),
        });
    var directory = PathUtils.join(
      Zotero.DataDirectory.dir,
      "paper-reading-agent",
      "exports",
    );
    await IOUtils.makeDirectory(directory, {
      ignoreExisting: true,
      createAncestors: true,
    });
    var path = PathUtils.join(
      directory,
      safeExportBaseName(title) +
        "-" +
        compactExportTimestamp(now) +
        (isJSON ? ".json" : ".md"),
    );
    await IOUtils.writeUTF8(path, contents, { flush: true });
    view.ui.status.textContent =
      (isJSON ? "无损 JSON 备份已导出：" : "Markdown 笔记已导出：") + path;
    view.ui.status.setAttribute("title", path);
    return path;
  } catch (error) {
    var message = String(error && error.message ? error.message : error);
    view.ui.status.textContent = "⚠ 导出失败：" + message;
    return null;
  } finally {
    button.disabled = false;
  }
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
  var topbar = el(doc, "div");
  topbar.className = "pra-topbar";
  var ver = el(doc, "span", null, "v0.13.16"); // keep in sync with package.json
  ver.className = "pra-version";
  topbar.appendChild(ver);
  var popout = el(doc, "button", null, "宽屏阅读 ⛶");
  popout.className = "pra-popout";
  popout.setAttribute("title", "在 Zotero 内展开完整思维导图与对话笔记");
  topbar.append(popout, banner);
  var notebookTools = el(doc, "div");
  notebookTools.className = "pra-notebook-tools";
  var search = el(doc, "input");
  search.className = "pra-search";
  search.setAttribute("type", "search");
  search.setAttribute("placeholder", "搜索问题、回答、公式或引出文字…");
  var viewSelect = el(doc, "select");
  viewSelect.className = "pra-view-select";
  [
    ["path", "当前因果路径"],
    ["node", "仅当前节点"],
    ["all", "全部笔记"],
  ].forEach(function (entry) {
    var option = el(doc, "option", null, entry[1]);
    option.setAttribute("value", entry[0]);
    viewSelect.appendChild(option);
  });
  var exportMD = el(doc, "button", null, "导出 MD");
  exportMD.className = "pra-tool-btn";
  exportMD.setAttribute("title", "导出完整 Markdown 笔记");
  var exportJSON = el(doc, "button", null, "备份 JSON");
  exportJSON.className = "pra-tool-btn";
  exportJSON.setAttribute("title", "导出无损原始会话 JSON");
  var toggleMap = el(doc, "button", null, "收起导图");
  toggleMap.className = "pra-tool-btn";
  toggleMap.setAttribute("title", "收起思维导图，为正文留出更多空间");
  var searchCount = el(doc, "span");
  searchCount.className = "pra-search-count";
  var storageStatus = el(doc, "span", null, "本地存储就绪");
  storageStatus.className = "pra-storage-status";
  var searchResults = el(doc, "div");
  searchResults.className = "pra-search-results";
  notebookTools.append(
    search,
    viewSelect,
    toggleMap,
    exportMD,
    exportJSON,
    searchCount,
    storageStatus,
    searchResults,
  );
  var reading = el(doc, "div");
  reading.className = "pra-reading";
  var thoughtMap = el(doc, "div");
  thoughtMap.className = "pra-thought-map";
  thoughtMap.style.display = "none";
  var thoughtHead = el(doc, "div");
  thoughtHead.className = "pra-thought-head";
  var thoughtTitle = el(doc, "span", null, "思维导图（0 个节点）");
  thoughtHead.append(thoughtTitle);
  var thoughtList = el(doc, "div");
  thoughtList.className = "pra-thought-list";
  thoughtList.addEventListener(
    "wheel",
    function (event) {
      // Ordinary wheel movement must remain vertical so a long main route is
      // readable. Horizontal panning is explicit: a native trackpad deltaX or
      // Shift+wheel. Blank-canvas dragging remains two-dimensional below.
      var delta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
      if (!delta) return;
      if (thoughtList.scrollWidth <= thoughtList.clientWidth) return;
      event.preventDefault();
      thoughtList.scrollLeft += delta;
    },
    { passive: false },
  );
  var mapDragging = false;
  var mapStartX = 0;
  var mapStartY = 0;
  var mapStartLeft = 0;
  var mapStartTop = 0;
  thoughtList.addEventListener("mousedown", function (event) {
    var target = event.target;
    if (target && target.closest && target.closest("button")) return;
    mapDragging = true;
    mapStartX = event.clientX;
    mapStartY = event.clientY;
    mapStartLeft = thoughtList.scrollLeft;
    mapStartTop = thoughtList.scrollTop;
    thoughtList.classList.add("dragging");
    event.preventDefault();
  });
  thoughtList.addEventListener("mousemove", function (event) {
    if (!mapDragging) return;
    thoughtList.scrollLeft = mapStartLeft - (event.clientX - mapStartX);
    thoughtList.scrollTop = mapStartTop - (event.clientY - mapStartY);
  });
  function stopMapDrag() {
    if (!mapDragging) return;
    mapDragging = false;
    thoughtList.classList.remove("dragging");
  }
  thoughtList.addEventListener("mouseup", stopMapDrag);
  thoughtList.addEventListener("mouseleave", stopMapDrag);
  thoughtMap.append(thoughtHead, thoughtList);
  var current = el(doc, "div");
  current.className = "pra-current";
  var parking = el(doc, "div");
  parking.className = "pra-parking";
  parking.style.display = "none";
  var parkingHead = el(doc, "div", null, "问题停车场（0）");
  parkingHead.className = "pra-parking-head";
  var parkingList = el(doc, "div");
  parkingList.className = "pra-parking-list";
  parking.append(parkingHead, parkingList);
  reading.append(thoughtMap, current, parking);
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
  var parkActions = el(doc, "div");
  parkActions.className = "pra-park-actions";
  var parkLater = el(doc, "button", null, "读完再问");
  parkLater.className = "pra-mini";
  var parkBranch = el(doc, "button", null, "旁支暂存");
  parkBranch.className = "pra-mini";
  parkActions.append(parkLater, parkBranch);
  var send = el(doc, "button");
  send.className = "pra-send";
  send.textContent = "Send";
  bar.append(parkActions, send);
  composer.append(input, attach, bar);
  wrap.append(topbar, notebookTools, reading, messages, status, composer);
  body.append(wrap);
  return {
    wrap: wrap,
    banner: banner,
    popout: popout,
    search: search,
    searchCount: searchCount,
    searchResults: searchResults,
    storageStatus: storageStatus,
    viewSelect: viewSelect,
    toggleMap: toggleMap,
    exportMD: exportMD,
    exportJSON: exportJSON,
    thoughtMap: thoughtMap,
    thoughtHead: thoughtHead,
    thoughtTitle: thoughtTitle,
    thoughtList: thoughtList,
    current: current,
    parking: parking,
    parkingHead: parkingHead,
    parkingList: parkingList,
    parkLater: parkLater,
    parkBranch: parkBranch,
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
      nextAnchor: null,
      nextFollowup: false,
      draftTimer: 0,
      draftDirty: false,
      viewMode: null,
      mapCollapsed: false,
      searchQuery: "",
      searchHits: [],
      searchCursor: -1,
      messageScroll: { path: null, node: null, all: null },
      lastRenderedViewMode: null,
      lastRenderedActiveId: null,
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
      fitMath(v.assistantBubble);
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

function startTurn(session, content, images, turnOptions) {
  var run = (session.run = {
    liveRef: {},
    startedAt: Date.now(),
    lastActivity: "thinking…",
    finished: false,
    text: "",
    target: "",
    drip: 0,
    timer: 0,
    submittedText: content || "",
    userAccepted: false,
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
      if (
        errMsg &&
        !run.userAccepted &&
        run.submittedText &&
        !v.ui.input.value
      ) {
        v.ui.input.value = run.submittedText;
        v.ui.input.style.height = "auto";
        v.ui.input.style.height = Math.min(340, v.ui.input.scrollHeight) + "px";
      }
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
      if (turnOptions && turnOptions.originExcerpt) {
        m.originExcerpt = turnOptions.originExcerpt;
        m.originRole = turnOptions.originRole || null;
      }
      run.userAccepted = true;
      clearAcceptedComposerDraft(session, run.submittedText);
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
      try {
        PRAReading.finishAnswer(session.conv, run.message);
        saveWorkflow(session);
        renderWorkflow(session);
      } catch (e) {}
      endTurn(null);
    },
    onError: function (msg) {
      try {
        if (run.message && run.message.content) {
          PRAReading.finishAnswer(session.conv, run.message);
          saveWorkflow(session);
          renderWorkflow(session);
        }
      } catch (e) {}
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
    turnOptions,
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
    ui.popout.disabled = true;
    ui.search.disabled = true;
    ui.viewSelect.disabled = true;
    ui.toggleMap.disabled = true;
    ui.exportMD.disabled = true;
    ui.exportJSON.disabled = true;
    return;
  }
  // Wide-mode toggle. Bound to BOTH pointerup and click so it works even if
  // one event type is swallowed by the Zotero item-pane environment; the
  // 250ms guard eats the duplicate (pointerup fires first, click follows).
  // Debug log lets us confirm the click actually arrives.
  var lastWideToggle = 0;
  function toggleWideMode() {
    var now = Date.now();
    if (now - lastWideToggle < 250) return;
    lastWideToggle = now;
    var wide = !ui.wrap.classList.contains("pra-wide");
    ui.wrap.classList.toggle("pra-wide", wide);
    ui.popout.textContent = wide ? "退出宽屏 ×" : "宽屏阅读 ⛶";
    ui.popout.setAttribute(
      "title",
      wide ? "退出宽屏阅读" : "展开完整思维导图与对话笔记",
    );
    try {
      Zotero.debug(
        "[PaperReadingAgent] wide toggle → " + (wide ? "wide" : "narrow"),
      );
    } catch (e) {}
    // NO full re-render here: the content is unchanged, the container size
    // is pure CSS, so re-rendering only caused lag that looked like missed
    // clicks (and users clicked again → wide↔narrow bouncing).
  }
  ui.popout.addEventListener("pointerup", toggleWideMode);
  ui.popout.addEventListener("click", toggleWideMode);
  doc.addEventListener("keydown", function (event) {
    if (
      event.key === "Escape" &&
      ui.wrap.isConnected &&
      ui.wrap.classList.contains("pra-wide")
    ) {
      ui.wrap.classList.remove("pra-wide");
      ui.popout.textContent = "宽屏阅读 ⛶";
      ui.popout.setAttribute("title", "展开完整思维导图与对话笔记");
    }
  });

  var ctx;
  try {
    ctx = await PRAItemContext.prepareWorkdir(item, {
      libraryAccess: p.libraryAccess,
    });
  } catch (e) {
    ui.status.textContent = "⚠ " + (e && e.message ? e.message : e);
    ui.input.disabled = true;
    ui.send.disabled = true;
    return;
  }

  var session = getSession(ctx.key);
  session.ctx = ctx;
  if (!session.conv) session.conv = await PRAStore.load(ctx.key);

  session.view = {
    ui: ui,
    doc: doc,
    attachmentID: ctx.attachmentID,
    assistantBubble: null,
  };
  PRAReading.ensure(session.conv);
  restoreComposerDraft(session);
  var persistedView = notebookViewState(session.conv);
  session.viewMode = persistedView.viewMode;
  session.mapCollapsed = persistedView.mapCollapsed;
  ui.viewSelect.value = session.viewMode;
  ui.search.value = session.searchQuery || "";
  session.searchHits = session.searchQuery
    ? PRANotebook.searchConversation(session.conv, session.searchQuery)
    : [];
  paintLoadedStoreNotice(session);
  var lastBubble = renderActiveMessages(session);
  renderPending(session); // restore any queued image chips after a re-mount
  renderWorkflow(session);
  renderSearchResults(session);

  ui.viewSelect.addEventListener("change", function () {
    var mode = ui.viewSelect.value;
    if (mode !== "path" && mode !== "node" && mode !== "all") mode = "path";
    session.viewMode = mode;
    notebookViewState(session.conv).viewMode = mode;
    session.searchCursor = -1;
    saveWorkflow(session);
    renderActiveMessages(session);
    renderSearchResults(session);
  });
  ui.toggleMap.addEventListener("click", function () {
    session.mapCollapsed = !session.mapCollapsed;
    notebookViewState(session.conv).mapCollapsed = session.mapCollapsed;
    saveWorkflow(session);
    renderWorkflow(session);
  });
  ui.search.addEventListener("input", function () {
    updateSearch(session, ui.search.value);
  });
  ui.search.addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      event.preventDefault();
      navigateSearchHit(
        session,
        session.searchCursor + (event.shiftKey ? -1 : 1),
      );
    } else if (event.key === "Escape") {
      event.preventDefault();
      ui.search.value = "";
      updateSearch(session, "");
    }
  });
  ui.exportMD.addEventListener("click", function () {
    exportConversation(session, "markdown");
  });
  ui.exportJSON.addEventListener("click", function () {
    exportConversation(session, "json");
  });
  ui.messages.addEventListener("scroll", function () {
    var mode = session.viewMode || "path";
    session.messageScroll[mode] = ui.messages.scrollTop;
  });

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
        var reading = PRAReading.ensure(session.conv);
        var active = PRAReading.activeThread(session.conv);
        var branch = !!session.branchNext && !!active;
        var followup = !!active && !branch;
        var card = PRAReading.beginQuestion(
          session.conv,
          content || "关于当前截图的问题",
          reading.mode,
          {
            anchor: session.nextAnchor || null,
            followup: followup,
            branch: branch,
            // Provenance is independent from backend-session isolation. A
            // future "continue from this excerpt" action can retain thoughtId
            // while still recording the exact causal passage.
            originExcerpt: session.branchOrigin || "",
            originRole: session.branchOriginRole || null,
          },
        );
        var turnOptions = {
          readingMode: reading.mode,
          questionId: card && card.id,
          lineId: card && (card.lineId || card.id),
          thoughtId: card && (card.thoughtId || card.id),
          followup: followup,
          originExcerpt: session.branchOrigin || "",
          originRole: session.branchOriginRole || null,
          branchContext:
            PRAReading.branchContext(session.conv, card && card.id) +
            (session.branchOrigin
              ? "\n\nExact branch point:\n" + session.branchOrigin
              : ""),
        };
        session.nextAnchor = null;
        session.nextFollowup = false;
        session.branchNext = false;
        session.branchOrigin = "";
        session.branchOriginRole = null;
        ui.input.placeholder = "继续这条思路…";
        saveWorkflow(session);
        renderActiveMessages(session);
        renderWorkflow(session);
        startTurn(session, content, images, turnOptions);
      } catch (e) {
        try {
          Zotero.debug("[PaperReadingAgent] startTurn threw: " + e);
        } catch (e2) {}
        if (content && !ui.input.value) {
          ui.input.value = content;
          ui.input.style.height = "auto";
          ui.input.style.height = Math.min(340, ui.input.scrollHeight) + "px";
        }
        ui.status.textContent = "⚠ " + e;
      }
    });
  }
  function parkComposer(category) {
    if (isBusy(session)) return;
    var text = (ui.input.value || "").trim();
    if (!text) {
      ui.status.textContent = "先输入要暂存的问题。";
      return;
    }
    PRAReading.park(session.conv, text, category, session.nextAnchor || null);
    session.nextAnchor = null;
    session.nextFollowup = false;
    ui.input.value = "";
    ui.input.style.height = "auto";
    if (session.draftTimer) {
      clearTimeout(session.draftTimer);
      session.draftTimer = 0;
    }
    session.draftDirty = false;
    PRAComposerDraft.clearComposerDraft(session.conv);
    ui.status.textContent =
      category === "branch" ? "已放入旁支问题。" : "已放入读完再问。";
    saveWorkflow(session);
    renderWorkflow(session);
  }
  ui.parkLater.addEventListener("click", function () {
    parkComposer("later");
  });
  ui.parkBranch.addEventListener("click", function () {
    parkComposer("branch");
  });
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
    rememberComposerDraft(session, ui.input.value);
  });
  ui.input.addEventListener("blur", function () {
    flushComposerDraft(session);
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
        revealContextPane();
      },
      onAsyncRender: async function (hooks) {
        try {
          revealContextPane();
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
    revealContextPane();
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

// Build the library-wide snapshot the resident agent reads (catalog, collection
// tree, the user's annotations/notes, instructions). Nothing consumes it yet —
// it is exposed so it can be run and inspected from the Run JavaScript console
// before any UI is built on top.
export async function buildLibrarySnapshot(force) {
  return await ensureLibrarySnapshot({ force: !!force });
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
    buildLibrarySnapshot: buildLibrarySnapshot,
  };
} catch (e) {}
