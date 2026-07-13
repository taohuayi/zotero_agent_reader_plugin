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
