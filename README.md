# Paper Reading Agent

A **Zotero 9 plugin**: chat with the paper you have open in Zotero. A **Paper
Reading Agent** panel docks in the right-hand item pane — beside the PDF in the
reader, and in the library item pane — automatically scoped to the selected
paper.

The "agent" is a **local CLI you already have**: either **Codex**
(`@openai/codex`) or **Claude Code** (`claude`). The plugin spawns it as a
read-only subprocess, points it at that one paper, and streams the answer back
into the panel — with Markdown + math, and **clickable `[p.N]` citations that
jump the PDF reader to the exact sentence**. Everything runs locally under your
own CLI login: no cloud backend, no API key to paste.

## Features

- **Two backends, one UI.** Codex or Claude Code, switched in Settings. Each
  paper keeps a separate conversation handle per backend, so you can switch
  without losing either thread.
- **Live token streaming.** Codex runs as a persistent `codex app-server`
  (JSON-RPC) for true token-level deltas; Claude Code runs `claude -p` per turn.
  Lumpy output is smoothed by an adaptive typewriter buffer.
- **Markdown + math.** Answers render as Markdown with KaTeX math. Model output
  is sanitized with DOMPurify before it ever touches the panel.
- **Verified citations.** The agent cites claims as `[p.N "verbatim quote"]`.
  After each answer the plugin looks the quote up in its own page-indexed
  extraction of the PDF and **corrects the page number if the agent got it
  wrong**. Clicking a citation highlights the passage in the reader.
- **Screenshot input.** Paste an image straight into the composer (⌘V) to ask
  about a figure or a region of the page.
- **Per-paper memory.** One multi-turn conversation per attachment, persisted to
  disk and restored when you come back to the paper.
- **Turns survive the UI.** Switching tabs, clicking a citation, or changing
  items re-renders the item pane; a running turn keeps going and the panel
  re-attaches to it.
- **Read-only by design.** Codex runs with `--sandbox read-only` and
  `approval_policy=never`; Claude Code runs with an allowlist limited to `Read`,
  `Bash(pdftotext:*)` and (optionally) web search, with `Write`/`Edit` denied.
- **In-app updates.** Settings has a "Check for updates" button, and Zotero also
  picks up new releases on its own.

## Prerequisites

- **Zotero 9** (desktop). Verified on Zotero 9.0.4.
- **At least one agent CLI**, installed and logged in:
  - **Codex** — verified against codex-cli 0.130 and 0.141:
    ```bash
    npm install -g @openai/codex
    codex login
    ```
  - **Claude Code** — verified against claude 2.1.183:
    ```bash
    npm install -g @anthropic-ai/claude-code
    claude   # then /login
    ```
- **poppler / `pdftotext`** — the plugin uses it to build the page-indexed text
  of each PDF:
  - macOS: `brew install poppler`
  - Linux: `apt install poppler-utils`
  - Windows: `choco install poppler`

## Install

