// @ts-nocheck
/*
 * modelInfo.ts — pure model metadata helpers shared by the backend drivers,
 * Settings pane API, and chat renderer.  Keep this module free of Zotero/Gecko
 * globals so its precedence and labels can be unit-tested in Node.
 *
 * A model has three deliberately separate concepts:
 *   selected     explicit Paper Reading Agent preference (may be empty)
 *   effective    best model known before a turn (config/default/last runtime)
 *   message.model model actually reported by the backend for one response
 */

function clean(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function codexOptions(catalogResponse) {
  var raw = Array.isArray(catalogResponse)
    ? catalogResponse
    : catalogResponse && Array.isArray(catalogResponse.data)
      ? catalogResponse.data
      : [];
  var seen = Object.create(null);
  var out = [];
  raw.forEach(function (m) {
    if (!m || m.hidden) return;
    var value = clean(m.model || m.id);
    if (!value || seen[value]) return;
    seen[value] = 1;
    out.push({
      value: value,
      label: clean(m.displayName) || value,
      description: clean(m.description),
      isDefault: !!m.isDefault,
      defaultReasoningEffort: clean(m.defaultReasoningEffort),
      supportedReasoningEfforts: Array.isArray(m.supportedReasoningEfforts)
        ? m.supportedReasoningEfforts
            .map(function (r) {
              return {
                value: clean(r && (r.reasoningEffort || r.value || r)),
                description: clean(r && r.description),
              };
            })
            .filter(function (r) {
              return !!r.value;
            })
        : [],
    });
  });
  return out;
}

export function normalizeCodexModelInfo(opts, catalogResponse, configResponse) {
  opts = opts || {};
  var options = codexOptions(catalogResponse);
  var selected = clean(opts.model);
  var configured = clean(
    configResponse && configResponse.config && configResponse.config.model,
  );
  var catalogDefault = "";
  for (var i = 0; i < options.length; i++) {
    if (options[i].isDefault) {
      catalogDefault = options[i].value;
      break;
    }
  }
  var lastRuntime = clean(opts.codexLastModel);
  var effective = selected || configured || catalogDefault || lastRuntime;
  var source = selected
    ? "plugin"
    : configured
      ? "codex-config"
      : catalogDefault
        ? "codex-default"
        : lastRuntime
          ? "last-runtime"
          : "unknown";
  var sourceLabel = {
    plugin: "Paper Reading Agent setting",
    "codex-config": "Codex config",
    "codex-default": "Codex default",
    "last-runtime": "last reported response",
    unknown: "not resolved",
  }[source];

  // A user may type a valid provider/custom model that is intentionally absent
  // from the advertised picker. Keep the field editable and show that selection.
  if (
    selected &&
    !options.some(function (o) {
      return o.value === selected;
    })
  ) {
    options.unshift({
      value: selected,
      label: selected,
      description: "Custom model",
      isDefault: false,
      defaultReasoningEffort: "",
      supportedReasoningEfforts: [],
    });
  }

  return {
    backend: "codex",
    selected: selected,
    configured: configured,
    lastRuntime: lastRuntime,
    effective: effective,
    source: source,
    sourceLabel: sourceLabel,
    resolved: !!effective,
    options: options,
    catalogAvailable: options.length > 0,
    note: "The response badge shows the model actually reported by Codex; custom model names are also accepted.",
  };
}

var CLAUDE_SUGGESTIONS = [
  {
    value: "fable",
    label: "fable",
    description: "Claude Code's current Fable alias",
  },
  {
    value: "sonnet",
    label: "sonnet",
    description: "Claude Code's current Sonnet alias",
  },
  {
    value: "opus",
    label: "opus",
    description: "Claude Code's current Opus alias",
  },
  {
    value: "haiku",
    label: "haiku",
    description: "Claude Code's current Haiku alias",
  },
];

export function claudeModelInfo(opts) {
  opts = opts || {};
  var selected = clean(opts.claudeModel);
  var lastRuntime = clean(opts.claudeLastModel);
  var effective = selected || lastRuntime;
  var source = selected
    ? "plugin"
    : lastRuntime
      ? "last-runtime"
      : "claude-default";
  var options = CLAUDE_SUGGESTIONS.map(function (o) {
    return Object.assign({}, o);
  });
  if (
    selected &&
    !options.some(function (o) {
      return o.value === selected;
    })
  ) {
    options.unshift({
      value: selected,
      label: selected,
      description: "Full model name or custom alias",
    });
  }
  return {
    backend: "claude",
    selected: selected,
    configured: "",
    lastRuntime: lastRuntime,
    effective: effective,
    source: source,
    sourceLabel:
      source === "plugin"
        ? "Paper Reading Agent setting"
        : source === "last-runtime"
          ? "last reported response"
          : "Claude Code default (resolved on the next response)",
    resolved: !!effective,
    options: options,
    catalogAvailable: false,
    note: "Claude Code does not expose a stable model catalog; aliases and full model names remain editable.",
  };
}

var CHATGPT_SUGGESTIONS = [
  {
    value: "gpt-5.6",
    label: "gpt-5.6",
    description: "Current ChatGPT flagship",
  },
  {
    value: "gpt-5",
    label: "gpt-5",
    description: "ChatGPT flagship",
  },
  {
    value: "gpt-4o",
    label: "gpt-4o",
    description: "Fast general-purpose",
  },
  {
    value: "o3-mini",
    label: "o3-mini",
    description: "Reasoning, lightweight",
  },
  {
    value: "gpt-4o-mini",
    label: "gpt-4o-mini",
    description: "Fastest, cheapest",
  },
];

export function chatgptModelInfo(opts) {
  opts = opts || {};
  var selected = clean(opts.chatgptModel);
  var lastRuntime = clean(opts.chatgptLastModel);
  var effective = selected || lastRuntime || "gpt-5";
  var source = selected
    ? "plugin"
    : lastRuntime
      ? "last-runtime"
      : "chatgpt-default";
  var options = CHATGPT_SUGGESTIONS.map(function (o) {
    return Object.assign({}, o);
  });
  if (
    selected &&
    !options.some(function (o) {
      return o.value === selected;
    })
  ) {
    options.unshift({
      value: selected,
      label: selected,
      description: "Custom model",
    });
  }
  return {
    backend: "chatgpt",
    selected: selected,
    configured: "",
    lastRuntime: lastRuntime,
    effective: effective,
    source: source,
    sourceLabel:
      source === "plugin"
        ? "Paper Reading Agent setting"
        : source === "last-runtime"
          ? "last reported response"
          : "ChatGPT default (gpt-5)",
    resolved: !!effective,
    options: options,
    catalogAvailable: false,
    note: "ChatGPT quota is used via the local OpenAI-compatible gateway (chat2api).",
  };
}

function backendLabel(id) {
  return id === "claude"
    ? "Claude Code"
    : id === "codex"
      ? "Codex"
      : id === "chatgpt"
        ? "ChatGPT"
        : clean(id);
}

export function messageModelLabel(message) {
  if (!message || message.role !== "assistant") return "";
  var label = backendLabel(message.backend);
  if (!label) return ""; // historical messages did not persist their backend
  var model = clean(message.model);
  var requested = clean(message.requestedModel);
  var out = label;
  if (model) out += " · " + model;
  else if (requested) out += " · requested " + requested;
  else out += " · resolving model…";
  if (model && clean(message.reasoningEffort))
    out += " · " + clean(message.reasoningEffort);
  return out;
}

export function backendStatusLabel(info) {
  info = info || {};
  var label = clean(info.label) || backendLabel(info.id) || "Backend";
  if (!info.ok) return clean(info.error) || label + " unavailable";
  var parts = [label + " ready"];
  if (clean(info.version)) parts.push(clean(info.version));
  var modelInfo = info.modelInfo || {};
  if (clean(modelInfo.effective))
    parts.push("model " + clean(modelInfo.effective));
  else parts.push("model resolves on next response");
  return parts.join(" · ");
}
