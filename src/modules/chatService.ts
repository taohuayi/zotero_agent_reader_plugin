// @ts-nocheck
/*
 * chatService.ts — orchestrate one chat turn (Zotero / privileged chrome only).
 *
 * Persist the user message, append an empty assistant message up front, drive the
 * codex turn, accumulate token deltas, and persist on done AND on error/teardown
 * so partial answers survive.
 *
 * `ui` adapter: { onUser(msg), onAssistantStart(msg), onAssistantUpdate(text),
 *                 onStatus(text), onDone(), onError(text) }
 */
import * as PRAStore from "./store";
import { getBackend } from "./backends";
import { loadPdfTextIndexPages } from "./pdfTextIndex";
import { verifyAndCorrectCitationPages } from "./referenceResolver";

export function buildBackendPrompt(content, ctx) {
  var prompt = String(content == null ? "" : content);
  if (!ctx || !ctx.pageTextPath) return prompt;
  return (
    prompt +
    "\n\n[Paper Reading Agent citation rule: use the indexed paper text at " +
    ctx.pageTextPath +
    ". Each page begins with <<<PRA_PHYSICAL_PDF_PAGE:N>>>. For every " +
    '[p.N "quote"] citation, copy N from the marker on the SAME page as ' +
    "the verbatim quote; never count form-feeds or use printed page numbers.]"
  );
}

export function applyCitationVerification(assistant, ctx) {
  if (
    !assistant ||
    !ctx ||
    !Array.isArray(ctx.pageTextPages) ||
    !ctx.pageTextPages.length
  ) {
    return null;
  }
  var result = verifyAndCorrectCitationPages(
    assistant.content,
    ctx.pageTextPages,
  );
  assistant.content = result.text;
  assistant.citations = result.citations;
  assistant.citationCounts = result.counts;
  return result;
}

export async function runTurn(opts, ctx, conv, content, images, ui, liveRef) {
  // images: [{ path, thumb }] — path is the on-disk file (sent to the backend),
  // thumb is a small data URL kept only for re-rendering the bubble after reload.
  var userMsg = { role: "user", content: content };
  if (images && images.length) userMsg.images = images;
  var assistant = { role: "assistant", content: "" };
  conv.messages.push(userMsg);
  conv.messages.push(assistant);
  await PRAStore.save(conv);
  if (ui.onUser) ui.onUser(userMsg);
  if (ui.onAssistantStart) ui.onAssistantStart(assistant);

  var terminalEvent = null;

  var backend = getBackend(opts.backend);
  var handle = PRAStore.getSessionHandle(conv, backend.id);
  var backendPrompt = buildBackendPrompt(content, ctx);
  // let the backend read files outside the workdir (the PDF lives in Zotero's
  // storage tree); codex ignores opts.addDir, claude maps it to --add-dir.
  var runOpts = opts;
  try {
    runOpts = Object.assign({}, opts);
    if (ctx.pdfPath) runOpts.addDir = PathUtils.parent(ctx.pdfPath);
    if (images && images.length)
      runOpts.images = images.map(function (im) {
        return im.path;
      });
  } catch (e) {
    runOpts = opts;
  }

  try {
    await backend.runTurn(
      runOpts,
      ctx.workdir,
      handle,
      backendPrompt,
      function (ev) {
        if (ev.kind === "thread_started") {
          if (
            ev.sessionId &&
            PRAStore.setSessionHandle(conv, backend.id, ev.sessionId)
          ) {
            PRAStore.save(conv);
          }
        } else if (ev.kind === "delta") {
          assistant.content += ev.text;
          if (ui.onAssistantUpdate) ui.onAssistantUpdate(assistant.content);
        } else if (ev.kind === "tool") {
          if (ui.onStatus)
            ui.onStatus(
              (ev.toolName || "tool") + (ev.detail ? ": " + ev.detail : "…"),
            );
        } else if (ev.kind === "done" || ev.kind === "error") {
          if (!terminalEvent) terminalEvent = ev;
        }
      },
      liveRef,
    );
  } catch (e) {
    terminalEvent = {
      kind: "error",
      message: String(e && e.message ? e.message : e),
    };
  }

  if (!terminalEvent) terminalEvent = { kind: "done" };

  // Do this only after the complete response is available.  Streaming remains
  // realtime; then a deterministic quote lookup corrects any model page error
  // before the answer is persisted and its final rich render is painted.
  try {
    var pageTextPages = ctx.pageTextPages;
    if (
      (!Array.isArray(pageTextPages) || !pageTextPages.length) &&
      ctx.pageTextPath
    ) {
      pageTextPages = await loadPdfTextIndexPages(ctx.pageTextPath);
    }
    if (
      ui.onStatus &&
      assistant.content &&
      Array.isArray(pageTextPages) &&
      pageTextPages.length
    )
      ui.onStatus("verifying citations…");
    var verification = applyCitationVerification(assistant, {
      pageTextPages: pageTextPages,
    });
    if (verification && ui.onAssistantUpdate) {
      ui.onAssistantUpdate(assistant.content);
    }
  } catch (e) {
    try {
      Zotero.debug("[PaperReadingAgent] citation verification failed: " + e);
    } catch (e2) {}
  }

  await PRAStore.save(conv);
  if (terminalEvent.kind === "error") {
    if (ui.onError) ui.onError(terminalEvent.message);
  } else if (ui.onDone) {
    ui.onDone();
  }
}
