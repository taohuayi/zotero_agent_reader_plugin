// @ts-nocheck
/*
 * libraryContext.ts — build a LIBRARY-scoped snapshot for the resident agent.
 *
 * itemContext.ts prepares one paper; this prepares the whole library. The agent
 * never reads Zotero's sqlite (it is exclusively locked while Zotero runs, and
 * its schema is internal), so the plugin exports what the agent needs as plain
 * files into a library workdir:
 *
 *   LIBRARY.md       instructions + the search strategy
 *   catalog.tsv      one row per regular item: key, year, type, title, authors,
 *                    collection paths, ATTACHMENT KEYS
 *   collections.md   the collection tree, indented, with per-node item counts
 *   annotations.md   the user's own highlights/notes-on-PDF, grouped by paper
 *   notes.md         the user's note items, grouped by paper
 *   .snapshot.json   signature + counts, for cache invalidation
 *
 * The attachment-key column is load-bearing: full-text search happens over
 * Zotero's OWN extraction cache (`storage/<attachmentKey>/.zotero-ft-cache`),
 * whose only identifier is that key. Without the column the agent can find a
 * hit and still not know which paper it belongs to.
 *
 * VERIFIED on a real library (2026-07-25, codex 0.144.1): codex's read-only
 * sandbox can list AND read files outside its cwd while writes stay blocked, so
 * the agent reads the storage tree with no sandbox relaxation.
 *
 * Everything below the "Zotero-facing" banner touches privileged globals; the
 * formatters above it are pure and unit-tested in test/libraryContext.test.mjs.
 */

export var SNAPSHOT_VERSION = 1;
export var CATALOG_FILENAME = "catalog.tsv";
export var COLLECTIONS_FILENAME = "collections.md";
export var ANNOTATIONS_FILENAME = "annotations.md";
export var NOTES_FILENAME = "notes.md";
export var INSTRUCTIONS_FILENAME = "LIBRARY.md";
export var SNAPSHOT_META_FILENAME = ".snapshot.json";

export var CATALOG_COLUMNS = [
  "key",
  "year",
  "type",
  "title",
  "creators",
  "collections",
  "attachments",
];

// ---------------------------------------------------------------------------
// Pure formatting helpers (no Zotero/Gecko globals — keep it that way)
// ---------------------------------------------------------------------------

