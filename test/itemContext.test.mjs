import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/modules/itemContext.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false,
});
const source = bundle.outputFiles[0].text;
const itemContext = await import(
  "data:text/javascript;base64," + Buffer.from(source).toString("base64")
);

test("indexed instructions make explicit physical-page markers authoritative", () => {
  const instructions = itemContext.buildAgentInstructions(
    "Test Paper",
    "/papers/test.pdf",
    "/work/paper-physical-pages.txt",
    12,
  );
  assert.match(instructions, /paper-physical-pages\.txt/);
  assert.match(instructions, /<<<PRA_PHYSICAL_PDF_PAGE:7>>>/);
  assert.match(instructions, /index contains 12 physical pages/);
  assert.match(instructions, /NEVER count form-feeds/);
  assert.match(instructions, /marker on\s+the SAME page as the quote/);
  assert.doesNotMatch(instructions, /N is .*counted from form-feeds/);
});

test("fallback instructions remain usable when indexing is unavailable", () => {
  const instructions = itemContext.buildAgentInstructions(
    "Fallback Paper",
    "/papers/fallback.pdf",
    null,
    null,
  );
  assert.match(instructions, /pdftotext -layout "\/papers\/fallback\.pdf" -/);
  assert.match(instructions, /counted from form-feeds/);
  assert.doesNotMatch(instructions, /explicit marker on\s+the SAME page/);
  assert.doesNotMatch(instructions, /null physical pages/);
});

const LIBRARY = {
  workdir: "/data/library",
  storage: "/data/storage",
  files: {
    catalog: "/data/library/catalog.tsv",
    collections: "/data/library/collections.md",
    annotations: "/data/library/annotations.md",
    notes: "/data/library/notes.md",
  },
  stats: {
    itemCount: 456,
    collectionCount: 111,
    annotationCount: 1467,
    noteCount: 168,
  },
};

test("library access is absent from the instructions unless enabled", () => {
  assert.equal(itemContext.buildLibrarySection(null), "");
  assert.equal(itemContext.buildLibrarySection({}), "");
  const withoutLibrary = itemContext.buildAgentInstructions(
    "Test Paper",
    "/tmp/paper.pdf",
    null,
    null,
  );
  assert.ok(!withoutLibrary.includes("the rest of the library".toLowerCase()));
  assert.ok(!withoutLibrary.includes("zotero-ft-cache"));
});

test("the library section carries both mandatory search flags", () => {
  const section = itemContext.buildLibrarySection(LIBRARY);
  // rg skips dot-files, and .zotero-ft-cache is one
  assert.ok(section.includes("--hidden"));
  // case-sensitive search was measured to miss 14% of matching papers
  assert.ok(section.includes("`-i`"));
  assert.ok(section.includes("/data/library/catalog.tsv"));
  assert.ok(section.includes("/data/storage"));
  assert.ok(section.includes("456"));
});

test("the extraction cache is never presented as a source of page numbers", () => {
  const section = itemContext.buildLibrarySection(LIBRARY);
  assert.ok(section.includes("no page markers"));
  assert.ok(section.includes("never cite that"));
  // no cross-paper citation marker: chatPanel can only resolve [p.N "quote"]
  // against THIS paper, so a [@key …] form would render as dead text
  assert.ok(!section.includes("[@"));
});

test("enabling library access appends the section to the paper instructions", () => {
  const instructions = itemContext.buildAgentInstructions(
    "Test Paper",
    "/tmp/paper.pdf",
    "/tmp/work/paper-physical-pages.txt",
    12,
    LIBRARY,
  );
  // the per-paper contract is untouched
  assert.ok(instructions.includes('[p.N "short verbatim quote"]'));
  assert.ok(instructions.includes("PRA_PHYSICAL_PDF_PAGE:"));
  // and the library is appended after it
  assert.ok(instructions.includes("zotero-ft-cache"));
  assert.ok(
    instructions.indexOf("zotero-ft-cache") >
      instructions.indexOf('[p.N "short verbatim quote"]'),
  );
});
