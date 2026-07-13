import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/modules/referenceResolver.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false,
});
const source = bundle.outputFiles[0].text;
const resolver = await import(
  "data:text/javascript;base64," + Buffer.from(source).toString("base64")
);

test("parses page-only and visible verbatim citation markers", () => {
  const pulled = resolver.pullCitationMarkers(
    'Claim [p.7 "a distinctive verbatim passage from the PDF"] and [p.9].',
  );
  assert.equal(pulled.text, "Claim PRAREF0ENDPRAREF and PRAREF1ENDPRAREF.");
  assert.deepEqual(pulled.citations, [
    { page: 7, quote: "a distinctive verbatim passage from the PDF" },
    { page: 9, quote: "" },
  ]);
});

test("normalizes PDF ligatures, invisible characters, and whitespace", () => {
  assert.equal(
    resolver.normalizeReferenceQuote("  efﬁcient\u00ad  causal\n  discovery  "),
    "efficient causal discovery",
  );
});

test("builds exact candidates before dehyphenated fallbacks", () => {
  const candidates = resolver.buildReferenceQuoteCandidates(
    "This sample- efficient method identifies the correct causal structure with fewer observations",
  );
  assert.equal(
    candidates[0],
    "This sample- efficient method identifies the correct causal structure with fewer observations",
  );
  assert.ok(
    candidates.includes(
      "This sampleefficient method identifies the correct causal structure with fewer observations",
    ),
  );
});

test("varies one word hyphen without destroying other genuine hyphens", () => {
  const candidates = resolver.buildReferenceQuoteCandidates(
    "Existing score-based methods struggle to recover the graph accurately and sample-efficiently",
  );
  assert.ok(
    candidates.includes(
      "Existing score-based methods struggle to recover the graph accurately and sampleefficiently",
    ),
  );
  assert.ok(
    candidates.includes(
      "Existing score-based methods struggle to recover the graph accurately and sample efficiently",
    ),
  );
});

test("maps a line-broken page quote directly to Zotero PDF coordinates", async () => {
  const firstLine = "Existing score-based methods sample-";
  const secondLine = "efficiently solve this problem";
  const chars = [...firstLine].map((u) => ({ u }));
  chars[chars.length - 1].lineBreakAfter = true;
  chars.push(...[...secondLine].map((u) => ({ u })));
  const rawLength = firstLine.length + 1 + secondLine.length;
  const controller = {
    _pageMatches: [[777]],
    _pageMatchesLength: [[3]],
    _pdfDocument: {
      async getPageData({ pageIndex }) {
        assert.equal(pageIndex, 0);
        return { chars };
      },
    },
    getMatchPositions(pageIndex) {
      return this._pageMatches[pageIndex].map((start, i) => ({
        pageIndex,
        rects: [[start, 0, start + this._pageMatchesLength[pageIndex][i], 1]],
      }));
    },
  };
  const reader = {
    _internalReader: { _primaryView: { _findController: controller } },
  };

  const found = await resolver.resolveReferencePosition(
    reader,
    0,
    "Existing score-based methods sample-efficiently solve this problem",
    { timeoutMs: 250 },
  );

  assert.equal(
    found.matchedQuote,
    "Existing score-based methods sampleefficiently solve this problem",
  );
  assert.deepEqual(found.position, {
    pageIndex: 0,
    rects: [[0, 0, rawLength, 1]],
  });
  assert.deepEqual(controller._pageMatches[0], [777]);
  assert.deepEqual(controller._pageMatchesLength[0], [3]);
});