// TSV is line- and tab-delimited, so a title containing either would silently
// shift every column after it. Collapse both to a single space.
export function escapeCell(value) {
  return String(value == null ? "" : value)
    .replace(/[\t\r\n]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// "Vaswani" / "Vaswani & Shazeer" / "Vaswani et al." — enough to recognise a
// paper at a glance without spending catalog bytes on full author lists.
export function formatCreators(creators) {
  if (!Array.isArray(creators) || !creators.length) return "";
  var names = [];
  for (var i = 0; i < creators.length && names.length < 2; i++) {
    var c = creators[i] || {};
    // fieldMode 1 = single-field name (an institution): lastName holds it whole
    var name = c.fieldMode === 1 ? c.lastName : c.lastName || c.firstName || "";
    name = escapeCell(name);
    if (name) names.push(name);
  }
  if (!names.length) return "";
  if (creators.length > 2) return names[0] + " et al.";
  return names.join(" & ");
}

// Zotero date fields are free-form ("2017-06-12", "June 2017", "2017"), so pull
// the first plausible year rather than parsing a date.
export function yearOf(dateField) {
  var m = /\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/.exec(String(dateField || ""));
  return m ? m[1] : "";
}

// collections: [{ id, key, name, parentID }] → { id: { path, depth, name } }.
// A collection whose parent is missing (deleted mid-read) is treated as a root
// so it still shows up instead of vanishing from the snapshot.
export function buildCollectionIndex(collections) {
  var byID = Object.create(null);
  (collections || []).forEach(function (c) {
    if (c && c.id != null) byID[c.id] = c;
  });
  var index = Object.create(null);
  function resolve(id, seen) {
    if (index[id]) return index[id];
    var c = byID[id];
    if (!c) return null;
    // a cyclic parent chain (corrupt data) would otherwise recurse forever
    if (seen[id]) return { path: c.name, depth: 1, name: c.name };
    seen[id] = 1;
    var entry;
    var up = c.parentID != null ? resolve(c.parentID, seen) : null;
    entry = up
      ? { path: up.path + "/" + c.name, depth: up.depth + 1, name: c.name }
      : { path: c.name, depth: 1, name: c.name };
    index[id] = entry;
    return entry;
  }
  Object.keys(byID).forEach(function (id) {
    resolve(byID[id].id, Object.create(null));
  });
  return index;
}

// An indented tree. Siblings sort by name so the file is stable across runs
// (a churning snapshot would invalidate the agent's cached reading of it).
export function formatCollectionTree(collections, counts) {
  var list = (collections || []).slice();
  var children = Object.create(null);
  var roots = [];
  list.forEach(function (c) {
    if (!c || c.id == null) return;
    if (c.parentID == null) roots.push(c);
    else {
      if (!children[c.parentID]) children[c.parentID] = [];
      children[c.parentID].push(c);
    }
  });
  // a child whose parent is absent would otherwise be dropped entirely
  var known = Object.create(null);
  list.forEach(function (c) {
    if (c && c.id != null) known[c.id] = 1;
  });
  list.forEach(function (c) {
    if (c && c.parentID != null && !known[c.parentID]) roots.push(c);
  });

  function byName(a, b) {
    return String(a.name).localeCompare(String(b.name));
  }
  var lines = [];
  function walk(node, depth) {
    var n = (counts && counts[node.id]) || 0;
    lines.push(
      new Array(depth + 1).join("  ") + "- " + node.name + "  [" + n + "]",
    );
    (children[node.id] || []).sort(byName).forEach(function (child) {
      walk(child, depth + 1);
    });
  }
  roots.sort(byName).forEach(function (r) {
    walk(r, 0);
  });
  return lines.join("\n") + (lines.length ? "\n" : "");
}

// rows: [{ key, year, type, title, creators, collections: [path], attachments: [key] }]
export function formatCatalog(rows) {
  var out = [CATALOG_COLUMNS.join("\t")];
  (rows || []).forEach(function (r) {
    out.push(
      [
        escapeCell(r.key),
        escapeCell(r.year),
        escapeCell(r.type),
        escapeCell(r.title),
        escapeCell(r.creators),
        (r.collections || []).map(escapeCell).join(" ; "),
        (r.attachments || []).map(escapeCell).join(","),
      ].join("\t"),
    );
  });
  return out.join("\n") + "\n";
}

// Zotero notes are HTML. There is no DOM in the unit tests (and none worth
// spinning up here), so strip structurally: block tags become newlines, the
// rest is dropped, then entities are decoded.
export function htmlToText(html) {
  var text = String(html == null ? "" : html);
  text = text.replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, "\n");
  text = text.replace(/<[^>]*>/g, "");
  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, "&");
  return text
    .split("\n")
    .map(function (line) {
      return line.replace(/[ \t]+/g, " ").trim();
    })
    .filter(function (line, i, all) {
      return line || (i > 0 && all[i - 1]); // collapse runs of blank lines
    })
    .join("\n")
    .trim();
}

// A Zotero annotation carries TWO different page numbers and confusing them
// produces wrong citations: `annotationPageLabel` is the page PRINTED on the
// page (a journal article can start at 1225), while `annotationPosition.pageIndex`
// is the 0-based PHYSICAL page — the one LIBRARY.md requires for citations.
// Return the physical page and keep the printed label only as a hint.
export function annotationPages(annotation) {
  annotation = annotation || {};
  var physical = null;
  try {
    var pos =
      typeof annotation.annotationPosition === "string"
        ? JSON.parse(annotation.annotationPosition)
        : annotation.annotationPosition;
    if (pos && typeof pos.pageIndex === "number" && pos.pageIndex >= 0)
      physical = pos.pageIndex + 1;
  } catch (e) {
    /* unparseable position: fall back to no physical page */
  }
  var label = String(annotation.annotationPageLabel || "").trim();
  return { page: physical, pageLabel: label };
}

// entries: [{ itemKey, itemTitle, page, pageLabel, type, text, comment }] — grouped under
// one heading per paper so the agent can cite "your own highlight on p.N".
export function formatAnnotations(entries) {
  var groups = [];
  var byKey = Object.create(null);
  (entries || []).forEach(function (a) {
    if (!a) return;
    var k = a.itemKey || "(unfiled)";
    if (!byKey[k]) {
      byKey[k] = { key: k, title: a.itemTitle || "", items: [] };
      groups.push(byKey[k]);
    }
    byKey[k].items.push(a);
  });
  var out = [];
  groups.forEach(function (g) {
    out.push("## " + (g.title || "(untitled)") + "  [" + g.key + "]");
    g.items.forEach(function (a) {
      var page = a.page ? "p." + escapeCell(a.page) : "p.?";
      // surface the printed label only when it disagrees, so the agent can see
      // the difference instead of silently citing a printed number as physical
      var label = escapeCell(a.pageLabel);
      if (label && label !== String(a.page || ""))
        page += " (printed " + label + ")";
      var body = escapeCell(a.text);
      var line = "- " + page + " " + (a.type || "highlight") + ": ";
      line += body ? '"' + body + '"' : "(no text)";
      var comment = escapeCell(a.comment);
      if (comment) line += "  — note: " + comment;
      out.push(line);
    });
    out.push("");
  });
  return out.join("\n");
}

