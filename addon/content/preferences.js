/* eslint-disable no-undef */
/*
 * preferences.js — runs in the Zotero preferences window when the Paper Reading
 * Agent pane loads (registered via Zotero.PreferencePanes.register({scripts})).
 * Most controls auto-bind via a preference key; this only (a) shows the active
 * backend's group and hides the other, (b) runs the "Test connection" button, and
 * (c) runs the on-demand "Check for updates" / "Install update" buttons.
 * Degrades gracefully: if anything isn't ready, both groups simply stay visible.
 */
var PaperReadingAgentPrefs = {
  PREFIX: "extensions.paper-reading-agent.",
  _wired: false,
  _modelLoaded: Object.create(null),
  _modelRefreshToken: Object.create(null),

  sync: function (backendOverride) {
    try {
      var backend =
        backendOverride ||
        Zotero.Prefs.get(this.PREFIX + "backend", true) ||
        "codex";
      var codex = document.getElementById("pra-codex-group");
      var claude = document.getElementById("pra-claude-group");
      var chatgpt = document.getElementById("pra-chatgpt-group");
      if (codex) codex.hidden = backend !== "codex";
      if (claude) claude.hidden = backend !== "claude";
      if (chatgpt) chatgpt.hidden = backend !== "chatgpt";
      // Zotero executes pane scripts before inserting the XHTML fragment. The
      // immediate init() therefore sees no controls; only mark/load the model
      // data once the deferred init can actually find the pane DOM.
      var modelNodes = this._modelElements(backend);
      if (
        (modelNodes.input || modelNodes.status) &&
        !this._modelLoaded[backend]
      )
        this.refreshModels(backend);
    } catch (e) {
      /* leave both visible */
    }
  },

  _modelElements: function (backend) {
    return {
      input: document.getElementById("pra-" + backend + "-model"),
      list: document.getElementById("pra-" + backend + "-models"),
      status: document.getElementById("pra-" + backend + "-model-status"),
    };
  },

  _setText: function (node, value) {
    if (!node) return;
    node.textContent = value;
    try {
      node.value = value;
    } catch (e) {}
  },

  _populateModels: function (list, options) {
    if (!list) return;
    while (list.firstChild) list.removeChild(list.firstChild);
    (options || []).forEach(function (model) {
      if (!model || !model.value) return;
      var option = document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "option",
      );
      option.value = model.value;
      if (model.label && model.label !== model.value)
        option.label = model.label;
      if (model.description) option.title = model.description;
      list.appendChild(option);
    });
  },

  _modelSummary: function (modelInfo) {
    if (!modelInfo)
      return "Model information is unavailable; you can still enter a model name.";
    if (modelInfo.source === "last-runtime" && modelInfo.effective)
      return (
        "Last reported: " +
        modelInfo.effective +
        " · leave blank to follow the backend default"
      );
    if (modelInfo.effective)
      return (
        "Will use: " +
        modelInfo.effective +
        " · " +
        (modelInfo.sourceLabel || "resolved model") +
        " · applies from the next message"
      );
    return "Using the backend default · the actual model will appear on the next response";
  },

  refreshModels: async function (backend) {
    backend =
      backend === "claude" ? "claude" : backend === "chatgpt" ? "chatgpt" : "codex";
    this._modelLoaded[backend] = true;
    var token = (this._modelRefreshToken[backend] || 0) + 1;
    this._modelRefreshToken[backend] = token;
    var nodes = this._modelElements(backend);
    this._setText(nodes.status, "Loading model information…");
    try {
      var api = Zotero.PaperReadingAgent;
      if (!api || !api.getBackendInfo) {
        this._setText(nodes.status, "Plugin model API is not ready yet.");
        return;
      }
      var info = await api.getBackendInfo(backend, true);
      if (this._modelRefreshToken[backend] !== token) return;
      var modelInfo = info && info.modelInfo;
      this._populateModels(nodes.list, modelInfo && modelInfo.options);
      if (modelInfo && modelInfo.note && nodes.status)
        nodes.status.setAttribute("tooltiptext", modelInfo.note);
      var summary = this._modelSummary(modelInfo);
      if (!info || !info.ok)
        summary =
          "Backend unavailable: " +
          ((info && info.error) || "connection failed") +
          " · model names remain editable";
      else if (info.modelError)
        summary += " · catalog unavailable: " + info.modelError;
      this._setText(nodes.status, summary);
    } catch (e) {
      if (this._modelRefreshToken[backend] === token)
        this._setText(
          nodes.status,
          "Could not load models: " + e + " · model names remain editable",
        );
    }
  },

  resetModel: function (backend) {
    backend =
      backend === "claude" ? "claude" : backend === "chatgpt" ? "chatgpt" : "codex";
    var pref =
      backend === "claude"
        ? "claudeModel"
        : backend === "chatgpt"
          ? "chatgptModel"
          : "model";
    try {
      Zotero.Prefs.set(this.PREFIX + pref, "", true);
    } catch (e) {}
    var nodes = this._modelElements(backend);
    if (nodes.input) nodes.input.value = "";
    this.refreshModels(backend);
  },

  _wireModel: function (backend, pref) {
    var self = this;
    var nodes = this._modelElements(backend);
    if (nodes.input && !nodes.input._praWired) {
      nodes.input.addEventListener("change", function () {
        try {
          Zotero.Prefs.set(
            self.PREFIX + pref,
            String(nodes.input.value || "").trim(),
            true,
          );
        } catch (e) {}
        self.refreshModels(backend);
      });
      nodes.input._praWired = true;
    }
    var reset = document.getElementById("pra-" + backend + "-model-default");
    if (reset && !reset._praWired) {
      reset.addEventListener("command", function () {
        self.resetModel(backend);
      });
      reset._praWired = true;
    }
    var refresh = document.getElementById("pra-" + backend + "-model-refresh");
    if (refresh && !refresh._praWired) {
      refresh.addEventListener("command", function () {
        self.refreshModels(backend);
      });
      refresh._praWired = true;
    }
  },

  test: async function () {
    var status = document.getElementById("pra-test-status");
    function setStatus(s) {
      if (status) status.value = s;
    }
    setStatus("Testing…");
    try {
      var api = Zotero.PaperReadingAgent;
      if (!api || !api.healthcheck) {
        setStatus("plugin not ready — open a paper first");
        return;
      }
      var h = api.getBackendInfo
        ? await api.getBackendInfo()
        : await api.healthcheck();
      var model = h && h.modelInfo && h.modelInfo.effective;
      setStatus(
        h && h.ok
          ? "✓ " +
              (h.label || "backend") +
              " ready · " +
              (h.version || "") +
              " · " +
              (model ? "model " + model : "model resolves on next response")
          : "✗ " + ((h && h.error) || "unavailable"),
      );
    } catch (e) {
      setStatus("✗ " + e);
    }
  },

  // On-demand update check (no fixed schedule — runs when the user clicks).
  checkUpdates: async function () {
    var status = document.getElementById("pra-update-status");
    var installBtn = document.getElementById("pra-install-update");
    function setStatus(s) {
      if (status) status.value = s;
    }
    if (installBtn) installBtn.hidden = true;
    setStatus("Checking…");
    try {
      var api = Zotero.PaperReadingAgent;
      if (!api || !api.checkForUpdates) {
        setStatus("plugin not ready — open a paper first");
        return;
      }
      var r = await api.checkForUpdates();
      if (r && r.status === "available") {
        setStatus(
          "Update available: " +
            (r.available || "?") +
            " (current " +
            (r.current || "?") +
            ")",
        );
        if (installBtn) installBtn.hidden = false;
      } else if (r && r.status === "latest") {
        setStatus("✓ You're on the latest version (" + (r.current || "") + ")");
      } else {
        setStatus("✗ " + ((r && r.error) || "check failed"));
      }
    } catch (e) {
      setStatus("✗ " + e);
    }
  },

  // Install the version found by the last check; applies on the next restart.
  installUpdate: async function () {
    var status = document.getElementById("pra-update-status");
    var installBtn = document.getElementById("pra-install-update");
    function setStatus(s) {
      if (status) status.value = s;
    }
    setStatus("Installing…");
    if (installBtn) installBtn.disabled = true;
    try {
      var api = Zotero.PaperReadingAgent;
      if (!api || !api.installUpdate) {
        setStatus("plugin not ready");
        if (installBtn) installBtn.disabled = false;
        return;
      }
      var r = await api.installUpdate();
      if (r && r.ok) {
        setStatus(
          "✓ Installed " + (r.version || "") + " — restart Zotero to apply.",
        );
        if (installBtn) installBtn.hidden = true;
      } else {
        setStatus("✗ " + ((r && r.error) || "install failed"));
        if (installBtn) installBtn.disabled = false;
      }
    } catch (e) {
      setStatus("✗ " + e);
      if (installBtn) installBtn.disabled = false;
    }
  },

  // attach listeners (once) + set initial visibility. Safe to call repeatedly.
  init: function () {
    try {
      var self = this;
      var backend = document.getElementById("pra-backend");
      if (backend && !self._wired) {
        backend.addEventListener("command", function () {
          var value = backend.value === "claude" ? "claude" : "codex";
          try {
            Zotero.Prefs.set(self.PREFIX + "backend", value, true);
          } catch (e) {}
          self.sync(value);
        });
        self._wired = true;
      }
      self._wireModel("codex", "model");
      self._wireModel("claude", "claudeModel");
      self._wireModel("chatgpt", "chatgptModel");
      var testBtn = document.getElementById("pra-test");
      if (testBtn && !testBtn._praWired) {
        testBtn.addEventListener("command", function () {
          self.test();
        });
        testBtn._praWired = true;
      }
      var checkBtn = document.getElementById("pra-check-update");
      if (checkBtn && !checkBtn._praWired) {
        checkBtn.addEventListener("command", function () {
          self.checkUpdates();
        });
        checkBtn._praWired = true;
      }
      var installBtn = document.getElementById("pra-install-update");
      if (installBtn && !installBtn._praWired) {
        installBtn.addEventListener("command", function () {
          self.installUpdate();
        });
        installBtn._praWired = true;
      }
      self.sync();
    } catch (e) {
      /* ignore */
    }
  },
};

// Zotero loads pane scripts into a sandbox BEFORE inserting the XHTML fragment.
// `showing` is dispatched after insertion every time the pane is displayed, so
// it is the reliable lifecycle hook. Keep the immediate/timer attempts as
// compatibility fallbacks for Zotero versions that load scripts later.
PaperReadingAgentPrefs.init();
try {
  document.addEventListener(
    "showing",
    function () {
      PaperReadingAgentPrefs.init();
    },
    true,
  );
} catch (e) {
  /* older preferences documents */
}
try {
  if (window && typeof window.setTimeout === "function")
    window.setTimeout(function () {
      PaperReadingAgentPrefs.init();
    }, 0);
} catch (e) {
  if (typeof setTimeout === "function")
    setTimeout(function () {
      PaperReadingAgentPrefs.init();
    }, 0);
}
