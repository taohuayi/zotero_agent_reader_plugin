import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/modules/libraryContext.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false,
});
const source = bundle.outputFiles[0].text;
const lib = await import(
  "data:text/javascript;base64," + Buffer.from(source).toString("base64")
);

// A 5-level chain plus siblings, mirroring the shape of a real library.
const COLLECTIONS = [
  { id: 1, key: "AAA", name: "Large Language Model", parentID: null },
  { id: 2, key: "BBB", name: "LLM Adaptation Methods", parentID: 1 },
  { id: 3, key: "CCC", name: "Parametric Adaptation", parentID: 2 },
  { id: 4, key: "DDD", name: "PEFT Methods", parentID: 3 },
  { id: 5, key: "EEE", name: "LoRA", parentID: 4 },
  { id: 6, key: "FFF", name: "Causal Discovery", parentID: null },
];

test("TSV cells never contain a tab or newline", () => {
  assert.equal(lib.escapeCell("a\tb\nc"), "a b c");
  assert.equal(lib.escapeCell("  spaced   out  "), "spaced out");
  assert.equal(lib.escapeCell(null), "");
});

test("creator lists collapse to a recognisable short form", () => {
  const one = [{ firstName: "Ashish", lastName: "Vaswani", fieldMode: 0 }];
  const two = one.concat([
    { firstName: "Noam", lastName: "Shazeer", fieldMode: 0 },
  ]);
  const three = two.concat([
    { firstName: "Niki", lastName: "Parmar", fieldMode: 0 },
  ]);
  assert.equal(lib.formatCreators(one), "Vaswani");
  assert.equal(lib.formatCreators(two), "Vaswani & Shazeer");
  assert.equal(lib.formatCreators(three), "Vaswani et al.");
  assert.equal(lib.formatCreators([]), "");
  // fieldMode 1 is a single-field (institutional) name
  assert.equal(
    lib.formatCreators([{ fieldMode: 1, lastName: "OpenAI", firstName: "" }]),
    "OpenAI",
  );
});

test("a year is pulled out of free-form Zotero date strings", () => {
  assert.equal(lib.yearOf("2017-06-12"), "2017");
  assert.equal(lib.yearOf("June 2017"), "2017");
  assert.equal(lib.yearOf("2024"), "2024");
  assert.equal(lib.yearOf(""), "");
  assert.equal(lib.yearOf("no date here"), "");
});

test("collection paths resolve through the full nesting depth", () => {
  const index = lib.buildCollectionIndex(COLLECTIONS);
  assert.equal(
    index[5].path,
    "Large Language Model/LLM Adaptation Methods/Parametric Adaptation/PEFT Methods/LoRA",
  );
  assert.equal(index[5].depth, 5);
  assert.equal(index[1].path, "Large Language Model");
  assert.equal(index[1].depth, 1);
});

test("a collection whose parent is missing is kept as a root", () => {
  const index = lib.buildCollectionIndex([
    { id: 9, key: "ZZZ", name: "Orphan", parentID: 404 },
  ]);
  assert.equal(index[9].path, "Orphan");
  assert.equal(index[9].depth, 1);
});

test("a cyclic parent chain terminates instead of hanging", () => {
  const index = lib.buildCollectionIndex([
    { id: 1, key: "A", name: "A", parentID: 2 },
    { id: 2, key: "B", name: "B", parentID: 1 },
  ]);
  assert.ok(index[1].path.includes("A"));
  assert.ok(index[2].path.includes("B"));
});

test("the collection tree is indented, counted, and name-sorted", () => {
  const counts = { 1: 25, 2: 8, 3: 5, 4: 5, 5: 3, 6: 46 };
  const tree = lib.formatCollectionTree(COLLECTIONS, counts);
  const lines = tree.trimEnd().split("\n");
  // "Causal Discovery" sorts before "Large Language Model"
  assert.equal(lines[0], "- Causal Discovery  [46]");
  assert.equal(lines[1], "- Large Language Model  [25]");
  assert.equal(lines[2], "  - LLM Adaptation Methods  [8]");
  assert.equal(lines[5], "        - LoRA  [3]");
  // stable across runs — the agent caches its reading of this file
  assert.equal(lib.formatCollectionTree(COLLECTIONS, counts), tree);
});