// entries: [{ itemKey, itemTitle, text }]
export function formatNotes(entries) {
  var out = [];
  (entries || []).forEach(function (n) {
    if (!n) return;
    out.push(
      "## " + (n.itemTitle || "(standalone note)") + "  [" + n.itemKey + "]",
    );
    out.push(n.text || "");
    out.push("");
  });
  return out.join("\n");
}

export function snapshotSignature(stats) {
  stats = stats || {};
  return {
    version: SNAPSHOT_VERSION,
    itemCount: stats.itemCount || 0,
    collectionCount: stats.collectionCount || 0,
    annotationCount: stats.annotationCount || 0,
    noteCount: stats.noteCount || 0,
    maxDateModified: stats.maxDateModified || "",
  };
}

export function sameSignature(a, b) {
  if (!a || !b) return false;
  var keys = Object.keys(snapshotSignature({}));
  for (var i = 0; i < keys.length; i++) {
    if (a[keys[i]] !== b[keys[i]]) return false;
  }
  return true;
}

// The instruction file. Two lessons are baked in as hard rules because both
// were measured, not guessed:
//   - `rg` skips dot-files by default, and .zotero-ft-cache IS one → --hidden
//   - case-sensitive search missed 14% of the matching papers → -i
export function buildLibraryInstructions(stats, storageDir) {
  stats = stats || {};
  return (
    "# Your Zotero library\n\n" +
    "You are a resident research assistant with READ-ONLY access to this\n" +
    "user's entire Zotero library. Answer from the library; never modify it.\n\n" +
    "## What is in this directory\n\n" +
    "- `" +
    CATALOG_FILENAME +
    "` — every item, one per line, tab-separated:\n" +
    "  `" +
    CATALOG_COLUMNS.join("` / `") +
    "`.\n" +
    "  " +
    (stats.itemCount || 0) +
    " items. The `attachments` column holds ATTACHMENT KEYS — the bridge to\n" +
    "  full text (see below). `collections` holds full slash-separated paths.\n" +
    "- `" +
    COLLECTIONS_FILENAME +
    "` — the collection tree (" +
    (stats.collectionCount || 0) +
    " nodes), indented, `[n]` = items directly in that node.\n" +
    "- `" +
    ANNOTATIONS_FILENAME +
    "` — the user's OWN highlights (" +
    (stats.annotationCount || 0) +
    "), grouped by paper. Their\n" +
    "  `p.N` is already the PHYSICAL page and is safe to cite; a trailing\n" +
    "  `(printed X)` is the number printed on that page — never cite that one.\n" +
    "- `" +
    NOTES_FILENAME +
    "` — the user's OWN notes (" +
    (stats.noteCount || 0) +
    "), grouped by paper.\n\n" +
    "Read the catalog and the collection tree first — together they are small\n" +
    "enough to hold in full, and they tell you what exists without searching.\n\n" +
    "## Full-text search (breadth)\n\n" +
    "Zotero has already extracted the plain text of every attachment to\n" +
    "`" +
    storageDir +
    "/<attachmentKey>/.zotero-ft-cache`.\n" +
    "Search it directly — this is fast (tens of milliseconds over the whole\n" +
    "library), so prefer searching over guessing:\n\n" +
    "```\n" +
    "rg -i --hidden -l -g '.zotero-ft-cache' '<pattern>' " +
    storageDir +
    "\n" +
    "```\n\n" +
    "RULES — both flags are mandatory:\n" +
    "- `--hidden` — `.zotero-ft-cache` is a dot-file; without it rg silently\n" +
    "  matches NOTHING and the library looks empty.\n" +
    "- `-i` — case-sensitive search was measured to miss 14% of matching papers.\n\n" +
    "A hit gives you a path containing an ATTACHMENT KEY. Map it back to the\n" +
    "paper by grepping that key in `" +
    CATALOG_FILENAME +
    "`.\n\n" +
    "Search terms: the cache is literal text, so try synonyms, abbreviations\n" +
    "and spelled-out forms (e.g. `contrastive`, `SimCLR`, `InfoNCE`) rather\n" +
    "than a single phrase, and report what you actually searched.\n\n" +
    "## Reading a paper closely (depth)\n\n" +
    "The extraction cache has NO page markers — it is one flat text blob, so it\n" +
    "can locate a paper but can NEVER be used to derive a page number. To read\n" +
    "or cite a specific paper, use the PDF itself:\n\n" +
    "```\n" +
    "pdftotext -layout <pdf> -\n" +
    "```\n\n" +
    "Pages are separated by form-feed (^L, 0x0C): text before the first ^L is\n" +
    "physical page 1, and so on.\n\n" +
    "## Citing\n\n" +
    "After a key claim, cite it as:\n\n" +
    '    [@<itemKey> p.N "short verbatim quote"]\n\n' +
    "- `<itemKey>` is the `key` column of " +
    CATALOG_FILENAME +
    " (the PAPER, not\n" +
    "  the attachment).\n" +
    "- N is the PHYSICAL PDF page (1-based), never a printed page number, and\n" +
    "  never inferred from the extraction cache.\n" +
    "- The quote is 12-25 words copied verbatim from that page.\n" +
    "- When you are drawing on the user's OWN highlight, say so explicitly.\n\n" +
    "## Scope\n\n" +
    "Be concise and precise. Never fabricate a paper: if it is not in\n" +
    CATALOG_FILENAME +
    ", say the library does not contain it. Do not modify\n" +
    "any file — the sandbox is read-only and write attempts will fail.\n"
  );
}

