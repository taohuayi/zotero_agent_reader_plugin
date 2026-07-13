import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/modules/modelInfo.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false,
});
const modelInfo = await import(
  "data:text/javascript;base64," +
    Buffer.from(bundle.outputFiles[0].text).toString("base64")
);

const catalog = {
  data: [
    {
      model: "gpt-default",
      displayName: "GPT Default",
      description: "Default model",
      isDefault: true,
      hidden: false,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Fast" },
        { reasoningEffort: "high", description: "Deep" },
      ],
    },
    {
      model: "gpt-hidden",
      displayName: "Hidden",
      isDefault: false,
      hidden: true,
    },
  ],
};

test("Codex model resolution prefers plugin selection, then config, then catalog", () => {
  const configured = modelInfo.normalizeCodexModelInfo({}, catalog, {
    config: { model: "gpt-config" },
  });
  assert.equal(configured.effective, "gpt-config");
  assert.equal(configured.source, "codex-config");
  assert.deepEqual(
    configured.options.map((option) => option.value),
    ["gpt-default"],
  );
  assert.deepEqual(
    configured.options[0].supportedReasoningEfforts.map(
      (effort) => effort.value,
    ),
    ["low", "high"],
  );

  const selected = modelInfo.normalizeCodexModelInfo(
    { model: "provider/custom", codexLastModel: "old-model" },
    catalog,
    { config: { model: "gpt-config" } },
  );
  assert.equal(selected.effective, "provider/custom");
  assert.equal(selected.source, "plugin");
  assert.equal(selected.options[0].value, "provider/custom");

  const defaulted = modelInfo.normalizeCodexModelInfo({}, catalog, null);
  assert.equal(defaulted.effective, "gpt-default");
  assert.equal(defaulted.source, "codex-default");
});

test("Codex falls back to the last runtime model only when no current source resolves", () => {
  const info = modelInfo.normalizeCodexModelInfo(
    { codexLastModel: "gpt-last" },
    { data: [] },
    null,
  );
  assert.equal(info.effective, "gpt-last");
  assert.equal(info.source, "last-runtime");
});

test("Claude keeps an editable alias list and distinguishes last runtime from selection", () => {
  const last = modelInfo.claudeModelInfo({
    claudeLastModel: "claude-opus-4-8",
  });
  assert.equal(last.effective, "claude-opus-4-8");
  assert.equal(last.source, "last-runtime");
  assert.ok(last.options.some((option) => option.value === "fable"));
  assert.ok(last.options.some((option) => option.value === "sonnet"));

  const custom = modelInfo.claudeModelInfo({
    claudeModel: "claude-sonnet-5-0",
    claudeLastModel: "claude-opus-4-8",
  });
  assert.equal(custom.effective, "claude-sonnet-5-0");
  assert.equal(custom.source, "plugin");
  assert.equal(custom.options[0].value, "claude-sonnet-5-0");

  const unresolved = modelInfo.claudeModelInfo({});
  assert.equal(unresolved.effective, "");
  assert.equal(unresolved.source, "claude-default");
  assert.equal(unresolved.resolved, false);
});

test("response and backend labels expose actual model metadata", () => {
  assert.equal(
    modelInfo.messageModelLabel({
      role: "assistant",
      backend: "claude",
      model: "claude-opus-4-8",
    }),
    "Claude Code · claude-opus-4-8",
  );
  assert.equal(
    modelInfo.messageModelLabel({
      role: "assistant",
      backend: "codex",
      model: "gpt-5.6-codex",
      reasoningEffort: "high",
    }),
    "Codex · gpt-5.6-codex · high",
  );
  assert.equal(
    modelInfo.messageModelLabel({ role: "assistant", backend: "codex" }),
    "Codex · resolving model…",
  );
  assert.equal(
    modelInfo.backendStatusLabel({
      ok: true,
      label: "Codex",
      version: "codex-cli 0.144.1",
      modelInfo: { effective: "gpt-5.6-sol" },
    }),
    "Codex ready · codex-cli 0.144.1 · model gpt-5.6-sol",
  );
});
