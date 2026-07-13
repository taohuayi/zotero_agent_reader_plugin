// @ts-nocheck
/*
 * updater.ts — on-demand "check for updates" (Zotero / privileged chrome only).
 *
 * Zotero is Gecko-based, so updates go through the toolkit AddonManager against the
 * plugin's configured update_url (the repo's root updates.json — see the manifest).
 * findUpdates(..., UPDATE_WHEN_USER_REQUESTED) runs the SAME check as Zotero's own
 * "Check for Updates", but on demand when the user clicks the Settings button — no
 * fixed daily schedule. If a newer compatible version is published, the AddonInstall
 * it returns is stashed so the Settings pane can install it with one click (the
 * update is applied on the next Zotero restart).
 */

function getAddonManager() {
  return ChromeUtils.importESModule(
    "resource://gre/modules/AddonManager.sys.mjs",
  ).AddonManager;
}
function log(m) {
  try {
    Zotero.debug("[PaperReadingAgent] updater: " + m);
  } catch (e) {}
}

// an AddonInstall in STATE_AVAILABLE produced by the last successful check, or null
var pendingInstall = null;

// Resolve { status, current, available?, error? }:
//   "latest"    — already on the newest published version
//   "available" — a newer version exists (stashed for installPendingUpdate)
//   "error"     — the check failed (network, parse, add-on missing, timeout, …)
export async function checkForUpdates(addonID) {
  pendingInstall = null;
  var AddonManager = getAddonManager();
  var addon;
  try {
    addon = await AddonManager.getAddonByID(addonID);
  } catch (e) {
    return { status: "error", error: String(e) };
  }
  if (!addon)
    return { status: "error", error: "add-on not found (" + addonID + ")" };

  return await new Promise(function (resolve) {
    var settled = false;
    var found = null;
    var timer = null;
    function done(r) {
      if (settled) return;
      settled = true;
      if (timer) {
        try {
          clearTimeout(timer);
        } catch (e) {}
      }
      resolve(r);
    }
    // the check is a network round-trip; don't hang the button forever
    timer = setTimeout(function () {
      done({
        status: "error",
        current: addon.version,
        error: "update check timed out",
      });
    }, 30000);

    var listener = {
      onUpdateAvailable: function (a, install) {
        found = install;
      },
      onNoUpdateAvailable: function () {},
      onUpdateFinished: function (a, error) {
        // error is an AddonManager.UPDATE_STATUS_* code; 0 (NO_ERROR) is falsy
        if (error) {
          done({
            status: "error",
            current: addon.version,
            error: "update check failed (code " + error + ")",
          });
          return;
        }
        if (found) {
          pendingInstall = found;
          done({
            status: "available",
            current: addon.version,
            available: found.version,
          });
        } else done({ status: "latest", current: addon.version });
      },
    };
    try {
      addon.findUpdates(listener, AddonManager.UPDATE_WHEN_USER_REQUESTED);
    } catch (e) {
      done({ status: "error", current: addon.version, error: String(e) });
    }
  });
}

// Install the version found by the last checkForUpdates. Resolves { ok, version?, error? }.
// The update is staged and applies on the next Zotero restart.
export async function installPendingUpdate() {
  if (!pendingInstall)
    return { ok: false, error: "no pending update — run a check first" };
  var install = pendingInstall;
  return await new Promise(function (resolve) {
    var settled = false;
    var listener = {
      onInstallEnded: function () {
        pendingInstall = null;
        finish({ ok: true, version: install.version });
      },
      onInstallFailed: function () {
        finish({ ok: false, error: "install failed" });
      },
      onDownloadFailed: function () {
        finish({ ok: false, error: "download failed" });
      },
    };
    function finish(r) {
      if (settled) return;
      settled = true;
      try {
        install.removeListener(listener);
      } catch (e) {}
      resolve(r);
    }
    try {
      install.addListener(listener);
      install.install();
    } catch (e) {
      finish({ ok: false, error: String(e) });
    }
  });
}
