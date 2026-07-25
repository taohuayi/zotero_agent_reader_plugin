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
import { ensurePdfTextIndex, PAGE_HEADER_PREFIX } from "./pdfTextIndex";
import { ensureLibrarySnapshot } from "./libraryContext";

// Optional section appended when library access is enabled: the same paper chat,
// but able to look across the whole library. `library` is what
// ensureLibrarySnapshot returns, or null when the feature is off/unavailable.
//
// Deliberately does NOT introduce a cross-paper citation marker: chatPanel only
// renders `[p.N "quote"]` for THIS paper (referenceResolver resolves it against
// this PDF), so a `[@key p.N …]` form would render as dead text and could not be
// verified. Other papers are referenced in prose until that UI exists.
export function buildLibrarySection(library) {
  if (!library || !library.files) return "";
  var f = library.files;
  var stats = library.stats || {};
  return (
    "\n## The rest of the library (read-only)\n\n" +
    "This user's whole Zotero library is readable. Use it when the question\n" +
    "reaches beyond this paper — related work, prior art, what they already\n" +
    "read. Do NOT use it to answer questions about THIS paper.\n\n" +
    "- `" +
    f.catalog +
    "`\n  tab-separated, " +
    (stats.itemCount || 0) +
    " items: key, year, type, title, creators, collection paths,\n" +
    "  attachment keys.\n" +
    "- `" +
    f.collections +
    "`\n  the collection tree (" +
    (stats.collectionCount || 0) +
    " nodes). A paper usually sits in several at once\n" +
    "  (theme, reading date, project), so treat them as facets, not a taxonomy.\n" +
    "- `" +
    f.annotations +
    "`\n  the user's OWN highlights (" +
    (stats.annotationCount || 0) +
    "). Their `p.N` is the physical page; a\n" +
    "  trailing `(printed X)` is the number printed on the page — never cite that.\n" +
    "- `" +
    f.notes +
    "`\n  the user's OWN notes (" +
    (stats.noteCount || 0) +
    ").\n\n" +
    "Full text of every attachment is already extracted by Zotero at\n" +
    "`" +
    (library.storage || "") +
    "/<attachmentKey>/.zotero-ft-cache`. Search it:\n\n" +
    "```\n" +
    "rg -i --hidden -l -g '.zotero-ft-cache' '<pattern>' " +
    (library.storage || "") +
    "\n" +
    "```\n\n" +
    "Both flags are mandatory: `--hidden` because the cache is a dot-file (rg\n" +
    "matches nothing without it), and `-i` because case-sensitive search was\n" +
    "measured to miss 14% of matching papers. A hit gives an attachment key —\n" +
    "grep it in the catalog to learn which paper it is.\n\n" +
    "That cache is ONE FLAT BLOB with no page markers: use it to FIND a paper,\n" +
    "never to derive a page number. When referring to another paper, name it by\n" +
    'title (and key) in prose — the clickable `[p.N "quote"]` citation form is\n' +
    "reserved for THIS paper and would not resolve for any other.\n"
  );
}