function fakeReader(matchQuery, options = {}) {
  const matchPage = options.matchPage ?? 6;
  const oldState = {
    popupOpen: false,
    active: false,
    query: "previous search",
    highlightAll: false,
    caseSensitive: false,
    entireWord: false,
    index: null,
    result: null,
  };
  const controller = {
    _state: null,
    _pageMatches: [],
    get state() {
      return this._state;
    },
    get pageMatches() {
      return this._pageMatches;
    },
    find(state) {
      this._state = state;
      if (options.delayedControllerReset) {
        this._dirtyMatch = true;
        setTimeout(() => {
          this._pageMatches.length = 0;
          this._dirtyMatch = false;
          this._pageMatches[matchPage] = state.query === matchQuery ? [12] : [];
        }, 5);
        return;
      }
      this._pageMatches.length = 0;
      setTimeout(() => {
        this._pageMatches[matchPage] = state.query === matchQuery ? [12] : [];
      }, 2);
    },
    async getMatchPositionsAsync(pageIndex) {
      return this._pageMatches[pageIndex]?.length
        ? [{ pageIndex, rects: [[10, 20, 110, 32]] }]
        : [];
    },
    onClose() {},
  };
  const view = {
    _findState: { ...oldState },
    _findController: controller,
    async setFindState(state) {
      const wasActive = this._findState.active;
      this._findState = { ...state };
      if (state.active && !options.viewControllerDrift) {
        controller.find({ type: "find", phraseSearch: true, ...state });
      } else if (wasActive) {
        controller.onClose();
      }
    },
  };
  return {
    reader: { _internalReader: { _primaryView: view } },
    view,
    oldState,
  };
}

test("resolves a quote to the requested page and restores find state", async () => {
  const quote =
    "a distinctive quote that appears on the requested physical PDF page";
  const { reader, view, oldState } = fakeReader(quote);
  const found = await resolver.resolveReferencePosition(reader, 6, quote, {
    timeoutMs: 250,
  });
  assert.deepEqual(found.position, {
    pageIndex: 6,
    rects: [[10, 20, 110, 32]],
  });
  assert.equal(found.matchCount, 1);
  assert.deepEqual(view._findState, oldState);
});

test("uses the dehyphenated candidate when the exact PDF text differs", async () => {
  const quote =
    "the sample- efficient estimator recovers the correct graph from observational data";
  const match =
    "the sampleefficient estimator recovers the correct graph from observational data";
  const { reader } = fakeReader(match);
  const found = await resolver.resolveReferencePosition(reader, 6, quote, {
    timeoutMs: 250,
  });
  assert.equal(found.matchedQuote, match);
});

test("repairs and waits out a stale PDF controller when only the view updates", async () => {
  const quote =
    "a distinctive quote whose PDF controller is still on an older query";
  const { reader, view, oldState } = fakeReader(quote, {
    viewControllerDrift: true,
    delayedControllerReset: true,
  });
  view._findController._state = {
    type: "find",
    query: "older built-in search",
    caseSensitive: false,
    entireWord: false,
  };
  view._findController._pageMatches[6] = [99];

  const found = await resolver.resolveReferencePosition(reader, 6, quote, {
    timeoutMs: 250,
  });

  assert.equal(found.matchedQuote, quote);
  assert.deepEqual(found.position, {
    pageIndex: 6,
    rects: [[10, 20, 110, 32]],
  });
  assert.deepEqual(view._findState, oldState);
});

test("returns null when Zotero's exact-position API is unavailable", async () => {
  assert.equal(
    await resolver.resolveReferencePosition({}, 0, "some quote", {
      timeoutMs: 250,
    }),
    null,
  );
});

test("finds a verbatim quote on its deterministic physical page", () => {
  const quote =
    "the proposed estimator consistently recovers the correct graph from observational samples";
  const pages = [
    "cover",
    "abstract",
    "introduction",
    "methods",
    "experiments",
    "Our results show that the proposed estimator consistently recovers the correct graph from observational samples under mild assumptions.",
  ];
  assert.deepEqual(resolver.findReferenceQuotePages(pages, quote), {
    pages: [6],
    matchedQuote: quote,
    matchCount: 1,
  });
});

