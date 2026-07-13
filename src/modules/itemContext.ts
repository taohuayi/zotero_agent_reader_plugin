// @ts-nocheck
/*
 * itemContext.ts — resolve the current Zotero item's PDF and build a per-item
 * working directory for codex (Zotero / privileged chrome only).
 *
 * We do NOT copy the PDF: we point the agent's instruction file at Zotero's real
 * attachment path and let it read the PDF on demand with pdftotext. The working
 * dir holds only the per-backend instruction files (codex reads AGENTS.md, claude
 * reads CLAUDE.md — same content), keyed by the attachment key.
 */
import { instructionFiles } from "./backends";

var AGENTS_TEMPLATE =
  "# Reading assistant scope\n\n" +
  "You are helping the user read and understand ONE specific paper:\n\n" +
  "**{title}**\n\n" +
  "The paper's PDF is on disk at:\n" +
  "  {pdfPath}\n\n" +
  "Read it with `pdftotext` (preserve layout) to answer — e.g.:\n\n" +
  "    pdftotext -layout \"{pdfPath}\" -              # whole paper\n" +
  "    pdftotext -layout -f 7 -l 8 \"{pdfPath}\" -    # only pages 7-8\n\n" +
  "Answer questions about THIS paper. Be concise and precise; refer to section\n" +
  "or equation names when relevant. You may use web search for related work,\n" +
  "definitions, or cited papers. Do not modify any files.\n\n" +
  "## Read efficiently (avoid being slow)\n\n" +
  "Read the whole paper in ONE pass with `pdftotext -layout \"{pdfPath}\" -` to\n" +
  "understand and answer it. Pages are separated by a form-feed (^L, 0x0C): the\n" +
  "text before the first ^L is physical page 1, before the second is page 2, etc.\n" +
  "Do NOT re-read the whole paper page by page — that is slow and unnecessary.\n\n" +
  "## Cite the paper\n\n" +
  "After a KEY claim about THIS paper, add a citation in this format:\n\n" +
  "    [p.N \"short verbatim quote\"]\n\n" +
  "- N is the PHYSICAL PDF page (1-based, counted by form-feeds as above) — NOT\n" +
  "  the page number printed on the page. The user clicks [p.N] to jump there.\n" +
  "- The quote is ≤ 15 words copied VERBATIM from the PDF (no paraphrase/translation).\n" +
  "- Cite the MAIN claims; you need NOT cite every sentence.\n" +
  "- Only if genuinely unsure of a quote's physical page, do ONE\n" +
  "  `pdftotext -layout -f N -l N \"{pdfPath}\" -` to check it — don't re-read everything.\n";

function pluginDataDir() {
  return PathUtils.join(Zotero.DataDirectory.dir, "paper-reading-agent");
}

export async function resolvePdfAttachment(item) {
  if (!item) return null;
  if (item.isAttachment && item.isAttachment()) return item;
  if (item.getAttachments) {
    var ids = item.getAttachments();
    var atts = [];
    for (var i = 0; i < ids.length; i++) {
      var att = Zotero.Items.get(ids[i]);
      if (att && att.isAttachment()) atts.push(att);
    }
    // prefer a PDF by content type
    for (var j = 0; j < atts.length; j++) {
      if (atts[j].attachmentContentType === "application/pdf") return atts[j];
    }
    // then a *.pdf filename (a PDF can carry a missing/wrong content type)
    for (var k = 0; k < atts.length; k++) {
      if (/\.pdf$/i.test(atts[k].attachmentFilename || "")) return atts[k];
    }
    // no PDF among the attachments: do NOT fall back to a non-PDF one (a web
    // snapshot, .docx, …) — returning null yields a clear "No PDF attachment"
    // error instead of handing the agent a file pdftotext cannot read.
  }
  return null;
}

function titleOf(item) {
  try {
    if (item.getDisplayTitle) return item.getDisplayTitle();
    if (item.getField) return item.getField("title");
  } catch (e) {}
  return "this paper";
}

// Returns { workdir, pdfPath, key, title } or throws with a user-facing message.
export async function prepareWorkdir(item) {
  var att = await resolvePdfAttachment(item);
  if (!att) throw new Error("No PDF attachment found for this item.");
  var pdfPath = await att.getFilePathAsync();
  if (!pdfPath) throw new Error("The PDF file is not available locally for this item.");

  var key = att.key;
  var workdir = PathUtils.join(pluginDataDir(), "work", key);
  await IOUtils.makeDirectory(workdir, { ignoreExisting: true, createAncestors: true });

  var title = titleOf(item) || "this paper";
  var agents = AGENTS_TEMPLATE
    .replace("{title}", title)
    .split("{pdfPath}").join(pdfPath);
  // one instruction file per backend convention (AGENTS.md, CLAUDE.md), same content
  var files = instructionFiles();
  for (var i = 0; i < files.length; i++) {
    await IOUtils.writeUTF8(PathUtils.join(workdir, files[i]), agents);
  }

  return { workdir: workdir, pdfPath: pdfPath, key: key, title: title, attachmentID: att.id };
}
