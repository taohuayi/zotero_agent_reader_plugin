# Paper Reading Agent

A **Zotero 9 plugin**: chat with the paper you have open in Zotero. A
**"Codex Chat"** panel docks in the right-hand item pane (beside the PDF in the
reader). The "agent" is a **local `codex` CLI** scoped to that paper — it reads
the PDF (`pdftotext`), can search the web, and answers with **live
token-by-token streaming**, **Markdown + math (KaTeX)**, and **clickable `[p.N]`
citations that jump the PDF reader to the source page**. One conversation per
paper, with multi-turn memory. Everything runs locally with your own
`codex login` — no cloud backend, codex runs read-only.

## Prerequisites

- **Zotero 9** (desktop). Verified on Zotero 9.0.4.
- **Codex CLI** (`@openai/codex`, ≥ 0.130), installed and logged in:
  ```bash
  npm install -g @openai/codex
  codex login
  ```
- **poppler / `pdftotext`** (the agent reads the PDF with it):
  - macOS: `brew install poppler`
  - Linux: `apt install poppler-utils`
  - Windows: `choco install poppler`

## Install

1. **Get `paper-reading-agent.xpi`** — download it from the
   [Releases](https://github.com/xiaoxuanli-a/zotero_agent_reader_plugin/releases) page,
   or build it yourself:
   ```bash
   npm install
   npm run build   # outputs .scaffold/build/paper-reading-agent.xpi
   ```
2. In Zotero: **Tools → Plugins → ⚙ (gear icon) → Install Plugin From File…** →
   pick `paper-reading-agent.xpi`, then **restart Zotero**.
3. **macOS (usually needed):** a GUI-launched Zotero doesn't inherit your shell
   `PATH`, so tell the plugin where `codex` is — **Settings → Advanced → Config
   Editor** → add a **String** pref
   `extensions.paper-reading-agent.codexPath` set to the output of `which codex`
   (e.g. `/opt/homebrew/bin/codex`).
4. Select an item that has a PDF (or open it in the reader). A **"Codex Chat"**
   section appears in the right-hand item pane; the banner should read
   `codex ready`. Ask a question.

## Usage

- Type a question and press **Enter** (Shift+Enter for a newline). The answer
  streams in, rendered as Markdown + math.
- When the agent states something from the paper it adds a **`[p.N]`** citation —
  **click it to jump the PDF reader to that page**.
- **Stop** cancels a running turn. Each paper keeps its own conversation
  (multi-turn memory), and you can switch between papers freely.

## Configuration

Set via **Settings → Advanced → Config Editor**
(`extensions.paper-reading-agent.…`):

| Pref              | Default           | Meaning                                                                                                                                                                     |
| ----------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codexPath`       | _(search PATH)_   | Absolute path to `codex` (set this if the banner says "codex not found").                                                                                                   |
| `model`           | _(codex config)_  | Override the codex model.                                                                                                                                                   |
| `reasoningEffort` | _(codex default)_ | `minimal` / `low` / `medium` / `high` — lower = faster, less deep. (`minimal` is incompatible with web search; when `webSearch` is on it is automatically raised to `low`.) |
| `timeoutSec`      | `600`             | Per-turn timeout.                                                                                                                                                           |
| `webSearch`       | `true`            | Set `false` to disable codex web search.                                                                                                                                    |

## Development

Built on [windingwind's `zotero-plugin-template`](https://github.com/windingwind/zotero-plugin-template)
(TypeScript + esbuild via `zotero-plugin-scaffold`):

```bash
npm install
npm start       # launch a dev Zotero with hot-reload
npm run build   # produce the .xpi
npm run release # version bump + GitHub release + update.json
```

## License

**AGPL-3.0-or-later** (see [`LICENSE`](LICENSE)). Bundled third-party libraries
(marked, KaTeX, DOMPurify) keep their own permissive licenses — see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

> **Note:** the codex `app-server` JSON-RPC protocol this plugin drives is marked
> _experimental_ by codex and pinned to **0.130.x** — a codex upgrade may change
> it and require an update here.
