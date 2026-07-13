import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

class FakeElement {
  constructor(id) {
    this.id = id;
    this.value = "";
    this.textContent = "";
    this.hidden = false;
    this.children = [];
    this.listeners = Object.create(null);
    this.attributes = Object.create(null);
  }

  get firstChild() {
    return this.children[0] || null;
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
  }

  addEventListener(type, callback) {
    (this.listeners[type] ||= []).push(callback);
  }

  dispatch(type) {
    for (const callback of this.listeners[type] || []) callback({ type });
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
}

const source = await readFile("addon/content/preferences.js", "utf8");

function fixture(options = {}) {
  const ids = [
    "pra-backend",
    "pra-codex-group",
    "pra-claude-group",
    "pra-codex-model",
    "pra-codex-models",
    "pra-codex-model-status",
    "pra-codex-model-default",
    "pra-codex-model-refresh",
    "pra-claude-model",
    "pra-claude-models",
    "pra-claude-model-status",
    "pra-claude-model-default",
    "pra-claude-model-refresh",
    "pra-test",
    "pra-test-status",
    "pra-check-update",
    "pra-install-update",
    "pra-update-status",
  ];
  const elements = Object.fromEntries(
    ids.map((id) => [id, new FakeElement(id)]),
  );
  elements["pra-backend"].value = "codex";
  const values = {
    "extensions.paper-reading-agent.backend": "codex",
    "extensions.paper-reading-agent.model": "",
    "extensions.paper-reading-agent.claudeModel": "",
  };
  const calls = [];
  let attached = !options.deferredDOM;
  const documentListeners = Object.create(null);
  const context = {
    console,
    document: {
      getElementById(id) {
        return attached ? elements[id] || null : null;
      },
      createElementNS() {
        return new FakeElement("option");
      },
      addEventListener(type, callback) {
        (documentListeners[type] ||= []).push(callback);
      },
    },
    Zotero: {
      Prefs: {
        get(key) {
          return values[key];
        },
        set(key, value) {
          values[key] = value;
        },
      },
      PaperReadingAgent: {
        async getBackendInfo(backend) {
          backend = backend || values["extensions.paper-reading-agent.backend"];
          calls.push(backend);
          if (backend === "claude") {
            const selected =
              values["extensions.paper-reading-agent.claudeModel"] || "";
            return {
              ok: true,
              label: "Claude Code",
              version: "2.1.207",
              modelInfo: {
                effective: selected || "claude-opus-4-8",
                source: selected ? "plugin" : "last-runtime",
                sourceLabel: selected
                  ? "Paper Reading Agent setting"
                  : "last reported response",
                options: [
                  { value: "fable", label: "fable" },
                  { value: "sonnet", label: "sonnet" },
                  { value: "opus", label: "opus" },
                ],
              },
            };
          }
          const selected = values["extensions.paper-reading-agent.model"] || "";
          return {
            ok: true,
            label: "Codex",
            version: "codex-cli 0.144.1",
            modelInfo: {
              effective: selected || "gpt-default",
              source: selected ? "plugin" : "codex-config",
              sourceLabel: selected
                ? "Paper Reading Agent setting"
                : "Codex config",
              options: [
                { value: "gpt-default", label: "GPT Default" },
                { value: "gpt-fast", label: "GPT Fast" },
              ],
            },
          };
        },
      },
    },
    // The source schedules a second defensive init; the first synchronous init
    // is enough for this deterministic fixture.
    setTimeout() {},
  };
  vm.runInNewContext(source, context, { filename: "preferences.js" });
  return {
    prefs: context.PaperReadingAgentPrefs,
    elements,
    values,
    calls,
    attachAndShow() {
      attached = true;
      for (const callback of documentListeners.showing || [])
        callback({ type: "showing" });
    },
  };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

test("Settings loads model choices and shows the resolved Codex model", async () => {
  const f = fixture();
  await settle();
  assert.equal(f.elements["pra-codex-group"].hidden, false);
  assert.equal(f.elements["pra-claude-group"].hidden, true);
  assert.deepEqual(
    f.elements["pra-codex-models"].children.map((option) => option.value),
    ["gpt-default", "gpt-fast"],
  );
  assert.match(
    f.elements["pra-codex-model-status"].textContent,
    /Will use: gpt-default.*Codex config/,
  );
});

test("Settings waits for Zotero to insert the pane DOM before initial loading", async () => {
  const f = fixture({ deferredDOM: true });
  await settle();
  assert.equal(f.calls.length, 0);
  assert.deepEqual(Object.keys(f.prefs._modelLoaded), []);

  f.attachAndShow();
  await settle();
  assert.equal(f.calls[0], "codex");
  assert.equal(f.elements["pra-codex-model"]._praWired, true);
  assert.deepEqual(
    f.elements["pra-codex-models"].children.map((option) => option.value),
    ["gpt-default", "gpt-fast"],
  );
});

test("Settings persists a custom model, resets it, and switches backend panes", async () => {
  const f = fixture();
  await settle();

  f.elements["pra-codex-model"].value = "provider/custom-model";
  f.elements["pra-codex-model"].dispatch("change");
  await settle();
  assert.equal(
    f.values["extensions.paper-reading-agent.model"],
    "provider/custom-model",
  );
  assert.match(
    f.elements["pra-codex-model-status"].textContent,
    /Will use: provider\/custom-model.*applies from the next message/,
  );

  f.elements["pra-codex-model-default"].dispatch("command");
  await settle();
  assert.equal(f.values["extensions.paper-reading-agent.model"], "");
  assert.equal(f.elements["pra-codex-model"].value, "");

  f.elements["pra-backend"].value = "claude";
  f.elements["pra-backend"].dispatch("command");
  await settle();
  assert.equal(f.values["extensions.paper-reading-agent.backend"], "claude");
  assert.equal(f.elements["pra-codex-group"].hidden, true);
  assert.equal(f.elements["pra-claude-group"].hidden, false);
  assert.deepEqual(
    f.elements["pra-claude-models"].children.map((option) => option.value),
    ["fable", "sonnet", "opus"],
  );
  assert.match(
    f.elements["pra-claude-model-status"].textContent,
    /Last reported: claude-opus-4-8/,
  );
});
