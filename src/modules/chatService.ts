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
import { responseInstruction } from "./readingWorkflow";
import { verifyAndCorrectCitationPages } from "./referenceResolver";

function persistenceError(stage, error) {
  return (
    "保存失败（" +
    stage +
    "）： " +
    String(error && error.message ? error.message : error)
  );
}

async function requiredSave(conv, ui, stage) {
  try {
    await PRAStore.save(conv);
  } catch (e) {
    var message = persistenceError(stage, e);
    if (ui && ui.onError) ui.onError(message);
    else if (ui && ui.onStatus) ui.onStatus(message);
    throw e;
  }
}

function bestEffortSave(conv, ui, stage) {
  try {
    Promise.resolve(PRAStore.save(conv)).catch(function (e) {
      if (ui && ui.onStatus) ui.onStatus(persistenceError(stage, e));
    });
  } catch (e) {
    if (ui && ui.onStatus) ui.onStatus(persistenceError(stage, e));
  }
}

export function buildBackendPrompt(content, ctx, turnOptions) {
  var prompt = String(content == null ? "" : content);
  if (turnOptions && turnOptions.readingMode) {
    prompt +=
      "\n\n---\n" +
      responseInstruction(turnOptions.readingMode, !!turnOptions.followup);
  }
  if (turnOptions && turnOptions.branchContext) {
    prompt +=
      "\n\n[Thought-tree ancestry for orientation; stay inside the active branch]\n" +
      turnOptions.branchContext;
  }
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

export async function runTurn(
  opts,
  ctx,
  conv,
  content,
  images,
  ui,
  liveRef,
  turnOptions,
) {
  // images: [{ path, thumb }] — path is the on-disk file (sent to the backend),
  // thumb is a small data URL kept only for re-rendering the bubble after reload.
  var backend = getBackend(opts.backend);
  var userMsg = { role: "user", content: content };
  if (images && images.length) userMsg.images = images;
  if (turnOptions && turnOptions.readingMode)
    userMsg.readingMode = turnOptions.readingMode;
  if (turnOptions && turnOptions.questionId)
    userMsg.questionId = turnOptions.questionId;
  if (turnOptions && turnOptions.lineId) userMsg.lineId = turnOptions.lineId;
  if (turnOptions && turnOptions.thoughtId)
    userMsg.thoughtId = turnOptions.thoughtId;
  var assistant = {
    role: "assistant",
    content: "",
    backend: backend.id,
    lineId: turnOptions && turnOptions.lineId,
    thoughtId: turnOptions && turnOptions.thoughtId,
  };
  var requestedModel = backend.id === "claude" ? opts.claudeModel : opts.model;
  if (requestedModel) assistant.requestedModel = requestedModel;
  conv.messages.push(userMsg);
  conv.messages.push(assistant);
  // Do not contact the backend if this conversation is read-only because a
  // damaged primary and backup failed to load, or if the initial durable save
  // otherwise fails.
  await requiredSave(conv, ui, "发送前");
  if (ui.onUser) ui.onUser(userMsg);
  if (ui.onAssistantStart) ui.onAssistantStart(assistant);

  var terminalEvent = null;

  var thoughtId = turnOptions && turnOptions.thoughtId;
  var handle = PRAStore.getSessionHandle(conv, backend.id, thoughtId);
  var backendPrompt = buildBackendPrompt(content, ctx, turnOptions);
  // let the backend read files outside the workdir (the PDF lives in Zotero's
  // storage tree); codex ignores opts.addDir, claude maps it to --add-dir.
  var runOpts;
  try {
    runOpts = Object.assign({}, opts);
    if (ctx.pdfPath) runOpts.addDir = PathUtils.parent(ctx.pdfPath);
    // library access (when enabled): the snapshot dir plus Zotero's storage
    // tree, which holds the full-text extraction cache the agent greps
    if (ctx.library) {
      var extraDirs = [];
      if (ctx.library.workdir) extraDirs.push(ctx.library.workdir);
      if (ctx.library.storage) extraDirs.push(ctx.library.storage);
      if (extraDirs.length) runOpts.addDirs = extraDirs;
    }
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
            PRAStore.setSessionHandle(conv, backend.id, ev.sessionId, thoughtId)
          ) {
            bestEffortSave(conv, ui, "记录会话");
          }
        } else if (ev.kind === "runtime_info") {
          var before = [
            assistant.model || "",
            assistant.modelProvider || "",
            assistant.reasoningEffort || "",
            assistant.modelSource || "",
          ].join("\n");
          if (ev.backend) assistant.backend = ev.backend;
          if (ev.model) assistant.model = ev.model;
          if (ev.modelProvider) assistant.modelProvider = ev.modelProvider;
          if (ev.reasoningEffort)
            assistant.reasoningEffort = ev.reasoningEffort;
          if (ev.source) assistant.modelSource = ev.source;
          var after = [
            assistant.model || "",
            assistant.modelProvider || "",
            assistant.reasoningEffort || "",
            assistant.modelSource || "",
          ].join("\n");
          if (before !== after) {
            // Best-effort intermediate persistence: the final save below remains
            // authoritative, but this preserves metadata if Zotero closes mid-turn.
            bestEffortSave(conv, ui, "记录模型信息");
            if (ui.onRuntimeInfo) ui.onRuntimeInfo(assistant, ev);
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

  await requiredSave(conv, ui, "完成回答");
  if (terminalEvent.kind === "error") {
    if (ui.onError) ui.onError(terminalEvent.message);
  } else if (ui.onDone) {
    ui.onDone();
  }
}