test("page verification tolerates ligatures and line-end hyphenation", () => {
  const quote =
    "This sample-efficient procedure identifies the optimal policy with substantially fewer interactions";
  const pages = [
    "Earlier work",
    "This sample-\n efficient procedure identiﬁes the optimal policy with substantially fewer interactions than prior methods.",
  ];
  const found = resolver.findReferenceQuotePages(pages, quote);
  assert.deepEqual(found.pages, [2]);
  assert.equal(found.matchCount, 1);
});

test("corrects an agent p.5 citation when the unique quote is on p.6", () => {
  const quote =
    "the proposed estimator consistently recovers the correct graph from observational samples";
  const pages = [
    "cover",
    "two",
    "three",
    "four",
    "five",
    quote + " under mild assumptions",
  ];
  const result = resolver.verifyAndCorrectCitationPages(
    `Claim [p.5 "${quote}"]`,
    pages,
  );

  assert.equal(result.text, `Claim [p.6 "${quote}"]`);
  assert.deepEqual(result.citations[0], {
    reportedPage: 5,
    resolvedPage: 6,
    quote,
    status: "corrected",
    matchedPages: [6],
    matchedQuote: quote,
    matchCount: 1,
  });
  assert.equal(result.counts.corrected, 1);
});

test("corrects a uniquely matched quote even when it is not adjacent", () => {
  const quote =
    "a distinctive ablation demonstrates that every architectural component contributes independently";
  const pages = ["cover", quote, "third", "fourth", "fifth", "sixth"];
  const result = resolver.verifyAndCorrectCitationPages(
    `Claim [p.6 '${quote}']`,
    pages,
  );
  assert.equal(result.text, `Claim [p.2 '${quote}']`);
  assert.equal(result.citations[0].resolvedPage, 2);
  assert.equal(result.citations[0].status, "corrected");
});

test("keeps a reported page when a duplicated quote also occurs there", () => {
  const quote =
    "this repeated running header appears verbatim on several physical pages of the appendix";
  const pages = ["one", "two", "three", "four", quote, quote];
  const result = resolver.verifyAndCorrectCitationPages(
    `Claim [p.5 "${quote}"]`,
    pages,
  );
  assert.equal(result.text, `Claim [p.5 "${quote}"]`);
  assert.equal(result.citations[0].status, "verified");
  assert.deepEqual(result.citations[0].matchedPages, [5, 6]);
});

test("does not guess when a quote is ambiguous or absent", () => {
  const duplicate =
    "the same generic sentence is repeated in more than one appendix section of this paper";
  const missing =
    "this paraphrased sentence does not occur verbatim anywhere in the extracted PDF text";
  const pages = ["one", duplicate, "three", duplicate, "five"];
  const source = `Ambiguous [p.5 "${duplicate}"] and missing [p.3 "${missing}"] plus [p.2].`;
  const result = resolver.verifyAndCorrectCitationPages(source, pages);

  assert.equal(result.text, source);
  assert.equal(result.citations[0].status, "ambiguous");
  assert.deepEqual(result.citations[0].matchedPages, [2, 4]);
  assert.equal(result.citations[1].status, "unverified");
  assert.equal(result.citations[2].status, "page-only");
  assert.deepEqual(result.counts, {
    corrected: 0,
    verified: 0,
    ambiguous: 1,
    unverified: 1,
    pageOnly: 1,
  });
});

test("click-time resolver searches the following physical page", async () => {
  const quote =
    "a distinctive passage that is actually located on the following physical PDF page";
  const { reader } = fakeReader(quote, { matchPage: 5 });
  const found = await resolver.resolveReferenceNearPage(reader, 4, quote, {
    timeoutMs: 900,
    neighborRadius: 1,
  });
  assert.equal(found.reportedPageIndex, 4);
  assert.equal(found.resolvedPageIndex, 5);
  assert.equal(found.corrected, true);
  assert.equal(found.position.pageIndex, 5);
});