test("an orphaned child still appears in the tree", () => {
  const tree = lib.formatCollectionTree(
    [{ id: 9, key: "ZZZ", name: "Orphan", parentID: 404 }],
    { 9: 2 },
  );
  assert.equal(tree.trimEnd(), "- Orphan  [2]");
});

test("the catalog carries attachment keys and full collection paths", () => {
  const tsv = lib.formatCatalog([
    {
      key: "ITEM1",
      year: "2024",
      type: "preprint",
      title: "A Study",
      creators: "Vaswani et al.",
      collections: ["LLM/PEFT", "Reading/2024"],
      attachments: ["ATT1", "ATT2"],
    },
  ]);
  const lines = tsv.trimEnd().split("\n");
  assert.equal(lines[0], lib.CATALOG_COLUMNS.join("\t"));
  const cells = lines[1].split("\t");
  assert.equal(cells.length, lib.CATALOG_COLUMNS.length);
  assert.equal(cells[0], "ITEM1");
  assert.equal(cells[5], "LLM/PEFT ; Reading/2024");
  // the attachment key is the only bridge from a .zotero-ft-cache hit
  assert.equal(cells[6], "ATT1,ATT2");
});

test("a tab inside a title cannot shift the catalog columns", () => {
  const tsv = lib.formatCatalog([
    {
      key: "ITEM1",
      year: "",
      type: "",
      title: "Bad\tTitle\nWrapped",
      creators: "",
      collections: [],
      attachments: [],
    },
  ]);
  // NOT trimEnd() — trailing empty columns are real tabs and must survive
  const row = tsv.split("\n")[1];
  assert.equal(row.split("\t").length, lib.CATALOG_COLUMNS.length);
  assert.ok(row.includes("Bad Title Wrapped"));
});

test("note HTML becomes readable plain text", () => {
  assert.equal(
    lib.htmlToText("<p>First line</p><p>Second &amp; last</p>"),
    "First line\nSecond & last",
  );
  assert.equal(lib.htmlToText("<div>a<br/>b</div>"), "a\nb");
  assert.equal(lib.htmlToText(""), "");
});