export function buildAgentInstructions(
  title,
  pdfPath,
  pageTextPath,
  pageCount,
  library,
) {
  var source;
  var pageRule;
  if (pageTextPath) {
    source =
      "The plugin has already extracted and indexed every physical PDF page at:\n" +
      "  " +
      pageTextPath +
      "\n\n" +
      "Read that page-indexed text as the PRIMARY paper source. Every physical\n" +
      "page starts with an explicit marker such as:\n\n" +
      "    " +
      PAGE_HEADER_PREFIX +
      "7>>>\n\n" +
      "The number in that marker is authoritative. Use it literally for citations;\n" +
      "NEVER count form-feeds, infer a page from nearby content, or use the page\n" +
      "number printed in the paper. This index contains " +
      pageCount +
      " physical pages.\n\n" +
      "If the indexed extraction is genuinely unreadable, you may inspect the\n" +
      "original PDF with `pdftotext -layout -f N -l N`, but still treat N as the\n" +
      "1-based physical PDF page.\n";
    pageRule =
      "- N is the PHYSICAL PDF page (1-based) copied from the explicit marker on\n" +
      "  the SAME page as the quote. Never estimate N or use a printed page number.\n";
  } else {
    source =
      "Read the PDF with `pdftotext` (preserve layout), preferably in one pass:\n\n" +
      '    pdftotext -layout "' +
      pdfPath +
      '" -\n\n' +
      "Pages are separated by form-feed (^L, 0x0C): text before the first ^L is\n" +
      "physical page 1, before the second is page 2, etc. Do not confuse this with\n" +
      "the page number printed in the paper.\n";
    pageRule =
      "- N is the PHYSICAL PDF page (1-based, counted from form-feeds) — NOT the\n" +
      "  printed page number. Verify uncertain pages with `pdftotext -f N -l N`.\n";
  }

  return (
    "# Reading assistant scope\n\n" +
    "You are helping the user read and understand ONE specific paper:\n\n" +
    "**" +
    title +
    "**\n\n" +
    "The paper's PDF is on disk at:\n" +
    "  " +
    pdfPath +
    "\n\n" +
    source +
    "\nAnswer questions about THIS paper. Be concise and precise; refer to section\n" +
    "or equation names when relevant. You may use web search for related work,\n" +
    "definitions, or cited papers. Do not modify any files.\n\n" +
    "## Read efficiently (avoid being slow)\n\n" +
    "Read the whole indexed paper in one pass when practical. Do NOT repeatedly\n" +
    "extract or re-read it page by page.\n\n" +
    "## Cite the paper\n\n" +
    "After a KEY claim about THIS paper, add a citation in this format:\n\n" +
    '    [p.N "short verbatim quote"]\n\n' +
    pageRule +
    "- The quote is 12-25 words copied VERBATIM from ONE physical PDF page (no\n" +
    "  paraphrase/translation). Choose a distinctive passage that uniquely locates\n" +
    "  the claim on that page; it is shown in chat and clicked to highlight the text.\n" +
    "- Cite the MAIN claims; you need NOT cite every sentence.\n" +
    buildLibrarySection(library)
  );
}

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

// Returns { workdir, pdfPath, key, title, … } or throws with a user-facing
// message. opts.libraryAccess additionally exposes the whole library (see
// buildLibrarySection); it is a pref because it widens what the agent — and
// therefore the CLI's provider — can read from one paper to every paper.
export async function prepareWorkdir(item, opts) {
  var att = await resolvePdfAttachment(item);
  if (!att) throw new Error("No PDF attachment found for this item.");
  var pdfPath = await att.getFilePathAsync();
  if (!pdfPath)
    throw new Error("The PDF file is not available locally for this item.");

  var key = att.key;
  var workdir = PathUtils.join(pluginDataDir(), "work", key);
  await IOUtils.makeDirectory(workdir, {
    ignoreExisting: true,
    createAncestors: true,
  });

  var title = titleOf(item) || "this paper";
  var pageIndex = null;
  try {
    pageIndex = await ensurePdfTextIndex(pdfPath, workdir);
  } catch (e) {
    // Keep the previous direct-pdftotext workflow available if indexing fails.
    // The chat remains usable, but response citations will be marked unverified.
    try {
      Zotero.debug("[PaperReadingAgent] PDF page index unavailable: " + e);
    } catch (e2) {}
  }
  var library = null;
  if (opts && opts.libraryAccess) {
    try {
      // the panel re-mounts on every item switch; rebuilding walks every item,
      // so reuse a recent snapshot instead of paying for it each time
      library = await ensureLibrarySnapshot({ maxAgeMs: 60000 });
    } catch (e) {
      // the paper chat must still work if the library snapshot fails
      try {
        Zotero.debug("[PaperReadingAgent] library snapshot unavailable: " + e);
      } catch (e2) {}
    }
  }

  var agents = buildAgentInstructions(
    title,
    pdfPath,
    pageIndex && pageIndex.textPath,
    pageIndex && pageIndex.pageCount,
    library,
  );
  // one instruction file per backend convention (AGENTS.md, CLAUDE.md), same content
  var files = instructionFiles();
  for (var i = 0; i < files.length; i++) {
    await IOUtils.writeUTF8(PathUtils.join(workdir, files[i]), agents);
  }

  return {
    workdir: workdir,
    pdfPath: pdfPath,
    key: key,
    title: title,
    attachmentID: att.id,
    pageTextPath: pageIndex && pageIndex.textPath,
    pageCount: pageIndex && pageIndex.pageCount,
    library: library,
  };
}
