// @ts-nocheck
/*
 * pdfTextIndex.ts — build and cache a deterministic, physical-page-labelled
 * text view of a PDF.
 *
 * The model used to infer page numbers by manually counting pdftotext form-feed
 * characters.  That is inherently error-prone.  This module performs the split
 * in plugin code and writes a read-only source where every page starts with an
 * explicit, 1-based marker.  The same page array is used after a turn to verify
 * citation quotes, so generation and validation share one physical-page model.
 */
import { resolveBinary } from "./codexEnv";

export var PAGE_TEXT_FILENAME = "paper-physical-pages.txt";
export var PAGE_META_FILENAME = "paper-physical-pages.meta.json";
export var PAGE_INDEX_VERSION = 2;
export var PAGE_HEADER_PREFIX = "<<<PRA_PHYSICAL_PDF_PAGE:";

var IN_FLIGHT = Object.create(null);

function normalizeNewlines(value) {
  return String(value == null ? "" : value).replace(/\r\n?/g, "\n");
}

// pdftotext emits one form-feed after each physical page, normally including
// the last page.  Remove exactly one terminal separator artifact while retaining
// real blank pages ("page one\f\f" => ["page one", ""]).
export function splitPdfTextPages(value) {
  var pages = normalizeNewlines(value).split("\f");
  if (pages.length > 1 && pages[pages.length - 1].trim() === "") pages.pop();
  return pages.length ? pages : [""];
}

export function physicalPageHeader(page) {
  return PAGE_HEADER_PREFIX + page + ">>>";
}

export function formatPhysicalPageText(pages) {
  pages = Array.isArray(pages) && pages.length ? pages : [""];
  return pages
    .map(function (page, index) {
      return physicalPageHeader(index + 1) + "\n" + normalizeNewlines(page);
    })
    .join("\f\n");
}

// Strict parser: cache corruption or a missing/out-of-order marker invalidates
// the file instead of silently shifting every page that follows it.
export function parsePhysicalPageText(value) {
  var chunks = normalizeNewlines(value).split("\f");
  var pages = [];
  for (var i = 0; i < chunks.length; i++) {
    // v2 puts every marker at a true line start so CLI readers and anchored
    // searches can see all pages. Accept v1 as well; metadata versioning still
    // forces regeneration so normal users receive the clearer v2 format.
    var chunk = chunks[i];
    if (i > 0 && chunk[0] === "\n") chunk = chunk.slice(1);
    var expected = physicalPageHeader(i + 1);
    if (chunk.slice(0, expected.length) !== expected) return null;
    var rest = chunk.slice(expected.length);
    if (rest[0] === "\n") rest = rest.slice(1);
    else if (rest) return null;
    pages.push(rest);
  }
  return pages.length ? pages : null;
}

function scalarTime(value) {
  if (value && typeof value.getTime === "function") return value.getTime();
  return value == null ? null : value;
}

function signature(pdfPath, stat) {
  if (!stat) return null;
  return {
    pdfPath: String(pdfPath),
    size: stat.size == null ? null : stat.size,
    lastModified: scalarTime(stat.lastModified),
  };
}

function sameSignature(a, b) {
  return !!(
    a &&
    b &&
    a.pdfPath === b.pdfPath &&
    a.size === b.size &&
    a.lastModified === b.lastModified
  );
}

async function readPipe(pipe) {
  var out = "";
  if (!pipe || typeof pipe.readString !== "function") return out;
  var chunk;
  while ((chunk = await pipe.readString())) out += chunk;
  return out;
}

