// @ts-nocheck
/*
 * render.ts — render assistant Markdown + LaTeX math into SAFE HTML.
 *
 * Pipeline (the markdown/math + sanitization ordering matters):
 *   1. pull out math spans ($$..$$, \[..\], \(..\), $..$) → placeholder tokens
 *   2. marked() the placeholder'd text → HTML
 *   3. DOMPurify.sanitize() that HTML  — REQUIRED: the body is a privileged
 *      chrome node, and the model could be prompt-injected to emit <img onerror>
 *   4. katex.renderToString() each math span (trusted output) and substitute it
 *      back into the sanitized HTML at its token
 *
 * Returns an HTML string, or null when anything fails — callers MUST fall back
 * to plain textContent on null (never inject raw HTML).
 *
 * Vendored as npm deps (bundled by esbuild): marked, katex, dompurify. KaTeX's
 * stylesheet + fonts ship as static assets under addon/content/vendor/.
 */
import { marked } from "marked";
import katex from "katex";
import DOMPurify from "dompurify";
import { pullCitationMarkers, referenceToken } from "./referenceResolver";

var _purify = null;
function getPurify(win) {
  if (_purify) return _purify;
  var D = DOMPurify;
  if (!D) return null;
  // The npm dompurify default export is callable as a factory: bind it to the
  // item-pane window so sanitization runs against that document. (A windowless
  // instance silently passes HTML through, which would defeat sanitization.)
  try {
    var instance =
      typeof D === "function"
        ? D(win)
        : typeof D.sanitize === "function"
          ? D
          : null;
    if (instance && typeof instance.sanitize === "function") {
      _purify = instance;
    }
  } catch (e) {
    _purify = null;
  }
  return _purify;
}

// Degraded sanitizer: keeps markdown/KaTeX HTML, strips only the obviously
// dangerous bits. Used when DOMPurify cannot bind to the item-pane document
// (Zotero XUL/XHTML windows can fail DOMPurify's createHTMLDocument probe).
function fallbackSanitize(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe\s*>/gi, "")
    .replace(/<object[\s\S]*?<\/object\s*>/gi, "")
    .replace(/<embed[\s\S]*?>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/javascript:/gi, "")
    .replace(/<style[\s\S]*?<\/style\s*>/gi, "");
}

// Order matters: consume $$...$$ / \[...\] / \(...\) before inline $...$.
var PATTERNS = [
  { re: /\$\$([\s\S]+?)\$\$/g, display: true },
  { re: /\\\[([\s\S]+?)\\\]/g, display: true },
  { re: /\\\(([\s\S]+?)\\\)/g, display: false },
  { re: /\$(?!\s)((?:\\.|[^$\\\n])+?)(?<!\s)\$/g, display: false },
];

function isMoney(t) {
  return /^[\s\d.,]+$/.test(t);
} // skip "$5", "$1,000"
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function escAttr(s) {
  return esc(s).replace(/"/g, "&quot;");
}
function tok(i) {
  return "KTXMATH" + i + "ENDKTX";
} // survives marked + DOMPurify as plain text

export function render(text, win, citationChecks) {
  if (text == null) return null; // marked/katex may be absent → degrade, never block

  var src = String(text);

  // Pull citations out FIRST (before math) so a quote that happens to contain
  // `$` isn't mistaken for math; substituted back (post-sanitize) as click targets.
  var pulled = pullCitationMarkers(src);
  var cites = pulled.citations;
  src = pulled.text;

  var maths = [];
  for (var p = 0; p < PATTERNS.length; p++) {
    var pat = PATTERNS[p];
    src = src.replace(pat.re, function (m, tex) {
      if (!pat.display && isMoney(tex)) return m;
      var i = maths.length;
      maths.push({ tex: tex, display: pat.display });
      return pat.display ? "\n\n" + tok(i) + "\n\n" : tok(i);
    });
  }

  var html;
  try {
    html = marked && marked.parse
      ? marked.parse(src, { gfm: true, breaks: true })
      : esc(src).replace(/\n/g, "<br>");
  } catch (e) {
    html = esc(src).replace(/\n/g, "<br>");
  }

  var pf = getPurify(win);
  try {
    html = pf
      ? pf.sanitize(html, { ADD_ATTR: ["target", "rel"] })
      : fallbackSanitize(html);
  } catch (e) {
    try {
      html = fallbackSanitize(html);
    } catch (e2) {
      return null;
    }
  }

  for (var j = 0; j < maths.length; j++) {
    var out;
    try {
      out = katex
        ? katex.renderToString(maths[j].tex, {
            displayMode: maths[j].display,
            throwOnError: false,
          })
        : null;
    } catch (e) {
      out = null;
    }
    if (!out) {
      var d = maths[j].display ? "$$" : "$";
      out = esc(d + maths[j].tex + d);
    }
    html = html.split(tok(j)).join(out);
  }

  // substitute citation placeholders with clickable spans (chatPanel wires the
  // click → Zotero.Reader navigation; <span>, not <a>, to bypass the launchURL handler)
  for (var c = 0; c < cites.length; c++) {
    var ct = cites[c];
    var check =
      Array.isArray(citationChecks) && citationChecks[c]
        ? citationChecks[c]
        : null;
    var status = check && check.status;
    var title = ct.quote
      ? "Jump to this passage"
      : "Open this physical PDF page";
    if (status === "corrected") {
      title =
        "Agent cited physical p." +
        check.reportedPage +
        "; verified and corrected to p." +
        ct.page;
    } else if (status === "verified") {
      title = "Verified on physical PDF page " + ct.page;
    } else if (status === "ambiguous") {
      title =
        "Quote occurs on multiple physical pages (" +
        (check.matchedPages || []).join(", ") +
        "); keeping the cited p." +
        ct.page;
    } else if (status === "unverified") {
      title =
        "Quote was not found in the extracted PDF text; opening cited p." +
        ct.page;
    } else if (status === "page-only") {
      title = "Page-only citation; quote verification unavailable";
    }
    var span =
      '<span class="pra-cite' +
      (status ? " " + esc(status) : "") +
      '" data-page="' +
      esc(ct.page) +
      '"' +
      (status ? ' data-citation-status="' + escAttr(status) + '"' : "") +
      (check && check.reportedPage != null
        ? ' data-reported-page="' + escAttr(check.reportedPage) + '"'
        : "") +
      (ct.quote ? ' data-quote="' + escAttr(ct.quote) + '"' : "") +
      ' title="' +
      escAttr(title) +
      '"' +
      '><span class="pra-cite-page">[p.' +
      esc(ct.page) +
      "]</span>" +
      (ct.quote
        ? ' <span class="pra-cite-quote">“' + esc(ct.quote) + "”</span>"
        : "") +
      "</span>";
    html = html.split(referenceToken(c)).join(span);
  }

  // Self-close void elements (<br> → <br/>, etc.). The Zotero item-pane document
  // parses innerHTML as strict XHTML, where a bare <br> is malformed and THROWS;
  // marked (breaks:true) emits <br>, so normalize before it reaches innerHTML.
  html = html.replace(
    /<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b([^>]*?)\s*\/?>/gi,
    "<$1$2/>",
  );
  return html;
}
