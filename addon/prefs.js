// Default prefs. Keys are SHORT here; zotero-plugin-scaffold prefixes them with
// `extensions.paper-reading-agent.` at build time AND rewrites preference="<key>"
// in content/preferences.xhtml to the same full key. An empty string means "use
// the backend's own default" (chatPanel.prefs() treats ""/undefined as unset).
// Edit via Settings → Paper Reading Agent (or Advanced → Config Editor).
pref("backend", "codex"); // codex | claude
pref("codexPath", ""); // absolute path to the codex binary (else search PATH)
pref("model", ""); // codex model (else codex config)
pref("codexLastModel", ""); // last model actually reported by codex app-server
pref("reasoningEffort", ""); // codex: minimal | low | medium | high
pref("claudePath", ""); // absolute path to the claude binary (else search PATH)
pref("claudeModel", ""); // claude: sonnet | haiku | opus | … (else claude default)
pref("claudeLastModel", ""); // last model actually reported by Claude Code
pref("permissionMode", "default"); // claude permission mode (default = read-only allowlist)
pref("webSearch", true);
pref("timeoutSec", 600);
// Off by default: it lets the agent read the WHOLE library (catalog, your
// annotations/notes, and Zotero's full-text extraction cache), not just the
// open paper — so more of your library reaches the CLI's provider.
pref("libraryAccess", false);