test("annotations group under one heading per paper", () => {
  const md = lib.formatAnnotations([
    {
      itemKey: "P1",
      itemTitle: "Paper One",
      page: 7,
      pageLabel: "7",
      type: "highlight",
      text: "a key sentence",
      comment: "why it matters",
    },
    {
      itemKey: "P1",
      itemTitle: "Paper One",
      page: 9,
      pageLabel: "9",
      type: "highlight",
      text: "another",
      comment: "",
    },
    {
      itemKey: "P2",
      itemTitle: "Paper Two",
      page: null,
      pageLabel: "",
      type: "note",
      text: "",
      comment: "",
    },
  ]);
  assert.equal((md.match(/^## /gm) || []).length, 2);
  assert.ok(
    md.includes('- p.7 highlight: "a key sentence"  — note: why it matters'),
  );
  assert.ok(md.includes("[P1]"));
  // an annotation with no page/text still renders rather than disappearing
  assert.ok(md.includes("- p.? note: (no text)"));
});

test("the physical page comes from position.pageIndex, not the printed label", () => {
  // measured on a real library: a journal article's label was "1225" while the
  // annotation actually sat on physical page 3 — citing 1225 would be wrong
  const pages = lib.annotationPages({
    annotationPosition: JSON.stringify({ pageIndex: 2, rects: [[0, 0, 1, 1]] }),
    annotationPageLabel: "1225",
  });
  assert.equal(pages.page, 3);
  assert.equal(pages.pageLabel, "1225");
});

test("an unparseable annotation position yields no physical page", () => {
  assert.equal(lib.annotationPages({ annotationPosition: "{oops" }).page, null);
  assert.equal(lib.annotationPages({}).page, null);
  assert.equal(lib.annotationPages(null).page, null);
});

test("a printed label that disagrees is shown but kept distinct", () => {
  const md = lib.formatAnnotations([
    {
      itemKey: "P1",
      itemTitle: "Paper One",
      page: 3,
      pageLabel: "1225",
      type: "highlight",
      text: "quoted",
      comment: "",
    },
  ]);
  // physical page first — that is the citable one
  assert.ok(md.includes('- p.3 (printed 1225) highlight: "quoted"'));
});

test("the instructions warn against citing the printed label", () => {
  const md = lib.buildLibraryInstructions({ itemCount: 1 }, "/s");
  assert.ok(md.includes("PHYSICAL page and is safe to cite"));
  assert.ok(md.includes("never cite that one"));
});

test("the instructions bake in both measured search rules", () => {
  const md = lib.buildLibraryInstructions(
    { itemCount: 382, collectionCount: 112, annotationCount: 1472 },
    "/data/storage",
  );
  // rg skips dot-files by default and .zotero-ft-cache is one
  assert.ok(md.includes("--hidden"));
  // case-sensitive search was measured to miss 14% of matching papers
  assert.ok(/`-i`/.test(md));
  assert.ok(md.includes("/data/storage"));
  assert.ok(md.includes("382"));
  // the extraction cache must never be used to derive a page number
  assert.ok(md.includes("NO page markers"));
  assert.ok(md.includes('[@<itemKey> p.N "short verbatim quote"]'));
});

test("signatures compare by content, not identity", () => {
  const a = lib.snapshotSignature({ itemCount: 1, maxDateModified: "x" });
  const b = lib.snapshotSignature({ itemCount: 1, maxDateModified: "x" });
  const c = lib.snapshotSignature({ itemCount: 2, maxDateModified: "x" });
  assert.ok(lib.sameSignature(a, b));
  assert.ok(!lib.sameSignature(a, c));
  assert.ok(!lib.sameSignature(a, null));
});

function memoryDeps(data) {
  const files = new Map();
  const state = { collectCalls: 0, data };
  return {
    files,
    state,
    deps: {
      join: (...parts) => parts.join("/"),
      async exists(path) {
        return files.has(path);
      },
      async readUTF8(path) {
        if (!files.has(path)) throw new Error("missing " + path);
        return files.get(path);
      },
      async writeUTF8(path, value) {
        files.set(path, value);
      },
      async makeDirectory() {},
      async collect() {
        state.collectCalls++;
        return state.data;
      },
      storageDir: () => "/data/storage",
    },
  };
}

function sampleData(overrides = {}) {
  return {
    rows: [
      {
        key: "ITEM1",
        year: "2024",
        type: "preprint",
        title: "A Study",
        creators: "Vaswani et al.",
        collections: ["LLM/PEFT"],
        attachments: ["ATT1"],
      },
    ],
    collections: COLLECTIONS,
    collectionCounts: { 1: 25 },
    annotations: [
      {
        itemKey: "ITEM1",
        itemTitle: "A Study",
        page: "7",
        type: "highlight",
        text: "quote",
        comment: "",
      },
    ],
    notes: [{ itemKey: "ITEM1", itemTitle: "A Study", text: "my note" }],
    stats: {
      itemCount: 1,
      collectionCount: 6,
      annotationCount: 1,
      noteCount: 1,
      maxDateModified: "2026-07-25 00:00:00",
      ...overrides,
    },
  };
}

test("a snapshot writes every file the instructions reference", async () => {
  const { files, deps } = memoryDeps(sampleData());
  const result = await lib.ensureLibrarySnapshot({ workdir: "/w", deps });
  assert.equal(result.cached, false);
  for (const name of [
    lib.CATALOG_FILENAME,
    lib.COLLECTIONS_FILENAME,
    lib.ANNOTATIONS_FILENAME,
    lib.NOTES_FILENAME,
    lib.INSTRUCTIONS_FILENAME,
    lib.SNAPSHOT_META_FILENAME,
  ]) {
    assert.ok(files.has("/w/" + name), "missing " + name);
  }
  assert.ok(files.get("/w/" + lib.CATALOG_FILENAME).includes("ITEM1"));
  assert.equal(result.stats.itemCount, 1);
});

test("an unchanged library reuses the snapshot instead of rewriting", async () => {
  const { files, state, deps } = memoryDeps(sampleData());
  await lib.ensureLibrarySnapshot({ workdir: "/w", deps });
  files.set("/w/" + lib.CATALOG_FILENAME, "SENTINEL");
  const second = await lib.ensureLibrarySnapshot({ workdir: "/w", deps });
  assert.equal(second.cached, true);
  assert.equal(state.collectCalls, 2); // collection is cheap; writing is not
  assert.equal(files.get("/w/" + lib.CATALOG_FILENAME), "SENTINEL");
});

test("a changed library rebuilds the snapshot", async () => {
  const { files, state, deps } = memoryDeps(sampleData());
  await lib.ensureLibrarySnapshot({ workdir: "/w", deps });
  files.set("/w/" + lib.CATALOG_FILENAME, "SENTINEL");
  state.data = sampleData({ itemCount: 2 });
  const second = await lib.ensureLibrarySnapshot({ workdir: "/w", deps });
  assert.equal(second.cached, false);
  assert.ok(files.get("/w/" + lib.CATALOG_FILENAME).includes("ITEM1"));
});

test("force rebuilds even when nothing changed", async () => {
  const { files, deps } = memoryDeps(sampleData());
  await lib.ensureLibrarySnapshot({ workdir: "/w", deps });
  files.set("/w/" + lib.CATALOG_FILENAME, "SENTINEL");
  const second = await lib.ensureLibrarySnapshot({
    workdir: "/w",
    deps,
    force: true,
  });
  assert.equal(second.cached, false);
  assert.ok(files.get("/w/" + lib.CATALOG_FILENAME).includes("ITEM1"));
});

test("a corrupt meta file causes a rebuild rather than a throw", async () => {
  const { files, deps } = memoryDeps(sampleData());
  await lib.ensureLibrarySnapshot({ workdir: "/w", deps });
  files.set("/w/" + lib.SNAPSHOT_META_FILENAME, "{not json");
  const second = await lib.ensureLibrarySnapshot({ workdir: "/w", deps });
  assert.equal(second.cached, false);
});

test("a recent snapshot is reused instead of re-walking the library", async () => {
  lib.resetSnapshotCache();
  const { state, deps } = memoryDeps(sampleData());
  let clock = 1000;
  const opts = { workdir: "/w", deps, maxAgeMs: 60000, now: () => clock };
  await lib.ensureLibrarySnapshot(opts);
  assert.equal(state.collectCalls, 1);
  // the panel re-mounts on every item switch — none of these may re-walk
  clock += 5000;
  await lib.ensureLibrarySnapshot(opts);
  await lib.ensureLibrarySnapshot(opts);
  assert.equal(state.collectCalls, 1);
  // past the window it walks again
  clock += 60000;
  await lib.ensureLibrarySnapshot(opts);
  assert.equal(state.collectCalls, 2);
});

test("force ignores the in-memory throttle", async () => {
  lib.resetSnapshotCache();
  const { state, deps } = memoryDeps(sampleData());
  const opts = { workdir: "/w", deps, maxAgeMs: 60000, now: () => 1000 };
  await lib.ensureLibrarySnapshot(opts);
  await lib.ensureLibrarySnapshot({ ...opts, force: true });
  assert.equal(state.collectCalls, 2);
});

test("the snapshot result exposes the storage dir callers must grant", async () => {
  lib.resetSnapshotCache();
  const { deps } = memoryDeps(sampleData());
  const built = await lib.ensureLibrarySnapshot({ workdir: "/w", deps });
  assert.equal(built.storage, "/data/storage");
  lib.resetSnapshotCache();
  const reused = await lib.ensureLibrarySnapshot({ workdir: "/w", deps });
  assert.equal(reused.cached, true);
  assert.equal(reused.storage, "/data/storage");
});