1. **Get `paper-reading-agent.xpi`** — download it from the
   [Releases](https://github.com/xiaoxuanli-a/zotero_agent_reader_plugin/releases)
   page, or build it yourself:
   ```bash
   npm install
   npm run build   # outputs .scaffold/build/paper-reading-agent.xpi
   ```
2. In Zotero: **Tools → Plugins → ⚙ (gear icon) → Install Plugin From File…** →
   pick `paper-reading-agent.xpi`, then **restart Zotero**.
3. Open **Settings → Paper Reading Agent** and pick your backend (Codex is the
   default). Click **Test connection** — it should report
   `<Backend> ready · <version> · model <name>`.
4. Select an item that has a PDF (or open it in the reader). A **Paper Reading
   Agent** section appears in the right-hand item pane. Ask a question.

> **macOS PATH:** a GUI-launched Zotero does not inherit your shell `PATH`. The
> plugin handles this itself — it searches the usual install dirs and, failing
> that, asks your login shell where the binary is. If "Test connection" still
> can't find the CLI, set its absolute path (`which codex` / `which claude`) in
> Settings.

## Usage

- Type a question and press **Enter** (Shift+Enter for a newline). The answer
  streams in, rendered as Markdown + math.
- Paste an image (⌘V / Ctrl+V) into the composer to attach a screenshot to the
  next question. Click **×** on a thumbnail to drop it.
- When the agent states something from the paper it adds a citation pill showing
  the page and the quoted text. **Click it to jump the reader to that passage**
  — the exact sentence is highlighted when the quote can be located in the PDF
  text layer, otherwise the page is simply opened.
- Citations carry their verification state, visible on hover:

  | Appearance   | Meaning                                                      |
  | ------------ | ------------------------------------------------------------ |
  | plain        | the quote was found on exactly the page the agent cited      |
  | green border | the agent's page was wrong; the plugin corrected it          |
  | dashed       | quote not found, or found on several pages — page kept as-is |

- **Stop** cancels a running turn (the partial answer is kept). Each paper keeps
  its own conversation, and you can switch between papers freely — turns for
  different papers can even run at the same time.

## Settings

**Settings → Paper Reading Agent.** Only the active backend's group is shown.

| Group           | Setting           | Notes                                                                                 |
| --------------- | ----------------- | ------------------------------------------------------------------------------------- |
| —               | Agent backend     | `Codex` (default) or `Claude Code`.                                                   |
| **Codex**       | Path              | Optional; leave empty to auto-detect.                                                 |
|                 | Model             | Free-text with a picker filled from Codex's own model list (**Refresh** re-reads it). |
|                 | Reasoning effort  | `Default` / `minimal` / `low` / `medium` / `high` — lower is faster and less deep.    |
| **Claude Code** | Path              | Optional; leave empty to auto-detect.                                                 |
|                 | Model             | Free-text with alias suggestions (`fable`, `sonnet`, `opus`, `haiku`).                |
|                 | Permission mode   | `default` (read-only) — the plugin applies its own allowlist on top.                  |
| **General**     | Enable web search | On by default.                                                                        |
|                 | Turn timeout      | Seconds, 30–3600 (default 600).                                                       |
| **Updates**     | Check for updates | On-demand check; **Install update** appears when a newer release exists.              |

Every setting is also a pref under `extensions.paper-reading-agent.` in
**Settings → Advanced → Config Editor**: `backend`, `codexPath`, `model`,
`reasoningEffort`, `claudePath`, `claudeModel`, `permissionMode`, `webSearch`,
`timeoutSec`. (`codexLastModel` / `claudeLastModel` are written by the plugin to
remember the model a backend last reported — not meant to be edited.)

> Codex rejects `reasoningEffort = minimal` together with web search. The plugin
> quietly raises it to `low` for that turn rather than failing.

## Where data lives

Under your Zotero data directory, in `paper-reading-agent/`:

- `conversations/<attachmentKey>.json` — the transcript plus one resume handle
  per backend.
- `work/<attachmentKey>/` — the agent's working directory for that paper:
  `AGENTS.md` / `CLAUDE.md` (generated instructions), the page-indexed text
  extraction, and any images you attached.

The PDF itself is **never copied** — the instruction file points the agent at
Zotero's own attachment path.

## How it works

```
addon/bootstrap.js → src/index.ts → src/hooks.ts       lifecycle, section + prefs pane
                                         ↓
                              modules/chatPanel.ts     the item-pane UI
                                         ↓
                              modules/chatService.ts   one turn: persist → stream → verify → persist
                                         ↓
                              modules/backends.ts      backend registry
                                    ↙          ↘
                    modules/appServer.ts    modules/claudeDriver.ts
```

- **`backends.ts`** is the only module that knows which driver implements which
  backend. Everything above it speaks one neutral contract — `runTurn(...)`
  emitting `thread_started | runtime_info | delta | tool | done | error`. Adding
  a backend means writing a driver and adding one registry entry.
- **`appServer.ts`** keeps a single persistent `codex app-server` process and
  multiplexes turns over it by thread id, so several papers can stream at once.
  **`claudeDriver.ts`** is the one-process-per-turn analogue, resuming by session
  id.
- **`codexEnv.ts`** locates the CLI binaries and builds their environment (the
  macOS PATH problem above, plus `USER`/`LOGNAME` for Claude's keychain login).
- **`pdfTextIndex.ts`** runs `pdftotext`, splits the pages **in plugin code**,
  and writes a cached text file where each page starts with an explicit
  `<<<PRA_PHYSICAL_PDF_PAGE:N>>>` marker — so the agent copies a page number
  instead of guessing one.
- **`referenceResolver.ts`** uses that same page array to verify or correct each
  quote after the turn, and at click time resolves the quote to exact reader
  coordinates.
- **`render.ts`** turns answer text into safe HTML: citations and math are pulled
  out, Markdown is parsed, the result is **DOMPurify-sanitized**, then math and
  citation pills are substituted back in.

## Development

Built on
[windingwind's `zotero-plugin-template`](https://github.com/windingwind/zotero-plugin-template)
(TypeScript + esbuild via `zotero-plugin-scaffold`).

```bash
npm install
npm start           # launch a dev Zotero with hot-reload
npm run build       # produce .scaffold/build/paper-reading-agent.xpi
npm run test:unit   # node --test — pure-logic unit tests, no Zotero needed
npm test            # scaffold's in-Zotero test runner
npm run lint:check  # prettier --check + eslint
```

Layout:

| Path              | What                                                           |
| ----------------- | -------------------------------------------------------------- |
| `src/modules/`    | all plugin logic (see the diagram above)                       |
| `addon/`          | static shell: `bootstrap.js`, `manifest.json`, `prefs.js`, FTL |
| `addon/content/`  | Settings pane, icons, KaTeX stylesheet + fonts                 |
| `test/*.test.mjs` | Node unit tests for the Zotero-free modules                    |
| `typings/`        | ambient types for the privileged globals                       |

Modules under `src/modules/` are deliberately written in a plain, ES5-flavoured
style (`var`, `// @ts-nocheck`) because they run as privileged chrome code and
were ported 1:1 from the original JS implementation; the eslint config carves
out exactly those rules. Match the surrounding style when editing them, and keep
Zotero/Gecko globals out of anything that has a unit test.

### Releasing

1. Bump `version` in `package.json` **and** `package-lock.json`.
2. Commit, then `git tag vX.Y.Z && git push origin main --tags`.

[`release.yml`](.github/workflows/release.yml) builds the xpi, creates the GitHub
release, and rewrites the root `updates.json` that the manifest's `update_url`
points at — which is how installed copies auto-update.

## License

**AGPL-3.0-or-later** (see [`LICENSE`](LICENSE)). Bundled third-party libraries
(marked, KaTeX, DOMPurify) keep their own permissive licenses — see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

> **Note:** the `codex app-server` JSON-RPC protocol this plugin drives is marked
> _experimental_ by Codex. It has been verified unchanged across codex-cli 0.130
> and 0.141, but a future Codex release could still change it and require an
> update here.
