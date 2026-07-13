// @ts-nocheck
/*
 * codexEnv.ts — locate a backend CLI binary (`codex`, `claude`, …) + build the
 * environment to run it in. Shared by every backend driver.
 *
 * GUI-launched Zotero does NOT inherit the login shell's PATH, so a binary in a
 * non-standard dir (nvm/volta/asdf, ~/.local/bin from a self-update, …) is
 * invisible to a bare pathSearch. Resolution order (per binary):
 *   1. explicit *Path pref — always wins.
 *   2. FAST PATH: augment PATH with the usual bin dirs, then pathSearch.
 *   3. FALLBACK: ask the user's LOGIN shell where the binary is + what PATH it
 *      uses (`$SHELL -lic`), exactly how VS Code & co. resolve the shell env.
 *      Result is cached per binary (we spawn the shell at most once each).
 * Windows is left to the OS PATH (GUI apps inherit the system env there).
 *
 * resolveCodex/resolveClaude are thin wrappers over the generic resolveBinary.
 * claude needs `injectUser`: its OAuth token lives in the macOS keychain keyed on
 * the USER env var, so a spawn env with HOME but no USER fails as "Not logged in".
 */

function getSubprocess() {
  return ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs")
    .Subprocess;
}

function isWindows() {
  try {
    return Services.appinfo.OS === "WINNT";
  } catch (e) {
    return false;
  }
}

function log(m) {
  try {
    Zotero.debug("[PaperReadingAgent] codexEnv: " + m);
  } catch (e) {
    /* ignore */
  }
}

// Usual package-manager bin dirs (fast path — no shell spawn). ~/.local/bin is
// where `codex update` / the claude installer self-install; listed first so it
// beats an older `npm i -g` copy in /opt/homebrew/bin.
function commonBins(env, pathPref) {
  var extra = [];
  if (pathPref) {
    var i = pathPref.lastIndexOf("/");
    if (i > 0) extra.push(pathPref.slice(0, i));
  }
  if (env.HOME) extra.push(env.HOME + "/.local/bin");
  return extra.concat([
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ]);
}

// Prepend dirs not already present to env.PATH. Mutates + returns env.
function augmentEnvPath(env, pathPref) {
  if (isWindows()) return env;
  var extra = commonBins(env, pathPref);
  var parts = (env.PATH || "").split(":").filter(Boolean);
  var pre = [];
  for (var e = 0; e < extra.length; e++) {
    if (extra[e] && pre.indexOf(extra[e]) < 0 && parts.indexOf(extra[e]) < 0)
      pre.push(extra[e]);
  }
  env.PATH = pre.concat(parts).join(":");
  return env;
}

// Some CLIs (claude) read their credentials from the macOS keychain keyed on the
// USER identity, which a GUI-launched app may not propagate. Derive USER/LOGNAME
// from the existing env or the HOME basename so the keychain lookup resolves.
function ensureUser(env) {
  if (isWindows()) return env;
  var user = env.USER || env.LOGNAME;
  if (!user && env.HOME) {
    var h = env.HOME.replace(/\/+$/, "");
    var j = h.lastIndexOf("/");
    if (j >= 0) user = h.slice(j + 1);
  }
  if (user) {
    if (!env.USER) env.USER = user;
    if (!env.LOGNAME) env.LOGNAME = user;
  }
  return env;
}

// per-binary cached Promise<{ bin: <abs path|null>, path: <login PATH|null> }>.
// Only a SUCCESSFUL resolution (bin found) is memoised — see resolveViaLoginShell.
var SHELL_CACHE = Object.create(null);
export function clearCache() {
  SHELL_CACHE = Object.create(null);
}

function between(s, a, b) {
  var i = s.indexOf(a);
  if (i < 0) return null;
  var j = s.indexOf(b, i + a.length);
  if (j < 0) return null;
  return s.slice(i + a.length, j).trim();
}

// Spawn the user's LOGIN shell to capture the binary's location + the real PATH.
// De-dupes concurrent callers (they await the SAME in-flight promise, so a second
// paper asked at once never reads a half-filled result), and only KEEPS a
// successful resolution cached: a transient failure (timeout / spawn error / the
// binary genuinely absent) is evicted so a later turn retries, instead of the
// whole session being stuck behind a poisoned null.
function resolveViaLoginShell(Subprocess, env, binName) {
  if (SHELL_CACHE[binName]) return SHELL_CACHE[binName];
  var promise = runLoginShell(Subprocess, env, binName);
  SHELL_CACHE[binName] = promise;
  promise.then(
    function (r) {
      if ((!r || !r.bin) && SHELL_CACHE[binName] === promise)
        delete SHELL_CACHE[binName];
    },
    function () {
      if (SHELL_CACHE[binName] === promise) delete SHELL_CACHE[binName];
    },
  );
  return promise;
}

