// Default prefs. Keys are SHORT here; zotero-plugin-scaffold prefixes them with
// `extensions.paper-reading-agent.` at build time AND rewrites preference="<key>"
// in content/preferences.xhtml to the same full key. An empty string means "use
// the backend's own default" (chatPanel.prefs() treats ""/undefined as unset).
// Edit via Settings → Paper Reading Agent (or Advanced → Config Editor).
pref("backend", "chatgpt"); // codex | claude | chatgpt (default: ChatGPT via chat2api — no Codex quota)
pref("codexPath", ""); // absolute path to the codex binary (else search PATH)
pref("model", ""); // codex model (else codex config)
pref("codexLastModel", ""); // last model actually reported by codex app-server
pref("reasoningEffort", ""); // codex: minimal | low | medium | high
pref("claudePath", ""); // absolute path to the claude binary (else search PATH)
pref("claudeModel", ""); // claude: sonnet | haiku | opus | … (else claude default)
pref("claudeLastModel", ""); // last model actually reported by Claude Code
pref("permissionMode", "default"); // claude permission mode (default = read-only allowlist)
// chatgpt backend: OpenAI-compatible gateway (chat2api) that uses ChatGPT quota.
pref("chatgptEndpoint", ""); // base URL (default http://127.0.0.1:5005/v1)
pref("chatgptToken", ""); // access token; empty = read ~/.codex/chat2api/data/token.txt
pref("chatgptModel", ""); // gpt-5.6 | gpt-5 | gpt-4o | o3-mini | … (default gpt-5)
pref("chatgptLastModel", ""); // last model actually reported by the gateway
pref("webSearch", true);
pref("timeoutSec", 600);
// Off by default: it lets the agent read the WHOLE library (catalog, your
// annotations/notes, and Zotero's full-text extraction cache), not just the
// open paper — so more of your library reaches the CLI's provider.
pref("libraryAccess", false);
