// @ts-nocheck
/*
 * backends.ts — the backend registry: the ONE place that knows which concrete
 * driver implements each backend id. Everything above chatService talks only to
 * the neutral AgentBackend contract below, so adding a backend is just: write a
 * driver (runTurn/healthcheck/shutdown emitting AgentEvents) and add one entry.
 *
 * AgentBackend = {
 *   id, label, loginHint,
 *   caps: { persistent, reasoningEffort, webSearch, modelCatalog },
 *   instructionFiles: [...],                            // written into each workdir
 *   runTurn(opts, workdir, sessionId, prompt, onEvent, liveRef) => {exitCode},
 *   healthcheck(opts) => { ok, version?, error? },
 *   getModelInfo(opts) => { selected, effective, source, options },
 *   shutdown(),
 * }
 * AgentEvent.kind ∈ thread_started | runtime_info | delta | tool | done | error
 */
import * as appServer from "./appServer";
import * as codexDriver from "./codexDriver";
import * as claudeDriver from "./claudeDriver";

var CODEX = {
  id: "codex",
  label: "Codex",
  loginHint: "run `codex login` or set the codex path",
  caps: {
    persistent: true,
    reasoningEffort: true,
    webSearch: true,
    modelCatalog: true,
  },
  instructionFiles: ["AGENTS.md"],
  runTurn: appServer.runTurn, // persistent app-server (true token streaming)
  healthcheck: codexDriver.healthcheck,
  getModelInfo: appServer.getModelInfo,
  shutdown: appServer.shutdown,
};

var CLAUDE = {
  id: "claude",
  label: "Claude Code",
  loginHint: "run `claude /login` or set the claude path",
  caps: {
    persistent: false,
    reasoningEffort: false,
    webSearch: true,
    modelCatalog: false,
  },
  instructionFiles: ["CLAUDE.md"],
  runTurn: claudeDriver.runTurn, // one process per turn + --resume
  healthcheck: claudeDriver.healthcheck,
  getModelInfo: claudeDriver.getModelInfo,
  shutdown: claudeDriver.shutdown,
};

var DEFAULT_ID = "codex";
var REGISTRY = Object.create(null);
[CODEX, CLAUDE].forEach(function (b) {
  REGISTRY[b.id] = b;
});

// Resolve a backend by id; unknown/empty falls back to the default (codex).
export function getBackend(id) {
  return REGISTRY[id] || REGISTRY[DEFAULT_ID];
}

export function listBackends() {
  return Object.keys(REGISTRY).map(function (k) {
    return REGISTRY[k];
  });
}

// The union of every backend's instruction filenames (e.g. AGENTS.md + CLAUDE.md),
// so itemContext can write all of them without knowing the active backend.
export function instructionFiles() {
  var seen = Object.create(null);
  var out = [];
  listBackends().forEach(function (b) {
    (b.instructionFiles || []).forEach(function (f) {
      if (!seen[f]) {
        seen[f] = 1;
        out.push(f);
      }
    });
  });
  return out;
}

// Tear down every backend (called on plugin shutdown).
export function shutdownAll() {
  listBackends().forEach(function (b) {
    try {
      if (b.shutdown) b.shutdown();
    } catch (e) {
      /* ignore */
    }
  });
}