// Actually spawn the shell and parse its output. NEVER rejects (resolves to
// { bin:null, path:null } on timeout/error); caching + de-dup is the wrapper's job.
async function runLoginShell(Subprocess, env, binName) {
  var cached = { bin: null, path: null };
  if (isWindows()) return cached;
  var shell = env.SHELL || "/bin/bash";
  // -l login (sources profile) + -i interactive (sources rc, where PATH edits
  // usually live) + -c run-and-exit. START/END markers survive rc banner noise.
  var script =
    "echo __PRA_C_S__; command -v " +
    binName +
    " 2>/dev/null; echo __PRA_C_E__; " +
    'echo __PRA_P_S__; echo "$PATH"; echo __PRA_P_E__';
  var proc = null;
  try {
    proc = await Subprocess.call({
      command: shell,
      arguments: ["-lic", script],
      environment: env,
      environmentAppend: true,
      stderr: "pipe",
    });
    try {
      proc.stdin.close();
    } catch (e) {
      /* ignore */
    }
    var readAll = (async function () {
      var out = "",
        c;
      while ((c = await proc.stdout.readString())) out += c;
      return out;
    })();
    // a heavy rc (instant-prompt, etc.) could hang; bail after 6s.
    var timer = new Promise(function (res) {
      setTimeout(function () {
        res(null);
      }, 6000);
    });
    var out = await Promise.race([readAll, timer]);
    if (out === null) {
      log("login-shell timed out for " + binName);
      try {
        proc.kill();
      } catch (e) {
        /* ignore */
      }
      return cached;
    }
    try {
      await proc.wait();
    } catch (e) {
      /* ignore */
    }
    var bin = between(out, "__PRA_C_S__", "__PRA_C_E__");
    var path = between(out, "__PRA_P_S__", "__PRA_P_E__");
    if (bin) cached.bin = bin.split("\n").filter(Boolean).pop();
    if (path) cached.path = path.split("\n").filter(Boolean).pop();
    log(
      "login-shell: " +
        binName +
        "=" +
        cached.bin +
        " pathLen=" +
        (cached.path ? cached.path.length : 0),
    );
  } catch (e) {
    log("login-shell failed for " + binName + ": " + e);
    if (proc) {
      try {
        proc.kill();
      } catch (e2) {
        /* ignore */
      }
    }
  }
  return cached;
}

// Resolve { command, env } to spawn `binName` with. `env` already has an augmented
// PATH so the binary's own child processes resolve too. Throws if not found.
//   pathPref      — an explicit absolute path pref (wins if set)
//   options.injectUser — ensure USER/LOGNAME are present (claude keychain auth)
export async function resolveBinary(binName, pathPref, opts, options) {
  options = options || {};
  var Subprocess = getSubprocess();
  var env = augmentEnvPath(Subprocess.getEnvironment(), pathPref);
  if (options.injectUser) ensureUser(env);

  // 1. explicit pref wins
  if (pathPref) return { command: pathPref, env: env };

  // 2. fast path: pathSearch over the whitelisted PATH
  try {
    return { command: await Subprocess.pathSearch(binName, env), env: env };
  } catch (e) {
    /* fall through to the login shell */
  }

  // 3. fallback: ask the login shell, and merge its PATH so children resolve
  var r = await resolveViaLoginShell(Subprocess, env, binName);
  if (r.path) {
    var parts = (env.PATH || "").split(":").filter(Boolean);
    var add = r.path
      .split(":")
      .filter(Boolean)
      .filter(function (d) {
        return parts.indexOf(d) < 0;
      });
    if (add.length) env.PATH = parts.concat(add).join(":");
  }
  if (r.bin) return { command: r.bin, env: env };
  // last try with the merged login PATH
  try {
    return { command: await Subprocess.pathSearch(binName, env), env: env };
  } catch (e) {
    throw new Error(
      binName +
        " not found — install it, or set its absolute path in preferences.",
      { cause: e },
    );
  }
}

// codex: file-based auth (~/.codex/auth.json), no USER needed.
export async function resolveCodex(opts) {
  opts = opts || {};
  return resolveBinary("codex", opts.codexPath, opts, {});
}

// claude: keychain OAuth — MUST inject USER (see ensureUser).
export async function resolveClaude(opts) {
  opts = opts || {};
  return resolveBinary("claude", opts.claudePath, opts, { injectUser: true });
}