async function extractWithPdfToText(pdfPath) {
  var Subprocess = ChromeUtils.importESModule(
    "resource://gre/modules/Subprocess.sys.mjs",
  ).Subprocess;
  var resolved = await resolveBinary("pdftotext", null, {}, {});
  var proc = await Subprocess.call({
    command: resolved.command,
    arguments: ["-layout", pdfPath, "-"],
    environment: resolved.env,
    environmentAppend: true,
    stderr: "pipe",
  });
  try {
    proc.stdin.close();
  } catch (e) {}

  var timedOut = false;
  var timer = setTimeout(function () {
    timedOut = true;
    try {
      proc.kill();
    } catch (e) {}
  }, 30000);

  try {
    // Drain both pipes while waiting; a full stderr pipe must never deadlock a
    // large stdout extraction.
    var values = await Promise.all([
      readPipe(proc.stdout),
      readPipe(proc.stderr),
      proc.wait(),
    ]);
    if (timedOut) throw new Error("pdftotext timed out after 30s");
    var result = values[2] || {};
    if (result.exitCode !== 0) {
      throw new Error(
        "pdftotext exited " +
          result.exitCode +
          (values[1] ? ": " + String(values[1]).trim().slice(-400) : ""),
      );
    }
    return values[0];
  } finally {
    try {
      clearTimeout(timer);
    } catch (e) {}
  }
}

function runtimeDeps() {
  return {
    join: function () {
      return PathUtils.join.apply(PathUtils, arguments);
    },
    stat: function (path) {
      return IOUtils.stat(path);
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
    extract: extractWithPdfToText,
  };
}

async function ensureImpl(pdfPath, workdir, deps) {
  var textPath = deps.join(workdir, PAGE_TEXT_FILENAME);
  var metaPath = deps.join(workdir, PAGE_META_FILENAME);
  var stat = null;
  try {
    stat = await deps.stat(pdfPath);
  } catch (e) {
    // Extraction can still work, but without a trustworthy source signature we
    // deliberately do not reuse a possibly stale disk cache.
  }
  var source = signature(pdfPath, stat);

  if (source) {
    try {
      if ((await deps.exists(textPath)) && (await deps.exists(metaPath))) {
        var meta = JSON.parse(await deps.readUTF8(metaPath));
        if (
          meta.version === PAGE_INDEX_VERSION &&
          sameSignature(meta.source, source)
        ) {
          var cachedPages = parsePhysicalPageText(
            await deps.readUTF8(textPath),
          );
          if (cachedPages && cachedPages.length === meta.pageCount) {
            return {
              pages: cachedPages,
              pageCount: cachedPages.length,
              textPath: textPath,
              cached: true,
            };
          }
        }
      }
    } catch (e) {
      // Malformed/missing cache: regenerate below.
    }
  }

  var raw = await deps.extract(pdfPath);
  var pages = splitPdfTextPages(raw);
  var labelled = formatPhysicalPageText(pages);
  await deps.writeUTF8(textPath, labelled);
  await deps.writeUTF8(
    metaPath,
    JSON.stringify({
      version: PAGE_INDEX_VERSION,
      source: source,
      pageCount: pages.length,
    }),
  );
  return {
    pages: pages,
    pageCount: pages.length,
    textPath: textPath,
    cached: false,
  };
}

// opts.deps is intentionally injectable so cache invalidation and concurrency
// can be tested under Node without privileged Zotero globals.
export function ensurePdfTextIndex(pdfPath, workdir, opts) {
  opts = opts || {};
  var deps = opts.deps || runtimeDeps();
  var key = String(pdfPath) + "\n" + String(workdir);
  if (IN_FLIGHT[key]) return IN_FLIGHT[key];
  var promise = ensureImpl(pdfPath, workdir, deps);
  IN_FLIGHT[key] = promise;
  promise.then(
    function () {
      if (IN_FLIGHT[key] === promise) delete IN_FLIGHT[key];
    },
    function () {
      if (IN_FLIGHT[key] === promise) delete IN_FLIGHT[key];
    },
  );
  return promise;
}

export async function loadPdfTextIndexPages(textPath, opts) {
  opts = opts || {};
  var deps = opts.deps || runtimeDeps();
  var pages = parsePhysicalPageText(await deps.readUTF8(textPath));
  if (!pages) throw new Error("invalid cached physical-page text index");
  return pages;
}
