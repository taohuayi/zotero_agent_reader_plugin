// @ts-nocheck
/*
 * referenceResolver.ts — parse model citation markers and resolve their exact
 * location in Zotero's PDF reader.
 *
 * The model supplies only a physical page plus a verbatim quote. Coordinates
 * must never come from the model: Zotero's parsed page characters and native
 * range-to-rectangle conversion produce the same { pageIndex, rects } coordinate
 * system used by Reader.navigate(). Private Reader fields are feature-detected
 * and isolated here; callers retain page-only navigation as a compatibility
 * fallback.
 */

var CITE_RE =
  /\[pp?\.?\s*(\d{1,4})(?:\s*[-–—]\s*\d{1,4})?\s*(?:(?:["“]([^"”\]]{1,400})["”])|(?:['‘]([^'’\]]{1,400})['’]))?\s*\]/g;

export function referenceToken(i) {
  return "PRAREF" + i + "ENDPRAREF";
}

// Pull markers out before Markdown/math rendering. A fresh RegExp is used on
// every call so the global lastIndex can never leak across streaming renders.
export function pullCitationMarkers(source) {
  var citations = [];
  var re = new RegExp(CITE_RE.source, "g");
  var text = String(source == null ? "" : source).replace(
    re,
    function (match, page, doubleQuote, singleQuote) {
      var i = citations.length;
      citations.push({
        page: parseInt(page, 10),
        quote: doubleQuote || singleQuote || "",
      });
      return referenceToken(i);
    },
  );
  return { text: text, citations: citations };
}

export function normalizeReferenceQuote(value) {
  var text = String(value == null ? "" : value);
  try {
    text = text.normalize("NFKC");
  } catch (e) {
    /* older JS engines: keep the original string */
  }
  return text
    .replace(/[\u00ad\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Exact/long candidates come first. Shorter candidates are only fallbacks for
// PDFs whose text layer differs around ligatures, punctuation, or line breaks.
export function buildReferenceQuoteCandidates(value) {
  var out = [];
  function add(candidate) {
    candidate = normalizeReferenceQuote(candidate);
    if (candidate && out.indexOf(candidate) < 0) out.push(candidate);
  }

  var base = normalizeReferenceQuote(value);
  add(base);

  var punctuation = base
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[‐‑‒–—−]/g, "-");
  add(punctuation);

  // Join a word broken at a PDF line boundary ("sample- efficient").
  var dehyphenated = punctuation.replace(
    /([\p{L}\p{N}])-\s+(?=[\p{L}\p{N}])/gu,
    "$1",
  );
  add(dehyphenated);

  // PDF text layers disagree about line-end hyphens: "sample-efficiently"
  // may be exposed as "sampleefficiently" or "sample efficiently". Try each
  // word-internal hyphen independently so a genuine hyphen elsewhere (for
  // example "score-based") remains intact.
  var hyphens = [];
  for (var h = 1; h < punctuation.length - 1; h++) {
    if (punctuation[h] !== "-") continue;
    var before = punctuation[h - 1];
    var next = h + 1;
    while (punctuation[next] === " ") next++;
    var after = punctuation[next] || "";
    if (/[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after)) {
      hyphens.push({ start: h, end: next });
    }
  }
  for (var y = 0; y < hyphens.length && y < 6; y++) {
    var hp = hyphens[y];
    add(punctuation.slice(0, hp.start) + punctuation.slice(hp.end));
    add(punctuation.slice(0, hp.start) + " " + punctuation.slice(hp.end));
  }

  var words = dehyphenated.split(" ").filter(Boolean);
  if (words.length > 18) {
    add(words.slice(0, 18).join(" "));
    add(words.slice(-18).join(" "));
  }
  if (words.length > 12) add(words.slice(0, 12).join(" "));

  return out;
}

function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function validPosition(position, pageIndex) {
  return !!(
    position &&
    position.pageIndex === pageIndex &&
    Array.isArray(position.rects) &&
    position.rects.length &&
    position.rects.every(function (r) {
      return (
        Array.isArray(r) &&
        r.length >= 4 &&
        r.slice(0, 4).every(function (n) {
          return typeof n === "number" && isFinite(n);
        })
      );
    })
  );
}

function normalizeSearchPiece(value) {
  var text = String(value == null ? "" : value);
  try {
    text = text.normalize("NFKC");
  } catch (e) {}
  return text
    .replace(/[\u00ad\u200b-\u200d\ufeff]/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[‐‑‒–—−]/g, "-");
}

function canonicalSearchQuote(value) {
  return normalizeSearchPiece(value).replace(/\s+/g, " ").trim();
}

function addUnique(out, value) {
  if (value && out.indexOf(value) < 0) out.push(value);
}

// Search-only page variants.  These mirror the PDF text-layer differences
// handled by buildReferenceQuoteCandidates, but do not need coordinate maps:
// whitespace/ligatures are normalized, line-end hyphens can be joined, and a
// word-internal hyphen can be represented as hyphen / nothing / space.
function buildPageSearchHaystacks(value) {
  var source = normalizeSearchPiece(value);
  var joined = source.replace(
    /([\p{L}\p{N}])-\s*\n\s*(?=[\p{L}\p{N}])/gu,
    "$1",
  );
  var bases = [canonicalSearchQuote(source), canonicalSearchQuote(joined)];
  var out = [];
  for (var i = 0; i < bases.length; i++) {
    var base = bases[i].toLowerCase();
    addUnique(out, base);
    addUnique(out, base.replace(/([\p{L}\p{N}])-\s*(?=[\p{L}\p{N}])/gu, "$1"));
    addUnique(out, base.replace(/([\p{L}\p{N}])-\s*(?=[\p{L}\p{N}])/gu, "$1 "));
  }
  return out;
}

function occurrences(haystack, needle) {
  var count = 0;
  var from = 0;
  while (needle && from <= haystack.length - needle.length) {
    var at = haystack.indexOf(needle, from);
    if (at < 0) break;
    count++;
    from = at + Math.max(1, needle.length);
  }
  return count;
}

// Determine the 1-based physical pages containing a quote.  Candidate order is
// significant: an exact/long quote wins before progressively looser fallbacks.
export function buildReferencePageSearchIndex(pages) {
  if (!Array.isArray(pages)) return [];
  return pages.map(buildPageSearchHaystacks);
}

function findReferenceQuoteInIndex(haystacks, quote) {
  if (!Array.isArray(haystacks) || !haystacks.length || !quote) {
    return { pages: [], matchedQuote: "", matchCount: 0 };
  }
  var candidates = buildReferenceQuoteCandidates(quote);
  for (var c = 0; c < candidates.length; c++) {
    var needle = canonicalSearchQuote(candidates[c]).toLowerCase();
    if (!needle) continue;
    var matchedPages = [];
    var matchCount = 0;
    for (var p = 0; p < haystacks.length; p++) {
      var pageCount = 0;
      for (var h = 0; h < haystacks[p].length; h++) {
        pageCount = Math.max(pageCount, occurrences(haystacks[p][h], needle));
      }
      if (pageCount) {
        matchedPages.push(p + 1);
        matchCount += pageCount;
      }
    }
    if (matchedPages.length) {
      return {
        pages: matchedPages,
        matchedQuote: candidates[c],
        matchCount: matchCount,
      };
    }
  }
  return { pages: [], matchedQuote: "", matchCount: 0 };
}

export function findReferenceQuotePages(pages, quote) {
  return findReferenceQuoteInIndex(buildReferencePageSearchIndex(pages), quote);
}

function correctedMarker(page, doubleQuote, singleQuote) {
  if (doubleQuote != null) return "[p." + page + ' "' + doubleQuote + '"]';
  return "[p." + page + " '" + singleQuote + "']";
}

// Validate every model marker against deterministic per-page text.  A unique
// quote match is authoritative and rewrites a wrong page.  Ambiguous or missing
// matches are retained (never silently guessed) and surfaced through metadata.
export function verifyAndCorrectCitationPages(source, pages) {
  var checks = [];
  var pageIndex = buildReferencePageSearchIndex(pages);
  var re = new RegExp(CITE_RE.source, "g");
  var text = String(source == null ? "" : source).replace(
    re,
    function (match, page, doubleQuote, singleQuote) {
      var reportedPage = parseInt(page, 10);
      var quote = doubleQuote || singleQuote || "";
      var check = {
        reportedPage: reportedPage,
        resolvedPage: reportedPage,
        quote: quote,
        status: "page-only",
        matchedPages: [],
        matchedQuote: "",
        matchCount: 0,
      };

      if (quote) {
        var found = findReferenceQuoteInIndex(pageIndex, quote);
        check.matchedPages = found.pages;
        check.matchedQuote = found.matchedQuote;
        check.matchCount = found.matchCount;
        if (found.pages.indexOf(reportedPage) >= 0) {
          check.status = "verified";
        } else if (found.pages.length === 1) {
          check.status = "corrected";
          check.resolvedPage = found.pages[0];
        } else if (found.pages.length > 1) {
          check.status = "ambiguous";
        } else {
          check.status = "unverified";
        }
      }
      checks.push(check);
      return check.status === "corrected"
        ? correctedMarker(check.resolvedPage, doubleQuote, singleQuote)
        : match;
    },
  );

  var counts = {
    corrected: 0,
    verified: 0,
    ambiguous: 0,
    unverified: 0,
    pageOnly: 0,
  };
  checks.forEach(function (check) {
    if (check.status === "page-only") counts.pageOnly++;
    else counts[check.status]++;
  });
  return { text: text, citations: checks, counts: counts };
}

function waiveReaderXrays(value) {
  if (!value) return value;
  try {
    if (typeof Cu !== "undefined" && typeof Cu.waiveXrays === "function") {
      return Cu.waiveXrays(value);
    }
  } catch (e) {}
  try {
    if (
      typeof Components !== "undefined" &&
      Components.utils &&
      typeof Components.utils.waiveXrays === "function"
    ) {
      return Components.utils.waiveXrays(value);
    }
  } catch (e) {}
  try {
    return value.wrappedJSObject || value;
  } catch (e) {
    return value;
  }
}

function cloneIntoReader(value, anchor) {
  var utils = null;
  try {
    if (typeof Cu !== "undefined") utils = Cu;
  } catch (e) {}
  try {
    if (!utils && typeof Components !== "undefined") utils = Components.utils;
  } catch (e) {}
  try {
    if (
      utils &&
      typeof utils.getGlobalForObject === "function" &&
      typeof utils.cloneInto === "function"
    ) {
      var target = utils.getGlobalForObject(waiveReaderXrays(anchor));
      return utils.cloneInto(value, target);
    }
  } catch (e) {}
  return value;
}

function nextPageCharStartsWord(chars, index) {
  for (var i = index + 1; i < chars.length; i++) {
    var text = normalizeSearchPiece(chars[i] && chars[i].u).trim();
    if (!text) continue;
    return /^[\p{L}\p{N}]/u.test(text);
  }
  return false;
}

// Build searchable text directly from Zotero's parsed page characters while
// retaining a map back to the raw offsets expected by getMatchPositions().
// A line-ending hyphen is omitted only when the next line starts with a word,
// matching the dehyphenation readers apply to copied PDF text.
function buildPageSearchMap(chars) {
  var text = "";
  var starts = [];
  var ends = [];
  var rawOffset = 0;

  function append(value, start, end) {
    for (var i = 0; i < value.length; i++) {
      var ch = value[i];
      if (/\s/.test(ch)) {
        if (!text) continue;
        if (text[text.length - 1] === " ") {
          ends[ends.length - 1] = Math.max(ends[ends.length - 1], end);
          continue;
        }
        ch = " ";
      }
      text += ch;
      starts.push(start);
      ends.push(end);
    }
  }

  for (var c = 0; c < chars.length; c++) {
    var entry = waiveReaderXrays(chars[c]) || {};
    var raw = String(entry.u == null ? "" : entry.u);
    var pieces = Array.from(raw);
    var lastContent = pieces.length - 1;
    while (lastContent >= 0 && /^\s+$/u.test(pieces[lastContent]))
      lastContent--;
    var dehyphenate = !!(
      entry.lineBreakAfter &&
      lastContent >= 0 &&
      /^[‐‑‒–—−-]$/u.test(pieces[lastContent]) &&
      nextPageCharStartsWord(chars, c)
    );

    var localOffset = 0;
    for (var p = 0; p < pieces.length; p++) {
      var piece = pieces[p];
      var pieceStart = rawOffset + localOffset;
      localOffset += piece.length;
      if (dehyphenate && p >= lastContent) continue;
      append(normalizeSearchPiece(piece), pieceStart, rawOffset + localOffset);
    }

    rawOffset += raw.length;
    if (entry.spaceAfter || entry.lineBreakAfter || entry.paragraphBreakAfter) {
      if (!dehyphenate) append(" ", rawOffset, rawOffset + 1);
      rawOffset++;
    }
  }

  if (text[text.length - 1] === " ") {
    text = text.slice(0, -1);
    starts.pop();
    ends.pop();
  }
  return { text: text, starts: starts, ends: ends };
}

async function positionsForRawRanges(controller, pageIndex, pageData, ranges) {
  if (
    typeof controller.getMatchPositionsAsync !== "function" &&
    typeof controller.getMatchPositions !== "function"
  )
    return [];
  var matches = waiveReaderXrays(
    controller._pageMatches || controller.pageMatches,
  );
  var lengths = waiveReaderXrays(
    controller._pageMatchesLength || controller.pageMatchesLength,
  );
  if (!matches || !lengths) return [];

  var hadMatches = Object.prototype.hasOwnProperty.call(matches, pageIndex);
  var hadLengths = Object.prototype.hasOwnProperty.call(lengths, pageIndex);
  var oldMatches = matches[pageIndex];
  var oldLengths = lengths[pageIndex];
  try {
    matches[pageIndex] = cloneIntoReader(
      ranges.map(function (range) {
        return range.start;
      }),
      controller,
    );
    lengths[pageIndex] = cloneIntoReader(
      ranges.map(function (range) {
        return range.end - range.start;
      }),
      controller,
    );
    if (typeof controller.getMatchPositionsAsync === "function") {
      return (await controller.getMatchPositionsAsync(pageIndex)) || [];
    }
    return controller.getMatchPositions(pageIndex, pageData) || [];
  } finally {
    if (hadMatches) matches[pageIndex] = oldMatches;
    else delete matches[pageIndex];
    if (hadLengths) lengths[pageIndex] = oldLengths;
    else delete lengths[pageIndex];
  }
}

async function resolveFromPageCharacters(
  view,
  controller,
  pageIndex,
  candidates,
  timeoutMs,
) {
  var pdfDocument = controller && controller._pdfDocument;
  var canUseViewCache = !!(
    view &&
    typeof view._ensureBasicPageData === "function" &&
    view._pdfPages
  );
  if (
    (!canUseViewCache &&
      (!pdfDocument || typeof pdfDocument.getPageData !== "function")) ||
    (typeof controller.getMatchPositionsAsync !== "function" &&
      typeof controller.getMatchPositions !== "function")
  ) {
    return null;
  }

  var timeoutMarker = {};
  var pageData;
  try {
    var pageDataPromise = canUseViewCache
      ? Promise.resolve(view._ensureBasicPageData(pageIndex)).then(function () {
          var pages = waiveReaderXrays(view._pdfPages);
          return waiveReaderXrays(pages[pageIndex]);
        })
      : pdfDocument.getPageData({ pageIndex: pageIndex });
    pageData = await Promise.race([
      pageDataPromise,
      delay(timeoutMs).then(function () {
        return timeoutMarker;
      }),
    ]);
  } catch (e) {
    return null;
  }
  pageData = waiveReaderXrays(pageData);
  var pageChars = pageData && waiveReaderXrays(pageData.chars);
  if (
    pageData === timeoutMarker ||
    !pageData ||
    !pageChars ||
    typeof pageChars.length !== "number"
  ) {
    return null;
  }

  var mapped;
  try {
    mapped = buildPageSearchMap(pageChars);
  } catch (e) {
    return null;
  }
  var haystack = mapped.text.toLowerCase();
  for (var i = 0; i < candidates.length; i++) {
    var candidate = canonicalSearchQuote(candidates[i]);
    var needle = candidate.toLowerCase();
    if (!needle) continue;

    var ranges = [];
    var from = 0;
    while (ranges.length < 20) {
      var at = haystack.indexOf(needle, from);
      if (at < 0) break;
      var last = at + needle.length - 1;
      if (mapped.starts[at] != null && mapped.ends[last] != null) {
        ranges.push({ start: mapped.starts[at], end: mapped.ends[last] });
      }
      from = at + Math.max(1, needle.length);
    }
    if (!ranges.length) continue;

    var positions = await positionsForRawRanges(
      controller,
      pageIndex,
      pageData,
      ranges,
    );
    var valid = positions.filter(function (position) {
      return validPosition(position, pageIndex);
    });
    if (valid.length) {
      return {
        position: valid[0],
        matchedQuote: candidate,
        matchCount: valid.length,
      };
    }
  }
  return null;
}

async function submitFindState(view, controller, state) {
  if (typeof view.setFindState === "function") {
    await view.setFindState(state);
  }

  var controllerState = controller.state || controller._state;
  if (state.active) {
    // Zotero's view state and its PDF.js controller can occasionally drift
    // apart (for example after the built-in Find popup was closed). In that
    // state setFindState() updates view._findState but skips controller.find(),
    // leaving pageMatches tied to the previous query. Feature-detect and repair
    // only that mismatch; normal Reader searches still go through the view.
    if (
      typeof controller.find === "function" &&
      (!controllerState ||
        controllerState.query !== state.query ||
        controllerState.caseSensitive !== state.caseSensitive ||
        controllerState.entireWord !== state.entireWord)
    ) {
      controller.find({
        type: "find",
        query: state.query,
        phraseSearch: true,
        caseSensitive: state.caseSensitive,
        entireWord: state.entireWord,
        highlightAll: state.highlightAll,
        findPrevious: false,
      });
    }
  } else if (typeof controller.onClose === "function") {
    controller.onClose();
  }
}

async function waitForPage(controller, pageIndex, query, timeoutMs) {
  // Let PDFFindController._nextMatch clear results from the previous query.
  await delay(0);
  var deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    var state = controller.state || controller._state;
    var matches = controller.pageMatches || controller._pageMatches;
    if (
      state &&
      state.query === query &&
      controller._dirtyMatch !== true &&
      matches &&
      Object.prototype.hasOwnProperty.call(matches, pageIndex)
    ) {
      return true;
    }
    await delay(25);
  }
  return false;
}

/*
 * Resolve a quote to Zotero's native PDFPosition.
 * Returns { position, matchedQuote, matchCount } or null.
 *
 * This deliberately uses feature detection because _primaryView and
 * _findController are internal Zotero Reader fields. The public-ish boundary
 * above them — reader.navigate({ position }) — is used by the caller.
 */
export async function resolveReferencePosition(
  reader,
  pageIndex,
  quote,
  options,
) {
  options = options || {};
  if (!reader || !Number.isInteger(pageIndex) || pageIndex < 0 || !quote) {
    return null;
  }

  var internal = reader._internalReader;
  var view = internal && (internal._primaryView || internal._lastView);
  var controller = view && view._findController;
  if (!view || !controller) return null;

  var candidates = buildReferenceQuoteCandidates(quote);
  if (!candidates.length) return null;

  var timeoutMs = Math.max(250, options.timeoutMs || 3500);
  var deadline = Date.now() + timeoutMs;
  var direct = null;
  try {
    direct = await resolveFromPageCharacters(
      view,
      controller,
      pageIndex,
      candidates,
      timeoutMs,
    );
  } catch (e) {
    direct = null;
  }
  if (direct) return direct;

  if (
    typeof controller.getMatchPositionsAsync !== "function" ||
    (typeof view.setFindState !== "function" &&
      typeof controller.find !== "function")
  ) {
    return null;
  }

  var previous = view._findState
    ? Object.assign({}, view._findState)
    : {
        popupOpen: false,
        active: false,
        query: "",
        highlightAll: false,
        caseSensitive: false,
        entireWord: false,
        index: null,
        result: null,
      };
  var found = null;

  try {
    for (var i = 0; i < candidates.length; i++) {
      var remaining = deadline - Date.now();
      if (remaining <= 0) break;
      var candidate = candidates[i];
      var findState = {
        popupOpen: false,
        active: true,
        query: candidate,
        highlightAll: false,
        caseSensitive: false,
        entireWord: false,
        index: null,
        result: null,
      };

      await submitFindState(view, controller, findState);

      remaining = deadline - Date.now();
      if (remaining <= 0) break;
      if (!(await waitForPage(controller, pageIndex, candidate, remaining))) {
        continue;
      }
      var positions = await controller.getMatchPositionsAsync(pageIndex);
      for (var p = 0; p < positions.length; p++) {
        if (validPosition(positions[p], pageIndex)) {
          found = {
            position: positions[p],
            matchedQuote: candidate,
            matchCount: positions.length,
          };
          break;
        }
      }
      if (found) break;
    }
  } finally {
    try {
      await submitFindState(view, controller, previous);
    } catch (e) {
      try {
        if (typeof controller.onClose === "function") controller.onClose();
      } catch (e2) {
        /* ignore cleanup failure */
      }
    }
  }

  return found;
}

// Defensive click-time fallback for answers produced without a usable cached
// page index (or for legacy stored conversations).  Search the reported page
// first, then nearby pages under one total timeout budget.  The actual position's
// pageIndex is returned so callers can correct the visible chip immediately.
export async function resolveReferenceNearPage(
  reader,
  pageIndex,
  quote,
  options,
) {
  options = options || {};
  if (!reader || !Number.isInteger(pageIndex) || pageIndex < 0 || !quote) {
    return null;
  }
  var radius = Math.max(
    0,
    Math.min(4, options.neighborRadius == null ? 1 : options.neighborRadius),
  );
  var order = [pageIndex];
  for (var distance = 1; distance <= radius; distance++) {
    // Check the following page first: omitted cover/blank pages most often make
    // a model under-report the physical page, as in cited p.5 → actual p.6.
    order.push(pageIndex + distance);
    if (pageIndex - distance >= 0) order.push(pageIndex - distance);
  }

  var timeoutMs = Math.max(250, options.timeoutMs || 4500);
  var deadline = Date.now() + timeoutMs;
  for (var i = 0; i < order.length; i++) {
    var remaining = deadline - Date.now();
    if (remaining < 250) break;
    var slots = order.length - i;
    var perPage = Math.max(250, Math.floor(remaining / slots));
    var found = await resolveReferencePosition(reader, order[i], quote, {
      timeoutMs: perPage,
    });
    if (found && found.position) {
      found.reportedPageIndex = pageIndex;
      found.resolvedPageIndex = order[i];
      found.corrected = order[i] !== pageIndex;
      return found;
    }
  }
  return null;
}
