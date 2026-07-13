import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/modules/pdfTextIndex.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false,
});
const source = bundle.outputFiles[0].text;
const pageIndex = await import(
  "data:text/javascript;base64," + Buffer.from(source).toString("base64")
);

function memoryDeps(options = {}) {
  const files = options.files || new Map();
  const state = {
    stat: options.stat || { size: 100, lastModified: 1000 },
    raw: options.raw || "page one\fpage two\f",
    extractCalls: 0,
    failNext: false,
  };
  return {
    files,
    state,
    deps: {
      join: (...parts) => parts.join("/"),
      async stat() {
        return { ...state.stat };
      },
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
      async extract() {
        state.extractCalls++;
        if (state.failNext) {
          state.failNext = false;
          throw new Error("temporary extraction failure");
        }
        return state.raw;
      },
    },
  };
}

test("splits physical pages without inventing a trailing page", () => {
  assert.deepEqual(pageIndex.splitPdfTextPages("cover\r\n\fbody\n\f\n"), [
    "cover\n",
    "body\n",
  ]);
  assert.deepEqual(pageIndex.splitPdfTextPages("one\f\fthree\f"), [
    "one",
    "",
    "three",
  ]);
  assert.deepEqual(pageIndex.splitPdfTextPages("one\f\f"), ["one", ""]);
});

test("labels every page explicitly and parses the cache losslessly", () => {
  const pages = ["cover\n", "", "results\nline two"];
  const text = pageIndex.formatPhysicalPageText(pages);
  assert.match(text, /^<<<PRA_PHYSICAL_PDF_PAGE:1>>>/);
  assert.match(text, /^<<<PRA_PHYSICAL_PDF_PAGE:2>>>/m);
  assert.match(text, /^<<<PRA_PHYSICAL_PDF_PAGE:3>>>/m);
  assert.equal(
    (text.match(/^<<<PRA_PHYSICAL_PDF_PAGE:\d+>>>/gm) || []).length,
    pages.length,
  );
  assert.deepEqual(pageIndex.parsePhysicalPageText(text), pages);
  assert.equal(
    pageIndex.parsePhysicalPageText(
      text.replace("PRA_PHYSICAL_PDF_PAGE:2", "PRA_PHYSICAL_PDF_PAGE:9"),
    ),
    null,
  );
});

test("reuses a valid cache and invalidates it when the PDF changes", async () => {
  const mem = memoryDeps();
  const first = await pageIndex.ensurePdfTextIndex("paper.pdf", "work", {
    deps: mem.deps,
  });
  assert.equal(first.cached, false);
  assert.equal(first.pageCount, 2);
  assert.equal(mem.state.extractCalls, 1);

  const second = await pageIndex.ensurePdfTextIndex("paper.pdf", "work", {
    deps: mem.deps,
  });
  assert.equal(second.cached, true);
  assert.deepEqual(second.pages, ["page one", "page two"]);
  assert.equal(mem.state.extractCalls, 1);
  assert.deepEqual(
    await pageIndex.loadPdfTextIndexPages(second.textPath, { deps: mem.deps }),
    ["page one", "page two"],
  );

  mem.state.stat = { size: 120, lastModified: 2000 };
  mem.state.raw = "replacement page\f";
  const changed = await pageIndex.ensurePdfTextIndex("paper.pdf", "work", {
    deps: mem.deps,
  });
  assert.equal(changed.cached, false);
  assert.deepEqual(changed.pages, ["replacement page"]);
  assert.equal(mem.state.extractCalls, 2);
});

test("rejects a malformed cache when loading pages for verification", async () => {
  const mem = memoryDeps();
  mem.files.set("work/bad.txt", "not labelled text");
  await assert.rejects(
    pageIndex.loadPdfTextIndexPages("work/bad.txt", { deps: mem.deps }),
    /invalid cached physical-page text index/,
  );
});

test("regenerates a corrupt labelled cache instead of shifting pages", async () => {
  const mem = memoryDeps();
  await pageIndex.ensurePdfTextIndex("corrupt.pdf", "work-corrupt", {
    deps: mem.deps,
  });
  mem.files.set("work-corrupt/paper-physical-pages.txt", "not a page index");
  mem.state.raw = "fresh one\ffresh two\f";

  const regenerated = await pageIndex.ensurePdfTextIndex(
    "corrupt.pdf",
    "work-corrupt",
    { deps: mem.deps },
  );
  assert.equal(regenerated.cached, false);
  assert.deepEqual(regenerated.pages, ["fresh one", "fresh two"]);
  assert.equal(mem.state.extractCalls, 2);
});

test("deduplicates concurrent extraction and retries after failure", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const mem = memoryDeps();
  const originalExtract = mem.deps.extract;
  mem.deps.extract = async () => {
    await gate;
    return originalExtract();
  };

  const a = pageIndex.ensurePdfTextIndex("same.pdf", "same-work", {
    deps: mem.deps,
  });
  const b = pageIndex.ensurePdfTextIndex("same.pdf", "same-work", {
    deps: mem.deps,
  });
  assert.strictEqual(a, b);
  release();
  await Promise.all([a, b]);
  assert.equal(mem.state.extractCalls, 1);

  const retry = memoryDeps();
  retry.state.failNext = true;
  await assert.rejects(
    pageIndex.ensurePdfTextIndex("retry.pdf", "retry-work", {
      deps: retry.deps,
    }),
    /temporary extraction failure/,
  );
  const recovered = await pageIndex.ensurePdfTextIndex(
    "retry.pdf",
    "retry-work",
    { deps: retry.deps },
  );
  assert.equal(recovered.pageCount, 2);
  assert.equal(retry.state.extractCalls, 2);
});