// ---------------------------------------------------------------------------
// Zotero-facing (privileged chrome only, from here down)
// ---------------------------------------------------------------------------

function libraryDataDir() {
  return PathUtils.join(
    Zotero.DataDirectory.dir,
    "paper-reading-agent",
    "library",
  );
}

export function storageDir() {
  return PathUtils.join(Zotero.DataDirectory.dir, "storage");
}

// Gather everything the formatters need as PLAIN data, so the shape can be
// asserted in tests and inspected from the Run JavaScript console.
export async function collectLibrary(libraryID) {
  if (libraryID == null) libraryID = Zotero.Libraries.userLibraryID;

  var collections = Zotero.Collections.getByLibrary(libraryID, true) || [];
  var collectionData = [];
  var counts = Object.create(null);
  collections.forEach(function (c) {
    collectionData.push({
      id: c.id,
      key: c.key,
      name: c.name,
      parentID: c.parentID == null ? null : c.parentID,
    });
    var n = 0;
    try {
      n = (c.getChildItems(true) || []).length;
    } catch (e) {
      /* a collection can disappear mid-read; count it as empty */
    }
    counts[c.id] = n;
  });
  var collectionIndex = buildCollectionIndex(collectionData);

  var all = (await Zotero.Items.getAll(libraryID, true, false)) || [];
  var rows = [];
  var annotations = [];
  var notes = [];
  var maxDateModified = "";

  for (var i = 0; i < all.length; i++) {
    var item = all[i];
    try {
      if (item.dateModified && item.dateModified > maxDateModified)
        maxDateModified = item.dateModified;

      // standalone notes are top-level but are not papers
      if (item.isNote && item.isNote()) {
        notes.push({
          itemKey: item.key,
          itemTitle: "",
          text: htmlToText(item.getNote()),
        });
        continue;
      }
      if (!item.isRegularItem || !item.isRegularItem()) continue;

      var title = item.getDisplayTitle ? item.getDisplayTitle() : "";
      var paths = [];
      (item.getCollections() || []).forEach(function (cid) {
        var entry = collectionIndex[cid];
        if (entry) paths.push(entry.path);
      });
      paths.sort();

      var attachmentKeys = [];
      var attachmentIDs = item.getAttachments() || [];
      for (var a = 0; a < attachmentIDs.length; a++) {
        var att = Zotero.Items.get(attachmentIDs[a]);
        if (!att) continue;
        attachmentKeys.push(att.key);
        var anns = [];
        try {
          anns = att.getAnnotations() || [];
        } catch (e) {
          /* not every attachment type supports annotations */
        }
        for (var n2 = 0; n2 < anns.length; n2++) {
          var ann = anns[n2];
          var pages = annotationPages(ann);
          annotations.push({
            itemKey: item.key,
            itemTitle: title,
            attachmentKey: att.key,
            page: pages.page,
            pageLabel: pages.pageLabel,
            type: ann.annotationType || "highlight",
            text: ann.annotationText || "",
            comment: ann.annotationComment || "",
          });
        }
      }

      (item.getNotes() || []).forEach(function (nid) {
        var note = Zotero.Items.get(nid);
        if (!note) return;
        notes.push({
          itemKey: item.key,
          itemTitle: title,
          text: htmlToText(note.getNote()),
        });
      });

      rows.push({
        key: item.key,
        year: yearOf(item.getField("date")),
        type: item.itemType || "",
        title: title,
        creators: formatCreators(item.getCreators()),
        collections: paths,
        attachments: attachmentKeys,
      });
    } catch (e) {
      // one broken item must never abort the whole snapshot
      try {
        Zotero.debug("[PaperReadingAgent] library item skipped: " + e);
      } catch (e2) {}
    }
  }

  rows.sort(function (x, y) {
    return String(x.title).localeCompare(String(y.title));
  });

  return {
    rows: rows,
    collections: collectionData,
    collectionCounts: counts,
    annotations: annotations,
    notes: notes,
    stats: {
      itemCount: rows.length,
      collectionCount: collectionData.length,
      annotationCount: annotations.length,
      noteCount: notes.length,
      maxDateModified: maxDateModified,
    },
  };
}

function runtimeDeps() {
  return {
    join: function (...parts) {
      return PathUtils.join(...parts);
    },
    exists: function (path) {
      return IOUtils.exists(path);
    },
    readUTF8: function (path) {
      return IOUtils.readUTF8(path);
    },
    writeUTF8: function (path, value) {
      return IOUtils.writeUTF8(path, value);
    },
    makeDirectory: function (path) {
      return IOUtils.makeDirectory(path, {
        ignoreExisting: true,
        createAncestors: true,
      });
    },
    collect: collectLibrary,
    storageDir: storageDir,
  };
}

// Deciding whether the snapshot is stale means walking every item, which is the
// expensive part (~40ms on a 456-item library). The chat panel re-mounts on
// every item switch, so remember the last build and skip re-walking within
// opts.maxAgeMs. Cleared by force, and by resetSnapshotCache() in tests.
var LAST_BUILD = null; // { at, workdir, result }
export function resetSnapshotCache() {
  LAST_BUILD = null;
}

// Build (or reuse) the library snapshot. Returns { workdir, files, stats,
// cached }. opts.force rebuilds even when the signature is unchanged; opts.deps
// is injectable so the whole flow can run under Node in tests.
export async function ensureLibrarySnapshot(opts) {
  opts = opts || {};
  var deps = opts.deps || runtimeDeps();
  var workdir = opts.workdir || libraryDataDir();
  var now = opts.now ? opts.now() : Date.now();
  var maxAge = opts.maxAgeMs || 0;
  if (
    !opts.force &&
    maxAge > 0 &&
    LAST_BUILD &&
    LAST_BUILD.workdir === workdir &&
    now - LAST_BUILD.at < maxAge
  ) {
    return LAST_BUILD.result;
  }
  await deps.makeDirectory(workdir);

  var metaPath = deps.join(workdir, SNAPSHOT_META_FILENAME);
  var data = await deps.collect(opts.libraryID);
  var signature = snapshotSignature(data.stats);

  if (!opts.force) {
    try {
      if (await deps.exists(metaPath)) {
        var meta = JSON.parse(await deps.readUTF8(metaPath));
        if (sameSignature(meta && meta.signature, signature)) {
          var reused = {
            workdir: workdir,
            files: meta.files,
            storage: meta.storage,
            stats: data.stats,
            cached: true,
          };
          LAST_BUILD = { at: now, workdir: workdir, result: reused };
          return reused;
        }
      }
    } catch (e) {
      // unreadable/corrupt meta: fall through and rewrite
    }
  }

  var storage = deps.storageDir();
  var files = {};
  files.catalog = deps.join(workdir, CATALOG_FILENAME);
  files.collections = deps.join(workdir, COLLECTIONS_FILENAME);
  files.annotations = deps.join(workdir, ANNOTATIONS_FILENAME);
  files.notes = deps.join(workdir, NOTES_FILENAME);
  files.instructions = deps.join(workdir, INSTRUCTIONS_FILENAME);

  await deps.writeUTF8(files.catalog, formatCatalog(data.rows));
  await deps.writeUTF8(
    files.collections,
    formatCollectionTree(data.collections, data.collectionCounts),
  );
  await deps.writeUTF8(files.annotations, formatAnnotations(data.annotations));
  await deps.writeUTF8(files.notes, formatNotes(data.notes));
  await deps.writeUTF8(
    files.instructions,
    buildLibraryInstructions(data.stats, storage),
  );
  await deps.writeUTF8(
    metaPath,
    JSON.stringify({ signature: signature, files: files, storage: storage }),
  );

  var built = {
    workdir: workdir,
    files: files,
    storage: storage,
    stats: data.stats,
    cached: false,
  };
  LAST_BUILD = { at: now, workdir: workdir, result: built };
  return built;
}
